from __future__ import annotations

import argparse
import hashlib
import json
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable

import joblib
import pandas as pd

from app.ml.data_schema import BOOKINGS_COL, NET_VALUE_COL, DataSchema, SEGMENT_COLUMNS, validate_dataframe
from app.ml.dr_estimator import (
    combine_dose_responses,
    estimate_dr_dose_response,
    estimate_naive_dose_response,
    fit_outcome,
    fit_propensity,
)
from app.ml.synth_data import generate_synthetic_data

DEFAULT_TREATMENT_LEVELS = (0, 5, 10, 15, 20)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _sha256_json(payload: Dict[str, Any]) -> str:
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


def _build_segment_payload(
    df: pd.DataFrame,
    treatment_levels: Iterable[int],
    propensity_model,
    outcome_models: Dict[str, Any],
) -> Dict[str, Any]:
    segmentations: Dict[str, Any] = {}
    for segment_by in SEGMENT_COLUMNS:
        naive_bookings = estimate_naive_dose_response(
            df=df,
            outcome_col=BOOKINGS_COL,
            segment_by=segment_by,
            treatment_levels=treatment_levels,
        )
        naive_net_value = estimate_naive_dose_response(
            df=df,
            outcome_col=NET_VALUE_COL,
            segment_by=segment_by,
            treatment_levels=treatment_levels,
        )

        dr_bookings = estimate_dr_dose_response(
            df=df,
            propensity_model=propensity_model,
            outcome_model=outcome_models["bookings"],
            outcome_col=BOOKINGS_COL,
            segment_by=segment_by,
            treatment_levels=treatment_levels,
        )
        dr_net_value = estimate_dr_dose_response(
            df=df,
            propensity_model=propensity_model,
            outcome_model=outcome_models["net_value"],
            outcome_col=NET_VALUE_COL,
            segment_by=segment_by,
            treatment_levels=treatment_levels,
        )

        combined_naive = combine_dose_responses(
            bookings_by_method={"naive": naive_bookings},
            net_value_by_method={"naive": naive_net_value},
        )["naive"]
        combined_dr = combine_dose_responses(
            bookings_by_method={"dr": dr_bookings},
            net_value_by_method={"dr": dr_net_value},
        )["dr"]

        segment_payload: Dict[str, Any] = {}
        for segment_value in combined_naive:
            segment_payload[segment_value] = {
                "naive": combined_naive[segment_value],
                "dr": combined_dr[segment_value],
            }
        segmentations[segment_by] = segment_payload

    return segmentations


def build_artifacts(
    artifact_dir: Path,
    rows: int,
    seed: int,
    treatment_levels: Iterable[int] = DEFAULT_TREATMENT_LEVELS,
    artifact_version: str | None = None,
) -> Dict[str, Any]:
    artifact_dir.mkdir(parents=True, exist_ok=True)
    treatment_levels = tuple(sorted(set(int(x) for x in treatment_levels)))
    if artifact_version is None:
        artifact_version = date.today().isoformat()

    df = generate_synthetic_data(n_rows=rows, seed=seed, treatment_levels=treatment_levels)
    validate_dataframe(df, DataSchema(treatment_levels=list(treatment_levels)))

    propensity_model = fit_propensity(df)
    outcome_models = {
        "bookings": fit_outcome(df, BOOKINGS_COL, seed=seed),
        "net_value": fit_outcome(df, NET_VALUE_COL, seed=seed + 1),
    }

    segmentations = _build_segment_payload(
        df=df,
        treatment_levels=treatment_levels,
        propensity_model=propensity_model,
        outcome_models=outcome_models,
    )

    dose_response_payload = {
        "artifact_version": artifact_version,
        "treatment_levels": list(treatment_levels),
        "baseline": {"name": "current_policy", "discount_pct": 10},
        "segmentations": segmentations,
    }

    baselines_payload = {
        "name": "current_policy",
        "discount_pct": 10,
    }

    dataset_path = artifact_dir / "demo.parquet"
    propensity_path = artifact_dir / "propensity_model.joblib"
    outcome_path = artifact_dir / "outcome_model.joblib"
    dose_response_path = artifact_dir / "dose_response.json"
    baseline_path = artifact_dir / "policy_baselines.json"

    df.to_parquet(dataset_path, index=False)
    joblib.dump(propensity_model, propensity_path)
    joblib.dump(outcome_models, outcome_path)
    dose_response_path.write_text(json.dumps(dose_response_payload, indent=2, sort_keys=True), encoding="utf-8")
    baseline_path.write_text(json.dumps(baselines_payload, indent=2, sort_keys=True), encoding="utf-8")

    reproducible_hash_payload = {
        "seed": seed,
        "rows": rows,
        "treatment_levels": list(treatment_levels),
        "dose_response": dose_response_payload,
    }
    artifact_hash = _sha256_json(reproducible_hash_payload)

    file_hashes = {
        "demo.parquet": _sha256_file(dataset_path),
        "propensity_model.joblib": _sha256_file(propensity_path),
        "outcome_model.joblib": _sha256_file(outcome_path),
        "dose_response.json": _sha256_file(dose_response_path),
        "policy_baselines.json": _sha256_file(baseline_path),
    }

    manifest = {
        "artifact_version": artifact_version,
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "seed": seed,
        "rows": rows,
        "treatment_levels": list(treatment_levels),
        "has_dr": True,
        "artifact_hash": artifact_hash,
        "file_hashes": file_hashes,
    }
    manifest_path = artifact_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")

    return manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train PromoPilot artifacts")
    parser.add_argument("--rows", type=int, default=60_000)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--artifact-version", type=str, default=None)
    parser.add_argument(
        "--artifact-dir",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "artifacts",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    manifest = build_artifacts(
        artifact_dir=args.artifact_dir,
        rows=args.rows,
        seed=args.seed,
        artifact_version=args.artifact_version,
    )
    print(json.dumps(manifest, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()

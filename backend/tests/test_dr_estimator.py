from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app.ml.data_schema import FEATURE_COLUMNS, SUCCESS_COL, TREATMENT_COL
from app.ml.dr_estimator import compute_dr_scores, estimate_dr_dose_response
from app.ml.train import build_artifacts


class UniformPropensityModel:
    classes_ = np.array([0, 1, 2])

    def predict_proba(self, features: pd.DataFrame) -> np.ndarray:
        return np.full((len(features), 3), 1.0 / 3.0)


class OracleOutcomeModel:
    def predict(self, features: pd.DataFrame) -> np.ndarray:
        policy_level = features[TREATMENT_COL].to_numpy(dtype=float)
        return 0.18 + 0.07 * policy_level


class _UnusedModel:
    pass


def _minimal_feature_frame(rows: int, seed: int = 4) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    return pd.DataFrame(
        {
            "device_tier": rng.choice(["entry", "mid"], size=rows),
            "prompt_risk": rng.choice(["low", "high"], size=rows),
            "task_domain": rng.choice(["assistant", "code"], size=rows),
            "region": rng.choice(["NA", "EU"], size=rows),
            "connectivity": rng.choice(["poor", "good"], size=rows),
            "prompt_tokens": rng.uniform(60, 520, size=rows),
            "battery_pct": rng.uniform(15, 95, size=rows),
            "thermal_headroom": rng.uniform(1, 19, size=rows),
            "model_size_b": rng.uniform(1.5, 11.5, size=rows),
        }
    )


def test_dr_reduces_to_outcome_when_uniform_propensity_with_oracle_model() -> None:
    df = _minimal_feature_frame(rows=240)
    rng = np.random.default_rng(19)
    treatment_levels = np.array([0, 1, 2])
    df[TREATMENT_COL] = rng.choice(treatment_levels, size=len(df), replace=True)

    outcome_model = OracleOutcomeModel()
    propensity_model = UniformPropensityModel()
    df[SUCCESS_COL] = outcome_model.predict(df[FEATURE_COLUMNS + [TREATMENT_COL]])

    dr_scores = compute_dr_scores(
        df=df,
        propensity_model=propensity_model,
        outcome_model=outcome_model,
        outcome_col=SUCCESS_COL,
        treatment_levels=treatment_levels,
    )

    for treatment in treatment_levels:
        expected = outcome_model.predict(df[FEATURE_COLUMNS].assign(**{TREATMENT_COL: treatment}))
        np.testing.assert_allclose(dr_scores[int(treatment)], expected, rtol=1e-10, atol=1e-10)


def test_dr_errors_when_segment_column_has_missing_values() -> None:
    df = _minimal_feature_frame(rows=30)
    df[TREATMENT_COL] = 1
    df[SUCCESS_COL] = 0.5
    df.loc[0, "prompt_risk"] = None

    with pytest.raises(ValueError, match="Segment column 'prompt_risk' contains null values"):
        estimate_dr_dose_response(
            df=df,
            propensity_model=_UnusedModel(),
            outcome_model=_UnusedModel(),
            outcome_col=SUCCESS_COL,
            segment_by="prompt_risk",
            treatment_levels=[0, 1, 2],
        )


def test_artifact_hash_is_deterministic_for_same_seed(tmp_path) -> None:
    manifest_a = build_artifacts(
        artifact_dir=tmp_path / "run_a",
        rows=3500,
        seed=23,
        treatment_levels=[0, 1, 2, 3, 4],
        artifact_version="test-version",
    )
    manifest_b = build_artifacts(
        artifact_dir=tmp_path / "run_b",
        rows=3500,
        seed=23,
        treatment_levels=[0, 1, 2, 3, 4],
        artifact_version="test-version",
    )

    assert manifest_a["artifact_hash"] == manifest_b["artifact_hash"]

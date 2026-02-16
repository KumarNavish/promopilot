from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from app.ml.data_schema import BOOKINGS_COL, FEATURE_COLUMNS, TREATMENT_COL
from app.ml.dr_estimator import compute_dr_scores, estimate_dr_dose_response
from app.ml.train import build_artifacts


class UniformPropensityModel:
    classes_ = np.array([0, 5, 10])

    def predict_proba(self, features: pd.DataFrame) -> np.ndarray:
        return np.full((len(features), 3), 1.0 / 3.0)


class OracleOutcomeModel:
    def predict(self, features: pd.DataFrame) -> np.ndarray:
        discount = features[TREATMENT_COL].to_numpy(dtype=float)
        return 0.20 + 0.015 * discount


class _UnusedModel:
    pass


def _minimal_feature_frame(rows: int, seed: int = 4) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    return pd.DataFrame(
        {
            "loyalty_tier": rng.choice(["G0", "G1"], size=rows),
            "device": rng.choice(["desktop", "mobile"], size=rows),
            "region": rng.choice(["NA", "EU"], size=rows),
            "price_sensitivity": rng.choice(["low", "high"], size=rows),
            "trip_type": rng.choice(["leisure", "business"], size=rows),
            "lead_time": rng.uniform(1, 60, size=rows),
            "base_price": rng.uniform(80, 240, size=rows),
            "nights": rng.integers(1, 5, size=rows),
            "search_intensity": rng.uniform(1, 8, size=rows),
        }
    )


def test_dr_reduces_to_outcome_when_uniform_propensity_with_oracle_model() -> None:
    df = _minimal_feature_frame(rows=240)
    rng = np.random.default_rng(19)
    treatment_levels = np.array([0, 5, 10])
    df[TREATMENT_COL] = rng.choice(treatment_levels, size=len(df), replace=True)

    outcome_model = OracleOutcomeModel()
    propensity_model = UniformPropensityModel()
    df[BOOKINGS_COL] = outcome_model.predict(df[FEATURE_COLUMNS + [TREATMENT_COL]])

    dr_scores = compute_dr_scores(
        df=df,
        propensity_model=propensity_model,
        outcome_model=outcome_model,
        outcome_col=BOOKINGS_COL,
        treatment_levels=treatment_levels,
    )

    for treatment in treatment_levels:
        expected = outcome_model.predict(df[FEATURE_COLUMNS].assign(**{TREATMENT_COL: treatment}))
        np.testing.assert_allclose(dr_scores[int(treatment)], expected, rtol=1e-10, atol=1e-10)


def test_dr_errors_when_segment_column_has_missing_values() -> None:
    df = _minimal_feature_frame(rows=30)
    df[TREATMENT_COL] = 5
    df[BOOKINGS_COL] = 0.3
    df.loc[0, "device"] = None

    with pytest.raises(ValueError, match="Segment column 'device' contains null values"):
        estimate_dr_dose_response(
            df=df,
            propensity_model=_UnusedModel(),
            outcome_model=_UnusedModel(),
            outcome_col=BOOKINGS_COL,
            segment_by="device",
            treatment_levels=[0, 5, 10],
        )


def test_artifact_hash_is_deterministic_for_same_seed(tmp_path) -> None:
    manifest_a = build_artifacts(
        artifact_dir=tmp_path / "run_a",
        rows=4000,
        seed=23,
        treatment_levels=[0, 5, 10, 15, 20],
        artifact_version="test-version",
    )
    manifest_b = build_artifacts(
        artifact_dir=tmp_path / "run_b",
        rows=4000,
        seed=23,
        treatment_levels=[0, 5, 10, 15, 20],
        artifact_version="test-version",
    )

    assert manifest_a["artifact_hash"] == manifest_b["artifact_hash"]

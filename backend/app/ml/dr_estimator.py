from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Dict, Iterable, Mapping

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

from app.ml.data_schema import (
    CATEGORICAL_FEATURES,
    FEATURE_COLUMNS,
    NUMERIC_FEATURES,
    SEGMENT_COLUMNS,
    TREATMENT_COL,
)


def _make_one_hot_encoder() -> OneHotEncoder:
    try:
        return OneHotEncoder(handle_unknown="ignore", sparse_output=False)
    except TypeError:
        # Backward compatibility for older scikit-learn builds.
        return OneHotEncoder(handle_unknown="ignore", sparse=False)


@dataclass(frozen=True)
class EstimatePoint:
    mean: float
    ci_low: float
    ci_high: float
    n: int

    def as_dict(self) -> Dict[str, float]:
        return asdict(self)


def _summarize(values: np.ndarray) -> EstimatePoint:
    if values.size == 0:
        raise ValueError("Cannot summarize an empty vector")
    mean = float(np.mean(values))
    if values.size == 1:
        return EstimatePoint(mean=mean, ci_low=mean, ci_high=mean, n=1)
    std = float(np.std(values, ddof=1))
    se = std / np.sqrt(values.size)
    margin = 1.96 * se
    return EstimatePoint(mean=mean, ci_low=mean - margin, ci_high=mean + margin, n=int(values.size))


def build_propensity_model() -> Pipeline:
    preprocessor = ColumnTransformer(
        transformers=[
            ("cat", _make_one_hot_encoder(), CATEGORICAL_FEATURES),
            ("num", StandardScaler(), NUMERIC_FEATURES),
        ]
    )
    model = LogisticRegression(
        multi_class="multinomial",
        max_iter=450,
        solver="lbfgs",
    )
    return Pipeline(
        steps=[
            ("preprocessor", preprocessor),
            ("model", model),
        ]
    )


def build_outcome_model(seed: int) -> Pipeline:
    preprocessor = ColumnTransformer(
        transformers=[
            ("cat", _make_one_hot_encoder(), CATEGORICAL_FEATURES + [TREATMENT_COL]),
            ("num", StandardScaler(), NUMERIC_FEATURES),
        ]
    )
    model = HistGradientBoostingRegressor(
        learning_rate=0.07,
        max_depth=6,
        max_iter=220,
        min_samples_leaf=64,
        l2_regularization=0.02,
        random_state=seed,
    )
    return Pipeline(
        steps=[
            ("preprocessor", preprocessor),
            ("model", model),
        ]
    )


def fit_propensity(df: pd.DataFrame) -> Pipeline:
    propensity_model = build_propensity_model()
    propensity_model.fit(df[FEATURE_COLUMNS], df[TREATMENT_COL])
    return propensity_model


def fit_outcome(df: pd.DataFrame, outcome_col: str, seed: int) -> Pipeline:
    outcome_model = build_outcome_model(seed=seed)
    outcome_model.fit(df[FEATURE_COLUMNS + [TREATMENT_COL]], df[outcome_col])
    return outcome_model


def _predict_mu_for_treatment(
    outcome_model: Pipeline,
    feature_df: pd.DataFrame,
    treatment_value: int,
) -> np.ndarray:
    augmented = feature_df.copy()
    augmented[TREATMENT_COL] = treatment_value
    return outcome_model.predict(augmented)


def compute_dr_scores(
    df: pd.DataFrame,
    propensity_model: Pipeline,
    outcome_model: Pipeline,
    outcome_col: str,
    treatment_levels: Iterable[int],
    min_propensity: float = 0.02,
) -> Dict[int, np.ndarray]:
    feature_df = df[FEATURE_COLUMNS]
    treatment_series = df[TREATMENT_COL].to_numpy(dtype=int)
    outcome = df[outcome_col].to_numpy(dtype=float)

    propensity = propensity_model.predict_proba(feature_df)
    class_to_index = {int(cls): idx for idx, cls in enumerate(propensity_model.classes_)}

    scores_by_treatment: Dict[int, np.ndarray] = {}
    for treatment in sorted(set(int(t) for t in treatment_levels)):
        if treatment not in class_to_index:
            raise ValueError(f"Propensity model has no class for treatment {treatment}")

        class_idx = class_to_index[treatment]
        p_t = np.clip(propensity[:, class_idx], min_propensity, 1.0)
        mu_t = _predict_mu_for_treatment(outcome_model, feature_df, treatment)
        is_treatment = (treatment_series == treatment).astype(float)
        pseudo = mu_t + (is_treatment / p_t) * (outcome - mu_t)
        scores_by_treatment[treatment] = pseudo.astype(float)

    return scores_by_treatment


def _segment_masks(df: pd.DataFrame, segment_by: str) -> Dict[str, np.ndarray]:
    if segment_by not in SEGMENT_COLUMNS:
        raise ValueError(f"Unsupported segment_by value: {segment_by}")
    if segment_by == "none":
        return {"all": np.ones(len(df), dtype=bool)}

    segment_col = SEGMENT_COLUMNS[segment_by]
    segment_values = df[segment_col]
    if segment_values.isna().any():
        raise ValueError(f"Segment column '{segment_col}' contains null values")

    masks: Dict[str, np.ndarray] = {}
    for value in sorted(segment_values.astype(str).unique()):
        masks[value] = (segment_values.astype(str) == value).to_numpy()
    return masks


def estimate_dr_dose_response(
    df: pd.DataFrame,
    propensity_model: Pipeline,
    outcome_model: Pipeline,
    outcome_col: str,
    segment_by: str,
    treatment_levels: Iterable[int],
) -> Dict[str, Dict[int, Dict[str, float]]]:
    masks = _segment_masks(df, segment_by)
    dr_scores = compute_dr_scores(
        df=df,
        propensity_model=propensity_model,
        outcome_model=outcome_model,
        outcome_col=outcome_col,
        treatment_levels=treatment_levels,
    )

    response: Dict[str, Dict[int, Dict[str, float]]] = {}
    for segment_value, mask in masks.items():
        per_treatment: Dict[int, Dict[str, float]] = {}
        for treatment, score in dr_scores.items():
            summary = _summarize(score[mask])
            per_treatment[treatment] = summary.as_dict()
        response[segment_value] = per_treatment
    return response


def estimate_naive_dose_response(
    df: pd.DataFrame,
    outcome_col: str,
    segment_by: str,
    treatment_levels: Iterable[int],
) -> Dict[str, Dict[int, Dict[str, float]]]:
    masks = _segment_masks(df, segment_by)
    all_treatments = sorted(set(int(t) for t in treatment_levels))

    global_by_treatment = {
        treatment: df.loc[df[TREATMENT_COL] == treatment, outcome_col].to_numpy(dtype=float)
        for treatment in all_treatments
    }

    response: Dict[str, Dict[int, Dict[str, float]]] = {}
    for segment_value, mask in masks.items():
        segment_df = df.loc[mask]
        per_treatment: Dict[int, Dict[str, float]] = {}
        for treatment in all_treatments:
            observed = segment_df.loc[segment_df[TREATMENT_COL] == treatment, outcome_col].to_numpy(dtype=float)
            values = observed if observed.size > 0 else global_by_treatment[treatment]
            if values.size == 0:
                raise ValueError(
                    f"No observed rows for treatment {treatment}; cannot compute naive estimate"
                )
            summary = _summarize(values)
            per_treatment[treatment] = summary.as_dict()
        response[segment_value] = per_treatment

    return response


def combine_dose_responses(
    bookings_by_method: Mapping[str, Dict[str, Dict[int, Dict[str, float]]]],
    net_value_by_method: Mapping[str, Dict[str, Dict[int, Dict[str, float]]]],
) -> Dict[str, Dict[str, Dict[int, Dict[str, Dict[str, float]]]]]:
    response: Dict[str, Dict[str, Dict[int, Dict[str, Dict[str, float]]]]] = {}
    for method, booking_segments in bookings_by_method.items():
        response[method] = {}
        for segment_value, booking_treatments in booking_segments.items():
            response[method][segment_value] = {}
            for treatment, booking_summary in booking_treatments.items():
                response[method][segment_value][treatment] = {
                    "bookings": booking_summary,
                    "net_value": net_value_by_method[method][segment_value][treatment],
                }
    return response

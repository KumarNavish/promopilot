from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List

import pandas as pd

TREATMENT_COL = "policy_level"
SUCCESS_COL = "task_success"
SAFE_VALUE_COL = "safe_value"
INCIDENT_COL = "safety_incident"
LATENCY_COL = "latency_ms"

CATEGORICAL_FEATURES: List[str] = [
    "device_tier",
    "prompt_risk",
    "task_domain",
    "region",
    "connectivity",
]

NUMERIC_FEATURES: List[str] = [
    "prompt_tokens",
    "battery_pct",
    "thermal_headroom",
    "model_size_b",
]

FEATURE_COLUMNS: List[str] = CATEGORICAL_FEATURES + NUMERIC_FEATURES

SEGMENT_COLUMNS: Dict[str, str] = {
    "none": "__all__",
    "device_tier": "device_tier",
    "prompt_risk": "prompt_risk",
    "task_domain": "task_domain",
}

SEGMENT_LABEL_PREFIX: Dict[str, str] = {
    "none": "All",
    "device_tier": "Device",
    "prompt_risk": "Risk",
    "task_domain": "Domain",
}


@dataclass(frozen=True)
class DataSchema:
    treatment_levels: List[int]


REQUIRED_COLUMNS = set(
    FEATURE_COLUMNS + [TREATMENT_COL, SUCCESS_COL, SAFE_VALUE_COL, INCIDENT_COL, LATENCY_COL]
)


def validate_dataframe(df: pd.DataFrame, schema: DataSchema) -> None:
    missing_cols = REQUIRED_COLUMNS - set(df.columns)
    if missing_cols:
        raise ValueError(f"Dataset is missing required columns: {sorted(missing_cols)}")

    unexpected_treatments = sorted(set(df[TREATMENT_COL].unique()) - set(schema.treatment_levels))
    if unexpected_treatments:
        raise ValueError(
            "Dataset contains treatment levels outside configured levels: "
            f"{unexpected_treatments}"
        )

    for segment_name, col in SEGMENT_COLUMNS.items():
        if segment_name == "none":
            continue
        if df[col].isna().any():
            raise ValueError(f"Segment column '{col}' contains null values")


def make_segment_label(segment_by: str, segment_value: str) -> str:
    if segment_by == "none":
        return "All traffic"
    prefix = SEGMENT_LABEL_PREFIX.get(segment_by, segment_by)
    return f"{prefix}={segment_value}"

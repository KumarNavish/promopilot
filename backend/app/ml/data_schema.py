from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List

import pandas as pd

TREATMENT_COL = "discount_pct"
BOOKINGS_COL = "booked"
NET_VALUE_COL = "net_value"

CATEGORICAL_FEATURES: List[str] = [
    "loyalty_tier",
    "device",
    "region",
    "price_sensitivity",
    "trip_type",
]

NUMERIC_FEATURES: List[str] = [
    "lead_time",
    "base_price",
    "nights",
    "search_intensity",
]

FEATURE_COLUMNS: List[str] = CATEGORICAL_FEATURES + NUMERIC_FEATURES

SEGMENT_COLUMNS: Dict[str, str] = {
    "none": "__all__",
    "loyalty_tier": "loyalty_tier",
    "price_sensitivity": "price_sensitivity",
    "device": "device",
}

SEGMENT_LABEL_PREFIX: Dict[str, str] = {
    "none": "All",
    "loyalty_tier": "Loyalty",
    "price_sensitivity": "Sensitivity",
    "device": "Device",
}


@dataclass(frozen=True)
class DataSchema:
    treatment_levels: List[int]


REQUIRED_COLUMNS = set(FEATURE_COLUMNS + [TREATMENT_COL, BOOKINGS_COL, NET_VALUE_COL])


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
        return "All users"
    prefix = SEGMENT_LABEL_PREFIX.get(segment_by, segment_by)
    return f"{prefix}={segment_value}"

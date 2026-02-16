from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, Field, field_validator

ALLOWED_DISCOUNTS = (0, 5, 10, 15, 20)


class RecommendRequest(BaseModel):
    objective: Literal["bookings", "net_value"]
    max_discount_pct: int = Field(..., ge=0, le=100)
    segment_by: Literal["none", "loyalty_tier", "price_sensitivity", "device"]
    method: Literal["naive", "dr"]

    @field_validator("max_discount_pct")
    @classmethod
    def validate_discount(cls, value: int) -> int:
        if value not in ALLOWED_DISCOUNTS:
            raise ValueError(
                "max_discount_pct must match an allowed treatment level: "
                f"{list(ALLOWED_DISCOUNTS)}"
            )
        return value


class DeltaVsBaseline(BaseModel):
    bookings_per_10k: float
    net_value_per_10k: float
    avg_discount_pct: float


class SegmentRecommendation(BaseModel):
    segment: str
    recommended_discount_pct: int
    expected_bookings_per_10k: float
    expected_net_value_per_10k: float
    delta_vs_baseline: DeltaVsBaseline


class DoseResponsePoint(BaseModel):
    discount_pct: int
    bookings_per_10k: float
    net_value_per_10k: float
    ci_low: float
    ci_high: float


class SegmentDoseResponse(BaseModel):
    segment: str
    points: List[DoseResponsePoint]


class BaselineInfo(BaseModel):
    name: str
    discount_pct: int


class RecommendResponse(BaseModel):
    artifact_version: str
    method_used: Literal["naive", "dr"]
    segments: List[SegmentRecommendation]
    dose_response: List[SegmentDoseResponse]
    baseline: BaselineInfo
    warnings: List[str] = Field(default_factory=list)
    request_id: Optional[str] = None


class MetadataResponse(BaseModel):
    artifact_version: str
    objectives: List[str]
    discount_levels: List[int]
    segmentations: List[str]
    has_dr: bool

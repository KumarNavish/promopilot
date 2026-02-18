from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, Field, field_validator

ALLOWED_POLICY_LEVELS = (0, 1, 2, 3, 4)


class RecommendRequest(BaseModel):
    objective: Literal["task_success", "safe_value"]
    max_policy_level: int = Field(..., ge=0, le=10)
    segment_by: Literal["none", "device_tier", "prompt_risk", "task_domain"]
    method: Literal["naive", "dr"]

    @field_validator("max_policy_level")
    @classmethod
    def validate_policy_level(cls, value: int) -> int:
        if value not in ALLOWED_POLICY_LEVELS:
            raise ValueError(
                "max_policy_level must match an allowed treatment level: "
                f"{list(ALLOWED_POLICY_LEVELS)}"
            )
        return value


class DeltaVsBaseline(BaseModel):
    successes_per_10k: float
    safe_value_per_10k: float
    incidents_per_10k: float
    latency_ms: float
    avg_policy_level: float


class SegmentRecommendation(BaseModel):
    segment: str
    recommended_policy_level: int
    expected_successes_per_10k: float
    expected_safe_value_per_10k: float
    expected_incidents_per_10k: float
    expected_latency_ms: float
    delta_vs_baseline: DeltaVsBaseline


class DoseResponsePoint(BaseModel):
    policy_level: int
    successes_per_10k: float
    safe_value_per_10k: float
    incidents_per_10k: float
    latency_ms: float
    ci_low: float
    ci_high: float


class SegmentDoseResponse(BaseModel):
    segment: str
    points: List[DoseResponsePoint]


class BaselineInfo(BaseModel):
    name: str
    policy_level: int


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
    policy_levels: List[int]
    segmentations: List[str]
    has_dr: bool

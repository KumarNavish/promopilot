from __future__ import annotations

import json
from typing import Any, Dict

from fastapi import APIRouter, HTTPException, Request

from app.api.schemas import MetadataResponse, RecommendRequest, RecommendResponse
from app.core.cache import artifact_cache, response_cache
from app.core.config import get_settings
from app.ml.policy import recommend_policy

router = APIRouter()


def _get_artifacts() -> Any:
    settings = get_settings()
    try:
        return artifact_cache.get(settings.artifact_dir)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/healthz")
def healthz() -> Dict[str, str]:
    return {"status": "ok"}


@router.get("/api/v1/metadata", response_model=MetadataResponse)
def metadata() -> MetadataResponse:
    settings = get_settings()
    artifacts = _get_artifacts()

    return MetadataResponse(
        artifact_version=str(artifacts.manifest.get("artifact_version", "unknown")),
        objectives=list(settings.objectives),
        discount_levels=list(settings.treatment_levels),
        segmentations=list(settings.segmentations),
        has_dr=artifacts.has_dr,
    )


@router.post("/api/v1/recommend", response_model=RecommendResponse)
def recommend(payload: RecommendRequest, request: Request) -> RecommendResponse:
    artifacts = _get_artifacts()

    requested_method = payload.method
    method_used = requested_method
    warnings = []

    if requested_method == "dr" and not artifacts.has_dr:
        method_used = "naive"
        warnings.append("DR artifacts unavailable; falling back to naive policy")

    cache_key = json.dumps(
        {
            "objective": payload.objective,
            "max_discount_pct": payload.max_discount_pct,
            "segment_by": payload.segment_by,
            "method": method_used,
            "artifact_hash": artifacts.manifest.get("artifact_hash", "unknown"),
        },
        sort_keys=True,
    )

    cached = response_cache.get(cache_key)
    if cached is None:
        try:
            recommendation = recommend_policy(
                dose_response=artifacts.dose_response,
                objective=payload.objective,
                max_discount_pct=payload.max_discount_pct,
                segment_by=payload.segment_by,
                method=method_used,
            )
        except ValueError as exc:
            if requested_method == "dr":
                # If DR slice is missing in artifacts, fail safely to naive.
                method_used = "naive"
                warnings.append("DR policy unavailable for this slice; returning naive policy")
                recommendation = recommend_policy(
                    dose_response=artifacts.dose_response,
                    objective=payload.objective,
                    max_discount_pct=payload.max_discount_pct,
                    segment_by=payload.segment_by,
                    method=method_used,
                )
            else:
                raise HTTPException(status_code=422, detail=str(exc)) from exc

        cached = {
            "artifact_version": str(artifacts.manifest.get("artifact_version", "unknown")),
            "method_used": method_used,
            "segments": recommendation["segments"],
            "dose_response": recommendation["dose_response"],
            "baseline": recommendation["baseline"],
            "warnings": warnings,
        }
        response_cache.set(cache_key, cached)

    merged_warnings = list(cached.get("warnings", []))
    for warning in warnings:
        if warning not in merged_warnings:
            merged_warnings.append(warning)

    return RecommendResponse(
        artifact_version=str(cached["artifact_version"]),
        method_used=str(cached["method_used"]),
        segments=list(cached["segments"]),
        dose_response=list(cached["dose_response"]),
        baseline=cached["baseline"],
        warnings=merged_warnings,
        request_id=getattr(request.state, "request_id", None),
    )

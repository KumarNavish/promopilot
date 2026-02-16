from __future__ import annotations

import time

from fastapi.testclient import TestClient

from app.core.cache import artifact_cache, response_cache
from app.core.config import get_settings
from app.main import create_app
from app.ml.train import build_artifacts


def _build_test_client(tmp_path) -> TestClient:
    artifact_dir = tmp_path / "artifacts"
    build_artifacts(
        artifact_dir=artifact_dir,
        rows=12000,
        seed=9,
        artifact_version="test-api",
    )

    import os

    os.environ["ARTIFACT_DIR"] = str(artifact_dir)
    os.environ["APP_ENV"] = "dev"

    get_settings.cache_clear()
    artifact_cache.clear()
    response_cache.clear()

    app = create_app()
    return TestClient(app)


def test_schema_validation_rejects_invalid_fields(tmp_path) -> None:
    client = _build_test_client(tmp_path)

    invalid_objective = {
        "objective": "revenue",
        "max_discount_pct": 10,
        "segment_by": "none",
        "method": "dr",
    }
    invalid_segment = {
        "objective": "bookings",
        "max_discount_pct": 10,
        "segment_by": "region",
        "method": "dr",
    }

    resp_objective = client.post("/api/v1/recommend", json=invalid_objective)
    resp_segment = client.post("/api/v1/recommend", json=invalid_segment)

    assert resp_objective.status_code == 422
    assert resp_segment.status_code == 422


def test_recommendation_latency_with_precomputed_artifacts(tmp_path) -> None:
    client = _build_test_client(tmp_path)

    payload = {
        "objective": "net_value",
        "max_discount_pct": 15,
        "segment_by": "loyalty_tier",
        "method": "dr",
    }

    start = time.perf_counter()
    response = client.post("/api/v1/recommend", json=payload)
    elapsed_seconds = time.perf_counter() - start

    assert response.status_code == 200
    assert elapsed_seconds < 0.30, f"Soft latency budget exceeded: {elapsed_seconds:.3f}s"

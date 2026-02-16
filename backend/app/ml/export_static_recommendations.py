from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, Iterable

from app.ml.policy import recommend_policy

OBJECTIVES = ("bookings", "net_value")
SEGMENTATIONS = ("none", "loyalty_tier", "price_sensitivity", "device")
METHODS = ("naive", "dr")


def _key(objective: str, max_discount_pct: int, segment_by: str, method: str) -> str:
    return f"{objective}|{max_discount_pct}|{segment_by}|{method}"


def build_static_bundle(
    dose_response_payload: Dict,
    max_discount_levels: Iterable[int],
) -> Dict:
    artifact_version = str(dose_response_payload.get("artifact_version", "unknown"))
    bundle: Dict[str, Dict] = {}

    for objective in OBJECTIVES:
        for max_discount in max_discount_levels:
            for segment_by in SEGMENTATIONS:
                for method in METHODS:
                    recommendation = recommend_policy(
                        dose_response=dose_response_payload,
                        objective=objective,
                        max_discount_pct=int(max_discount),
                        segment_by=segment_by,
                        method=method,
                    )
                    bundle[_key(objective, int(max_discount), segment_by, method)] = {
                        "artifact_version": artifact_version,
                        "method_used": method,
                        "segments": recommendation["segments"],
                        "dose_response": recommendation["dose_response"],
                        "baseline": recommendation["baseline"],
                        "warnings": [],
                    }

    return {
        "artifact_version": artifact_version,
        "treatment_levels": list(max_discount_levels),
        "recommendations": bundle,
    }


def main() -> None:
    backend_root = Path(__file__).resolve().parents[2]
    repo_root = backend_root.parent
    dose_response_path = backend_root / "app" / "artifacts" / "dose_response.json"
    frontend_output = repo_root / "frontend" / "public" / "mock" / "recommendations.json"

    payload = json.loads(dose_response_path.read_text(encoding="utf-8"))
    levels = [int(level) for level in payload["treatment_levels"]]
    bundle = build_static_bundle(payload, levels)

    frontend_output.parent.mkdir(parents=True, exist_ok=True)
    frontend_output.write_text(json.dumps(bundle, indent=2, sort_keys=True), encoding="utf-8")
    print(str(frontend_output))


if __name__ == "__main__":
    main()

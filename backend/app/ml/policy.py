from __future__ import annotations

from typing import Any, Dict, Iterable, List, Tuple

from app.ml.data_schema import make_segment_label

SCALE_PER_10K = 10_000.0


def _as_int_keyed_map(raw: Dict[str, Any]) -> Dict[int, Dict[str, Dict[str, float]]]:
    return {int(k): v for k, v in raw.items()}


def _to_per_10k(value: float) -> float:
    return value * SCALE_PER_10K


def _objective_score(summary: Dict[str, Dict[str, float]], objective: str) -> float:
    return float(summary[objective]["mean"])


def _sorted_segments(segment_by: str, segment_map: Dict[str, Any]) -> Iterable[Tuple[str, Any]]:
    if segment_by == "none":
        return [("all", segment_map["all"])]
    return sorted(segment_map.items(), key=lambda item: str(item[0]))


def recommend_policy(
    dose_response: Dict[str, Any],
    objective: str,
    max_policy_level: int,
    segment_by: str,
    method: str,
) -> Dict[str, Any]:
    treatment_levels = [int(t) for t in dose_response["treatment_levels"]]
    candidate_treatments = [t for t in treatment_levels if t <= max_policy_level]
    if not candidate_treatments:
        raise ValueError(
            f"No policy levels are <= {max_policy_level}. Available levels: {treatment_levels}"
        )

    baseline_info = dose_response.get("baseline", {"name": "current_policy", "policy_level": 2})
    baseline_level = int(baseline_info.get("policy_level", 2))
    if baseline_level not in treatment_levels:
        baseline_level = min(treatment_levels, key=lambda t: abs(t - baseline_level))

    segmentations = dose_response.get("segmentations", {})
    if segment_by not in segmentations:
        raise ValueError(f"Unsupported segment_by '{segment_by}' in artifacts")

    segmentation_payload = segmentations[segment_by]

    segments: List[Dict[str, Any]] = []
    chart_payload: List[Dict[str, Any]] = []

    for segment_value, segment_entry in _sorted_segments(segment_by, segmentation_payload):
        method_payload = segment_entry.get(method)
        if method_payload is None:
            raise ValueError(f"Method '{method}' missing in artifact for segment {segment_value}")

        treatment_map = _as_int_keyed_map(method_payload)
        scored = [(t, _objective_score(treatment_map[t], objective)) for t in candidate_treatments]
        recommended_level, _ = max(scored, key=lambda pair: pair[1])

        rec_summary = treatment_map[recommended_level]
        baseline_summary = treatment_map[baseline_level]

        segment_label = make_segment_label(segment_by, str(segment_value))
        segments.append(
            {
                "segment": segment_label,
                "recommended_policy_level": int(recommended_level),
                "expected_successes_per_10k": round(_to_per_10k(rec_summary["task_success"]["mean"]), 2),
                "expected_safe_value_per_10k": round(_to_per_10k(rec_summary["safe_value"]["mean"]), 2),
                "expected_incidents_per_10k": round(_to_per_10k(rec_summary["safety_incident"]["mean"]), 2),
                "expected_latency_ms": round(float(rec_summary["latency_ms"]["mean"]), 2),
                "delta_vs_baseline": {
                    "successes_per_10k": round(
                        _to_per_10k(rec_summary["task_success"]["mean"] - baseline_summary["task_success"]["mean"]),
                        2,
                    ),
                    "safe_value_per_10k": round(
                        _to_per_10k(rec_summary["safe_value"]["mean"] - baseline_summary["safe_value"]["mean"]),
                        2,
                    ),
                    "incidents_per_10k": round(
                        _to_per_10k(rec_summary["safety_incident"]["mean"] - baseline_summary["safety_incident"]["mean"]),
                        2,
                    ),
                    "latency_ms": round(
                        float(rec_summary["latency_ms"]["mean"] - baseline_summary["latency_ms"]["mean"]),
                        2,
                    ),
                    "avg_policy_level": round(float(recommended_level - baseline_level), 2),
                },
            }
        )

        points: List[Dict[str, Any]] = []
        for treatment in treatment_levels:
            treatment_summary = treatment_map[treatment]
            objective_ci = treatment_summary[objective]

            if objective in {"task_success", "safe_value", "safety_incident"}:
                ci_low = _to_per_10k(objective_ci["ci_low"])
                ci_high = _to_per_10k(objective_ci["ci_high"])
            else:
                ci_low = float(objective_ci["ci_low"])
                ci_high = float(objective_ci["ci_high"])

            points.append(
                {
                    "policy_level": int(treatment),
                    "successes_per_10k": round(_to_per_10k(treatment_summary["task_success"]["mean"]), 2),
                    "safe_value_per_10k": round(_to_per_10k(treatment_summary["safe_value"]["mean"]), 2),
                    "incidents_per_10k": round(_to_per_10k(treatment_summary["safety_incident"]["mean"]), 2),
                    "latency_ms": round(float(treatment_summary["latency_ms"]["mean"]), 2),
                    "ci_low": round(ci_low, 2),
                    "ci_high": round(ci_high, 2),
                }
            )

        chart_payload.append({"segment": segment_label, "points": points})

    return {
        "segments": segments,
        "dose_response": chart_payload,
        "baseline": {
            "name": str(baseline_info.get("name", "current_policy")),
            "policy_level": int(baseline_level),
        },
    }

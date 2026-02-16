from __future__ import annotations

from typing import Any, Dict, Iterable, List, Tuple

from app.ml.data_schema import make_segment_label

SCALE_PER_10K = 10_000.0


def _as_int_keyed_map(raw: Dict[str, Any]) -> Dict[int, Dict[str, Dict[str, float]]]:
    return {int(k): v for k, v in raw.items()}


def _score_for_objective(summary: Dict[str, Dict[str, float]], objective: str) -> float:
    return float(summary[objective]["mean"])


def _to_per_10k(value: float) -> float:
    return value * SCALE_PER_10K


def _sorted_segments(segment_by: str, segment_map: Dict[str, Any]) -> Iterable[Tuple[str, Any]]:
    if segment_by == "none":
        return [("all", segment_map["all"])]
    return sorted(segment_map.items(), key=lambda item: str(item[0]))


def recommend_policy(
    dose_response: Dict[str, Any],
    objective: str,
    max_discount_pct: int,
    segment_by: str,
    method: str,
) -> Dict[str, Any]:
    treatment_levels = [int(t) for t in dose_response["treatment_levels"]]
    candidate_treatments = [t for t in treatment_levels if t <= max_discount_pct]
    if not candidate_treatments:
        raise ValueError(
            f"No treatment levels are <= {max_discount_pct}. Available levels: {treatment_levels}"
        )

    baseline_info = dose_response.get("baseline", {"name": "current_policy", "discount_pct": 10})
    baseline_discount = int(baseline_info.get("discount_pct", 10))
    if baseline_discount not in treatment_levels:
        baseline_discount = min(treatment_levels, key=lambda t: abs(t - baseline_discount))

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
        scored = [
            (
                t,
                _score_for_objective(treatment_map[t], objective),
            )
            for t in candidate_treatments
        ]
        recommended_discount, _ = max(scored, key=lambda pair: pair[1])

        rec_summary = treatment_map[recommended_discount]
        baseline_summary = treatment_map[baseline_discount]

        segment_label = make_segment_label(segment_by, str(segment_value))
        segments.append(
            {
                "segment": segment_label,
                "recommended_discount_pct": int(recommended_discount),
                "expected_bookings_per_10k": round(_to_per_10k(rec_summary["bookings"]["mean"]), 2),
                "expected_net_value_per_10k": round(_to_per_10k(rec_summary["net_value"]["mean"]), 2),
                "delta_vs_baseline": {
                    "bookings_per_10k": round(
                        _to_per_10k(rec_summary["bookings"]["mean"] - baseline_summary["bookings"]["mean"]),
                        2,
                    ),
                    "net_value_per_10k": round(
                        _to_per_10k(rec_summary["net_value"]["mean"] - baseline_summary["net_value"]["mean"]),
                        2,
                    ),
                    "avg_discount_pct": round(float(recommended_discount - baseline_discount), 2),
                },
            }
        )

        points: List[Dict[str, Any]] = []
        for treatment in treatment_levels:
            treatment_summary = treatment_map[treatment]
            objective_ci = treatment_summary[objective]
            points.append(
                {
                    "discount_pct": int(treatment),
                    "bookings_per_10k": round(
                        _to_per_10k(treatment_summary["bookings"]["mean"]),
                        2,
                    ),
                    "net_value_per_10k": round(
                        _to_per_10k(treatment_summary["net_value"]["mean"]),
                        2,
                    ),
                    "ci_low": round(_to_per_10k(objective_ci["ci_low"]), 2),
                    "ci_high": round(_to_per_10k(objective_ci["ci_high"]), 2),
                }
            )

        chart_payload.append(
            {
                "segment": segment_label,
                "points": points,
            }
        )

    return {
        "segments": segments,
        "dose_response": chart_payload,
        "baseline": {
            "name": str(baseline_info.get("name", "current_policy")),
            "discount_pct": int(baseline_discount),
        },
    }

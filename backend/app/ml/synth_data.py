from __future__ import annotations

from typing import Iterable

import numpy as np
import pandas as pd

from app.ml.data_schema import (
    INCIDENT_COL,
    LATENCY_COL,
    SAFE_VALUE_COL,
    SUCCESS_COL,
    TREATMENT_COL,
)


def _softmax(logits: np.ndarray) -> np.ndarray:
    stabilized = logits - logits.max(axis=1, keepdims=True)
    exp_logits = np.exp(stabilized)
    return exp_logits / exp_logits.sum(axis=1, keepdims=True)


def _sigmoid(values: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-values))


def generate_synthetic_data(
    n_rows: int = 65_000,
    seed: int = 17,
    treatment_levels: Iterable[int] = (0, 1, 2, 3, 4),
) -> pd.DataFrame:
    """Generate confounded on-device policy logs for a guardrail optimization demo."""

    rng = np.random.default_rng(seed)
    levels = np.array(sorted(set(int(x) for x in treatment_levels)), dtype=int)
    if levels.size < 2:
        raise ValueError("At least two treatment levels are required")

    device_tier = rng.choice(["entry", "mid", "premium"], size=n_rows, p=[0.33, 0.46, 0.21])
    prompt_risk = rng.choice(["low", "medium", "high"], size=n_rows, p=[0.53, 0.32, 0.15])
    task_domain = rng.choice(["assistant", "code", "support"], size=n_rows, p=[0.45, 0.26, 0.29])
    region = rng.choice(["NA", "EU", "APAC", "LATAM"], size=n_rows, p=[0.31, 0.26, 0.28, 0.15])
    connectivity = rng.choice(["offline", "poor", "good"], size=n_rows, p=[0.22, 0.31, 0.47])

    prompt_tokens = np.clip(rng.lognormal(mean=5.5, sigma=0.42, size=n_rows), 40, 1150)
    battery_pct = rng.uniform(8, 100, size=n_rows)
    thermal_headroom = np.clip(rng.normal(loc=10.5, scale=4.2, size=n_rows), 0.8, 24)

    model_size_b = np.select(
        [device_tier == "entry", device_tier == "mid", device_tier == "premium"],
        [rng.normal(2.1, 0.3, size=n_rows), rng.normal(6.9, 0.6, size=n_rows), rng.normal(12.4, 0.8, size=n_rows)],
    )
    model_size_b = np.clip(model_size_b, 1.1, 15.0)

    device_score = pd.Series(device_tier).map({"entry": -0.28, "mid": 0.0, "premium": 0.24}).to_numpy()
    risk_score = pd.Series(prompt_risk).map({"low": -0.78, "medium": 0.0, "high": 1.02}).to_numpy()
    domain_score = pd.Series(task_domain).map({"assistant": 0.05, "code": 0.16, "support": -0.04}).to_numpy()
    conn_score = pd.Series(connectivity).map({"offline": -0.22, "poor": -0.08, "good": 0.08}).to_numpy()
    region_score = pd.Series(region).map({"NA": 0.08, "EU": 0.05, "APAC": 0.0, "LATAM": -0.07}).to_numpy()

    latent_risk_need = (
        0.78 * risk_score
        + 0.20 * (prompt_tokens > np.quantile(prompt_tokens, 0.72)).astype(float)
        + 0.12 * (battery_pct < 32).astype(float)
        + 0.10 * (connectivity != "good").astype(float)
        - 0.08 * device_score
        + rng.normal(0, 0.25, size=n_rows)
    )

    logits = np.zeros((n_rows, levels.size), dtype=float)
    max_level = max(int(levels.max()), 1)
    normalized_levels = levels / max_level
    for idx, level in enumerate(normalized_levels):
        logits[:, idx] = (
            -0.42 * np.square(level - 0.52)
            + 1.15 * level * latent_risk_need
            + 0.36 * level * (device_tier == "entry").astype(float)
            + 0.25 * level * (task_domain == "support").astype(float)
            + 0.22 * level * (battery_pct < 28).astype(float)
            - 0.22 * level * (prompt_risk == "low").astype(float)
        )

    assignment_prob = _softmax(logits)
    sampled_idx = np.array(
        [rng.choice(levels.size, p=assignment_prob[row_idx]) for row_idx in range(n_rows)],
        dtype=int,
    )
    policy_level = levels[sampled_idx]

    risk_weight = pd.Series(prompt_risk).map({"low": 0.24, "medium": 0.72, "high": 1.32}).to_numpy()
    strictness = policy_level.astype(float)

    safety_gain = 0.86 * (1.0 - np.exp(-strictness / 1.35)) * risk_weight
    overblock_penalty = 0.48 * np.power(strictness / 4.0, 1.35) * np.clip(1.12 - risk_weight, 0.18, 1.2)

    base_success_logit = (
        -0.56
        + 0.55 * device_score
        + 0.18 * domain_score
        + 0.09 * conn_score
        + 0.06 * region_score
        - 0.0007 * (prompt_tokens - 250)
        + 0.007 * thermal_headroom
        + 0.004 * (battery_pct - 50)
        + rng.normal(0, 0.24, size=n_rows)
    )

    success_prob = _sigmoid(base_success_logit + safety_gain - overblock_penalty)
    success_prob = np.clip(success_prob, 0.03, 0.985)
    task_success = rng.binomial(1, success_prob, size=n_rows)

    incident_logit = (
        -2.45
        + 1.55 * risk_weight
        + 0.28 * (prompt_tokens > 450).astype(float)
        + 0.18 * (connectivity == "offline").astype(float)
        - 1.20 * safety_gain
        + 0.16 * overblock_penalty
        + rng.normal(0, 0.2, size=n_rows)
    )
    incident_prob = np.clip(_sigmoid(incident_logit), 0.003, 0.78)
    safety_incident = rng.binomial(1, incident_prob, size=n_rows)

    latency_ms = (
        56.0
        + 0.052 * prompt_tokens
        + 15.5 * strictness
        + 8.8 * (device_tier == "entry").astype(float)
        - 7.2 * (device_tier == "premium").astype(float)
        + 3.5 * (connectivity == "offline").astype(float)
        + rng.normal(0, 3.9, size=n_rows)
    )
    latency_ms = np.clip(latency_ms, 32.0, 420.0)

    power_mwh = (
        21.0
        + 0.034 * prompt_tokens
        + 5.3 * strictness
        + 4.6 * (device_tier == "entry").astype(float)
        - 3.6 * (device_tier == "premium").astype(float)
        + rng.normal(0, 2.2, size=n_rows)
    )
    power_mwh = np.clip(power_mwh, 7.0, 260.0)

    safe_value = (
        task_success * (1.48 - 0.0022 * latency_ms - 0.0031 * power_mwh)
        - safety_incident * (1.34 + 0.21 * risk_weight)
        + 0.06 * device_score
        + rng.normal(0, 0.04, size=n_rows)
    )

    return pd.DataFrame(
        {
            "device_tier": device_tier,
            "prompt_risk": prompt_risk,
            "task_domain": task_domain,
            "region": region,
            "connectivity": connectivity,
            "prompt_tokens": prompt_tokens.round(2),
            "battery_pct": battery_pct.round(2),
            "thermal_headroom": thermal_headroom.round(2),
            "model_size_b": model_size_b.round(3),
            TREATMENT_COL: policy_level.astype(int),
            SUCCESS_COL: task_success.astype(int),
            SAFE_VALUE_COL: safe_value.round(6),
            INCIDENT_COL: safety_incident.astype(int),
            LATENCY_COL: latency_ms.round(4),
            "power_mwh": power_mwh.round(4),
        }
    )

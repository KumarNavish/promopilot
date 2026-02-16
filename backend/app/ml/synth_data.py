from __future__ import annotations

from typing import Iterable

import numpy as np
import pandas as pd

from app.ml.data_schema import BOOKINGS_COL, NET_VALUE_COL, TREATMENT_COL


def _softmax(logits: np.ndarray) -> np.ndarray:
    stabilized = logits - logits.max(axis=1, keepdims=True)
    exp_logits = np.exp(stabilized)
    return exp_logits / exp_logits.sum(axis=1, keepdims=True)


def _sigmoid(values: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-values))


def generate_synthetic_data(
    n_rows: int = 60_000,
    seed: int = 7,
    treatment_levels: Iterable[int] = (0, 5, 10, 15, 20),
) -> pd.DataFrame:
    """Generate a confounded promotional dataset with known treatment response."""

    rng = np.random.default_rng(seed)
    levels = np.array(sorted(set(int(x) for x in treatment_levels)), dtype=int)
    if levels.size < 2:
        raise ValueError("At least two treatment levels are required")

    loyalty_tier = rng.choice(["G0", "G1", "G2", "G3"], size=n_rows, p=[0.28, 0.32, 0.25, 0.15])
    device = rng.choice(["desktop", "mobile", "tablet"], size=n_rows, p=[0.42, 0.48, 0.10])
    region = rng.choice(["NA", "EU", "APAC", "LATAM"], size=n_rows, p=[0.38, 0.24, 0.24, 0.14])
    price_sensitivity = rng.choice(["low", "medium", "high"], size=n_rows, p=[0.24, 0.51, 0.25])
    trip_type = rng.choice(["leisure", "business", "family"], size=n_rows, p=[0.56, 0.22, 0.22])

    loyalty_score = pd.Series(loyalty_tier).map({"G0": -0.20, "G1": 0.0, "G2": 0.20, "G3": 0.35}).to_numpy()
    sensitivity_score = pd.Series(price_sensitivity).map({"low": -0.45, "medium": 0.0, "high": 0.55}).to_numpy()
    device_score = pd.Series(device).map({"desktop": 0.05, "mobile": 0.25, "tablet": 0.10}).to_numpy()
    region_score = pd.Series(region).map({"NA": 0.18, "EU": 0.08, "APAC": 0.0, "LATAM": -0.08}).to_numpy()
    trip_score = pd.Series(trip_type).map({"leisure": 0.08, "business": 0.28, "family": 0.04}).to_numpy()

    lead_time = np.clip(rng.gamma(shape=2.2, scale=13.5, size=n_rows) + rng.normal(0, 2, n_rows), 1, 120)
    nights = rng.integers(1, 9, size=n_rows)
    search_intensity = np.clip(rng.poisson(5.0, size=n_rows) + rng.normal(0, 0.9, n_rows), 1, None)

    base_price = (
        85
        + 15 * nights
        + 1.45 * lead_time
        + 30 * np.maximum(region_score, -0.1)
        + 24 * np.maximum(trip_score, 0.0)
        + rng.lognormal(mean=3.15, sigma=0.35, size=n_rows)
    )

    latent_intent = (
        0.55 * loyalty_score
        + 0.38 * device_score
        + 0.26 * region_score
        + 0.52 * trip_score
        - 0.15 * sensitivity_score
        + 0.0028 * base_price
        - 0.002 * lead_time
        + 0.04 * search_intensity
        + rng.normal(0, 0.35, size=n_rows)
    )

    logits = np.zeros((n_rows, levels.size), dtype=float)
    normalized_levels = levels / max(levels.max(), 1)
    for idx, level in enumerate(normalized_levels):
        logits[:, idx] = (
            -0.45 * level * level
            + 0.95 * level * latent_intent
            + 0.55 * level * (sensitivity_score > 0).astype(float)
            + 0.30 * level * (device == "mobile").astype(float)
            + 0.20 * level * (base_price > np.quantile(base_price, 0.65)).astype(float)
            + 0.17 * level * (lead_time < np.quantile(lead_time, 0.35)).astype(float)
        )

    assignment_prob = _softmax(logits)
    sampled_idx = np.array(
        [rng.choice(levels.size, p=assignment_prob[row_idx]) for row_idx in range(n_rows)],
        dtype=int,
    )
    discount_pct = levels[sampled_idx]

    # Ground-truth treatment effect: saturating lift with diminishing returns.
    treatment_curve = (
        1.12 * (1.0 - np.exp(-discount_pct / 7.0))
        - 0.16 * np.square(discount_pct / 10.0)
    )
    heterogeneity = (
        0.40 * sensitivity_score
        + 0.15 * (device == "mobile").astype(float)
        - 0.10 * (loyalty_tier == "G3").astype(float)
        + 0.06 * (trip_type == "family").astype(float)
    )

    base_logit = (
        -1.65
        + 0.82 * latent_intent
        + 0.06 * np.log1p(search_intensity)
        + 0.07 * (lead_time < 14).astype(float)
        + 0.10 * (trip_type == "business").astype(float)
        - 0.06 * (price_sensitivity == "low").astype(float)
    )
    book_prob = _sigmoid(base_logit + treatment_curve * (1 + heterogeneity))
    book_prob = np.clip(book_prob, 0.01, 0.985)

    booked = rng.binomial(1, book_prob, size=n_rows)

    commission_rate = np.clip(
        0.105
        + 0.012 * (trip_type == "business").astype(float)
        + 0.004 * (loyalty_tier == "G3").astype(float)
        + rng.normal(0, 0.004, size=n_rows),
        0.075,
        0.16,
    )
    net_value = booked * commission_rate * base_price * (1.0 - discount_pct / 100.0)

    return pd.DataFrame(
        {
            "loyalty_tier": loyalty_tier,
            "device": device,
            "region": region,
            "price_sensitivity": price_sensitivity,
            "trip_type": trip_type,
            "lead_time": lead_time.round(2),
            "base_price": base_price.round(2),
            "nights": nights,
            "search_intensity": search_intensity.round(2),
            TREATMENT_COL: discount_pct.astype(int),
            BOOKINGS_COL: booked.astype(int),
            NET_VALUE_COL: net_value.round(5),
        }
    )

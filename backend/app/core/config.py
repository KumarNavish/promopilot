from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Tuple


@dataclass(frozen=True)
class Settings:
    app_env: str
    artifact_dir: Path
    treatment_levels: Tuple[int, ...]
    objectives: Tuple[str, ...]
    segmentations: Tuple[str, ...]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    default_artifact_dir = Path(__file__).resolve().parents[1] / "artifacts"
    artifact_dir = Path(os.getenv("ARTIFACT_DIR", str(default_artifact_dir))).expanduser().resolve()

    return Settings(
        app_env=os.getenv("APP_ENV", "dev"),
        artifact_dir=artifact_dir,
        treatment_levels=(0, 5, 10, 15, 20),
        objectives=("bookings", "net_value"),
        segmentations=("none", "loyalty_tier", "price_sensitivity", "device"),
    )

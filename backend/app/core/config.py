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
        treatment_levels=(0, 1, 2, 3, 4),
        objectives=("task_success", "safe_value"),
        segmentations=("none", "device_tier", "prompt_risk", "task_domain"),
    )

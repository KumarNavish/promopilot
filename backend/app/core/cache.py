from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional


@dataclass(frozen=True)
class ArtifactBundle:
    manifest: Dict[str, Any]
    dose_response: Dict[str, Any]
    baselines: Dict[str, Any]
    has_dr: bool


class ArtifactCache:
    def __init__(self) -> None:
        self._bundle: Optional[ArtifactBundle] = None
        self._artifact_dir: Optional[Path] = None
        self._lock = threading.Lock()

    def get(self, artifact_dir: Path) -> ArtifactBundle:
        with self._lock:
            if self._bundle is not None and self._artifact_dir == artifact_dir:
                return self._bundle

            manifest_path = artifact_dir / "manifest.json"
            dose_response_path = artifact_dir / "dose_response.json"
            baseline_path = artifact_dir / "policy_baselines.json"

            if not manifest_path.exists() or not dose_response_path.exists():
                raise FileNotFoundError(
                    "Missing artifacts. Run `python -m app.ml.train` to generate artifacts."
                )

            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            dose_response = json.loads(dose_response_path.read_text(encoding="utf-8"))
            baselines = (
                json.loads(baseline_path.read_text(encoding="utf-8"))
                if baseline_path.exists()
                else {"name": "current_policy", "discount_pct": 10}
            )

            has_dr = bool(manifest.get("has_dr", True))
            bundle = ArtifactBundle(
                manifest=manifest,
                dose_response=dose_response,
                baselines=baselines,
                has_dr=has_dr,
            )
            self._bundle = bundle
            self._artifact_dir = artifact_dir
            return bundle

    def clear(self) -> None:
        with self._lock:
            self._bundle = None
            self._artifact_dir = None


class ResponseCache:
    def __init__(self) -> None:
        self._cache: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()

    def get(self, key: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            return self._cache.get(key)

    def set(self, key: str, value: Dict[str, Any]) -> None:
        with self._lock:
            self._cache[key] = value

    def clear(self) -> None:
        with self._lock:
            self._cache.clear()


artifact_cache = ArtifactCache()
response_cache = ResponseCache()

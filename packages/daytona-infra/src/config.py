"""Minimal configuration for the Daytona snapshot bootstrap script."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class DaytonaBootstrapConfig:
    """Configuration needed by bootstrap.py."""

    api_key: str
    api_url: str | None
    target: str | None
    base_snapshot: str
    repo_root: Path


def load_config() -> DaytonaBootstrapConfig:
    """Load bootstrap configuration from environment variables."""
    api_key = os.environ.get("DAYTONA_API_KEY")
    if not api_key:
        raise RuntimeError("DAYTONA_API_KEY is required")

    base_snapshot = os.environ.get("DAYTONA_BASE_SNAPSHOT")
    if not base_snapshot:
        raise RuntimeError("DAYTONA_BASE_SNAPSHOT is required")

    repo_root = Path(
        os.environ.get("OPEN_INSPECT_REPO_ROOT", Path(__file__).resolve().parents[2])
    )

    return DaytonaBootstrapConfig(
        api_key=api_key,
        api_url=os.environ.get("DAYTONA_API_URL") or None,
        target=os.environ.get("DAYTONA_TARGET") or None,
        base_snapshot=base_snapshot,
        repo_root=repo_root,
    )

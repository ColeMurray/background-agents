"""Minimal configuration for the Daytona OCI publisher and verifier."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class DaytonaBootstrapConfig:
    """Configuration needed by the OCI publication gate."""

    api_key: str
    api_url: str | None
    target: str | None
    image_repository: str
    repo_root: Path


def load_config() -> DaytonaBootstrapConfig:
    """Load bootstrap configuration from environment variables."""
    api_key = os.environ.get("DAYTONA_API_KEY")
    if not api_key:
        raise RuntimeError("DAYTONA_API_KEY is required")

    image_repository = os.environ.get("DAYTONA_IMAGE_REPOSITORY")
    if not image_repository:
        raise RuntimeError("DAYTONA_IMAGE_REPOSITORY is required")

    repo_root = Path(os.environ.get("OPENINSPECT_REPO_ROOT", Path(__file__).resolve().parents[3]))

    return DaytonaBootstrapConfig(
        api_key=api_key,
        api_url=os.environ.get("DAYTONA_API_URL") or None,
        target=os.environ.get("DAYTONA_TARGET") or None,
        image_repository=image_repository,
        repo_root=repo_root,
    )

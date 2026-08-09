"""Stable process configuration for the sandbox runtime."""

from __future__ import annotations

import json
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Mapping


class BootMode(StrEnum):
    FRESH = "fresh"
    SNAPSHOT_RESTORE = "snapshot_restore"
    REPO_IMAGE = "repo_image"
    BUILD = "build"

    @classmethod
    def from_env(cls, environment: Mapping[str, str]) -> BootMode:
        if environment.get("IMAGE_BUILD_MODE") == "true":
            return cls.BUILD
        if environment.get("RESTORED_FROM_SNAPSHOT") == "true":
            return cls.SNAPSHOT_RESTORE
        if environment.get("FROM_REPO_IMAGE") == "true":
            return cls.REPO_IMAGE
        return cls.FRESH


@dataclass(frozen=True)
class RuntimeConfig:
    sandbox_id: str
    control_plane_url: str
    sandbox_token: str
    repo_owner: str
    repo_name: str
    vcs_host: str
    session_config: dict[str, Any]
    workspace_path: Path
    repo_path: Path

    @classmethod
    def from_env(
        cls,
        environment: Mapping[str, str],
        *,
        workspace_path: Path = Path("/workspace"),
    ) -> RuntimeConfig:
        repo_owner = environment.get("REPO_OWNER", "")
        repo_name = environment.get("REPO_NAME", "")
        session_config = json.loads(environment.get("SESSION_CONFIG", "{}"))
        if not isinstance(session_config, dict):
            raise ValueError("SESSION_CONFIG must contain a JSON object")
        repo_path = workspace_path / repo_name if repo_owner and repo_name else workspace_path
        return cls(
            sandbox_id=environment.get("SANDBOX_ID", "unknown"),
            control_plane_url=environment.get("CONTROL_PLANE_URL", ""),
            sandbox_token=environment.get("SANDBOX_AUTH_TOKEN", ""),
            repo_owner=repo_owner,
            repo_name=repo_name,
            vcs_host=environment.get("VCS_HOST", "github.com"),
            session_config=session_config,
            workspace_path=workspace_path,
            repo_path=repo_path,
        )

    @property
    def has_repository(self) -> bool:
        return bool(self.repo_owner and self.repo_name)

    @property
    def base_branch(self) -> str:
        return str(self.session_config.get("branch") or "main")

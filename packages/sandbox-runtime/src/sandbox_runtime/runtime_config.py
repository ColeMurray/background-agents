"""Stable process configuration for the sandbox runtime."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from types import MappingProxyType
from typing import Any
from urllib.parse import urlsplit


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


def _freeze_json(value: Any) -> Any:
    if isinstance(value, dict):
        return MappingProxyType({key: _freeze_json(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_freeze_json(item) for item in value)
    return value


def _validate_control_plane_url(url: str) -> None:
    if not url:
        return
    parsed = urlsplit(url)
    if parsed.scheme == "https" and parsed.hostname:
        return
    if parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}:
        return
    raise ValueError("CONTROL_PLANE_URL must use HTTPS except for loopback development URLs")


@dataclass(frozen=True)
class RepositoryConfig:
    sandbox_id: str
    repo_owner: str
    repo_name: str
    vcs_host: str
    repositories: tuple[Mapping[str, Any], ...]
    base_sha: str
    branch: str
    working_branch_name: str
    workspace_path: Path
    repo_path: Path

    @property
    def has_repository(self) -> bool:
        return bool(self.repo_owner and self.repo_name)


@dataclass(frozen=True)
class OpenCodeConfig:
    provider: str
    model: str
    mcp_servers: tuple[Mapping[str, Any], ...]
    has_repository: bool
    workspace_path: Path


@dataclass(frozen=True)
class ManagedSkillsConfig:
    control_plane_url: str
    sandbox_token: str
    session_id: str


@dataclass(frozen=True)
class BridgeProcessConfig:
    sandbox_id: str
    control_plane_url: str
    sandbox_token: str
    session_id: str


@dataclass(frozen=True)
class RuntimeConfig:
    sandbox_id: str
    control_plane_url: str
    sandbox_token: str
    repo_owner: str
    repo_name: str
    vcs_host: str
    session_config: Mapping[str, Any]
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
        parsed_session_config = json.loads(environment.get("SESSION_CONFIG", "{}"))
        if not isinstance(parsed_session_config, dict):
            raise ValueError("SESSION_CONFIG must contain a JSON object")
        session_config = _freeze_json(parsed_session_config)
        repo_path = workspace_path / repo_name if repo_owner and repo_name else workspace_path
        control_plane_url = environment.get("CONTROL_PLANE_URL", "")
        _validate_control_plane_url(control_plane_url)
        return cls(
            sandbox_id=environment.get("SANDBOX_ID", "unknown"),
            control_plane_url=control_plane_url,
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

    @property
    def session_id(self) -> str:
        return str(self.session_config.get("session_id") or "")

    def repository_config(self) -> RepositoryConfig:
        raw_repositories = self.session_config.get("repositories")
        repositories = (
            tuple(item for item in raw_repositories if isinstance(item, Mapping))
            if isinstance(raw_repositories, tuple)
            else ()
        )
        return RepositoryConfig(
            sandbox_id=self.sandbox_id,
            repo_owner=self.repo_owner,
            repo_name=self.repo_name,
            vcs_host=self.vcs_host,
            repositories=repositories,
            base_sha=str(self.session_config.get("base_sha") or ""),
            branch=self.base_branch,
            working_branch_name=str(self.session_config.get("working_branch_name") or ""),
            workspace_path=self.workspace_path,
            repo_path=self.repo_path,
        )

    def opencode_config(self) -> OpenCodeConfig:
        raw_mcp_servers = self.session_config.get("mcp_servers")
        mcp_servers = (
            tuple(item for item in raw_mcp_servers if isinstance(item, Mapping))
            if isinstance(raw_mcp_servers, tuple)
            else ()
        )
        return OpenCodeConfig(
            provider=str(self.session_config.get("provider") or "anthropic"),
            model=str(self.session_config.get("model") or "claude-sonnet-4-6"),
            mcp_servers=mcp_servers,
            has_repository=self.has_repository,
            workspace_path=self.workspace_path,
        )

    def bridge_process_config(self) -> BridgeProcessConfig:
        return BridgeProcessConfig(
            sandbox_id=self.sandbox_id,
            control_plane_url=self.control_plane_url,
            sandbox_token=self.sandbox_token,
            session_id=self.session_id,
        )

    def managed_skills_config(self) -> ManagedSkillsConfig:
        return ManagedSkillsConfig(
            control_plane_url=self.control_plane_url,
            sandbox_token=self.sandbox_token,
            session_id=self.session_id,
        )

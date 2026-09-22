"""Translate a session launch into Modal image, environment, and resource arguments."""

import json
import secrets
import time
from dataclasses import dataclass
from typing import Any

import modal

from sandbox_runtime.constants import (
    NOVNC_PORT_ENV_VAR,
    SANDBOX_TIMEOUT_ENV_VAR,
    VNC_PASSWORD_ENV_VAR,
    VNC_PASSWORD_MAX_BYTES,
)
from sandbox_runtime.types import SandboxStatus

from ..app import app, llm_secrets
from ..images.base import base_image
from .models import SandboxConfig, SandboxHandle
from .tunnels import SandboxTunnels
from .vcs_env import inject_vcs_env_vars

_RESERVED_LAUNCH_ENV_VARS = {
    "RESTORED_FROM_SNAPSHOT",
    "FROM_REPO_IMAGE",
    "REPO_IMAGE_SHA",
    "IMAGE_BUILD_MODE",
    "TERMINAL_ENABLED",
    "AGENT_SLACK_NOTIFY_ENABLED",
    "SESSION_CONFIG",
    VNC_PASSWORD_ENV_VAR,
    NOVNC_PORT_ENV_VAR,
}


class RepositoryImageUnavailableError(RuntimeError):
    """The selected repository image no longer exists in Modal."""


def _resource_kwargs(settings: dict[str, Any] | None) -> dict[str, Any]:
    """Map sandbox settings to Modal resource kwargs.

    `cpuCores` -> Modal `cpu` (cores, fractional allowed), `memoryMib` -> Modal
    `memory` (MiB). The control plane owns normalization; this only maps
    already-normalized settings into provider-specific argument names.
    """
    if not settings:
        return {}

    kwargs: dict[str, Any] = {}

    cpu_cores = settings.get("cpuCores")
    if cpu_cores is not None:
        kwargs["cpu"] = float(cpu_cores)

    memory_mib = settings.get("memoryMib")
    if memory_mib is not None:
        kwargs["memory"] = memory_mib

    return kwargs


@dataclass(frozen=True)
class BaseImageSource:
    pass


@dataclass(frozen=True)
class RepositoryImageSource:
    image_id: str
    sha: str | None


@dataclass(frozen=True)
class SnapshotImageSource:
    image_id: str
    clone_token: str | None


type SandboxImageSource = BaseImageSource | RepositoryImageSource | SnapshotImageSource


@dataclass(frozen=True)
class SandboxLaunchSpec:
    """Canonical launch configuration paired with one image source variant."""

    config: SandboxConfig
    source: SandboxImageSource


class SandboxLauncher:
    """Own the common Modal launch path for base, repository, and snapshot images."""

    @staticmethod
    def _generate_code_server_password() -> str:
        """Generate a random code-server password."""
        return secrets.token_urlsafe(16)

    @staticmethod
    def _generate_vnc_password() -> str:
        """Generate a random VNC password."""
        return secrets.token_urlsafe(VNC_PASSWORD_MAX_BYTES)[:VNC_PASSWORD_MAX_BYTES]

    async def launch(self, spec: SandboxLaunchSpec) -> SandboxHandle:
        """Launch a Modal sandbox from a normalized create or restore specification."""
        config = spec.config
        has_repository = bool(config.repo_owner)
        sandbox_id = config.sandbox_id
        if not sandbox_id:
            sandbox_name = (
                f"{config.repo_owner}-{config.repo_name}" if has_repository else "no-repository"
            )
            sandbox_id = f"sandbox-{sandbox_name}-{int(time.time() * 1000)}"

        env_vars = {
            key: value
            for key, value in (config.user_env_vars or {}).items()
            if key not in _RESERVED_LAUNCH_ENV_VARS
        }
        env_vars.update(
            {
                "PYTHONUNBUFFERED": "1",
                "SANDBOX_ID": sandbox_id,
                "CONTROL_PLANE_URL": config.control_plane_url,
                "SANDBOX_AUTH_TOKEN": config.sandbox_auth_token,
                SANDBOX_TIMEOUT_ENV_VAR: str(config.timeout_seconds),
                "REPO_OWNER": config.repo_owner or "",
                "REPO_NAME": config.repo_name or "",
            }
        )

        clone_token: str | None = None
        include_github_cli_aliases = False
        snapshot_id: str | None = None
        if isinstance(spec.source, BaseImageSource):
            image = base_image
        elif isinstance(spec.source, RepositoryImageSource):
            try:
                image = modal.Image.from_id(spec.source.image_id)
            except modal.exception.NotFoundError as e:
                raise RepositoryImageUnavailableError("repository image is unavailable") from e
            env_vars["FROM_REPO_IMAGE"] = "true"
            env_vars["REPO_IMAGE_SHA"] = spec.source.sha or ""
        else:
            image = modal.Image.from_id(spec.source.image_id)
            env_vars["RESTORED_FROM_SNAPSHOT"] = "true"
            clone_token = spec.source.clone_token
            include_github_cli_aliases = True
            snapshot_id = spec.source.image_id

        if config.session_config is not None:
            env_vars["SESSION_CONFIG"] = (
                json.dumps(config.session_config)
                if isinstance(config.session_config, dict)
                else config.session_config.model_dump_json()
            )

        inject_vcs_env_vars(
            env_vars,
            clone_token=clone_token if has_repository else None,
            include_github_cli_aliases=include_github_cli_aliases,
        )

        code_server_password: str | None = None
        if config.code_server_enabled:
            code_server_password = self._generate_code_server_password()
            env_vars["CODE_SERVER_PASSWORD"] = code_server_password

        vnc_password: str | None = None
        if config.vnc_enabled:
            vnc_password = self._generate_vnc_password()
            env_vars[VNC_PASSWORD_ENV_VAR] = vnc_password

        if config.agent_slack_notify_enabled:
            env_vars["AGENT_SLACK_NOTIFY_ENABLED"] = "true"

        tunnels = SandboxTunnels(
            code_server_enabled=config.code_server_enabled,
            vnc_enabled=config.vnc_enabled,
            settings=config.settings,
        )
        env_vars.update(tunnels.environment)

        create_kwargs: dict[str, Any] = {
            "image": image,
            "app": app,
            "secrets": [llm_secrets],
            "timeout": config.timeout_seconds,
            "workdir": "/workspace",
            "env": env_vars,
            **_resource_kwargs(config.settings),
        }
        if tunnels.exposed_ports:
            create_kwargs["encrypted_ports"] = tunnels.exposed_ports

        try:
            sandbox = await modal.Sandbox.create.aio(
                "python",
                "-m",
                "sandbox_runtime.entrypoint",
                **create_kwargs,
            )
        except modal.exception.NotFoundError as e:
            if isinstance(spec.source, RepositoryImageSource):
                raise RepositoryImageUnavailableError("repository image is unavailable") from e
            raise
        modal_object_id = sandbox.object_id
        urls = await tunnels.resolve(sandbox, sandbox_id)

        return SandboxHandle(
            sandbox_id=sandbox_id,
            modal_sandbox=sandbox,
            status=SandboxStatus.WARMING,
            created_at=time.time(),
            snapshot_id=snapshot_id,
            modal_object_id=modal_object_id,
            code_server_url=urls.code_server_url,
            code_server_password=code_server_password,
            vnc_url=urls.vnc_url,
            vnc_password=vnc_password,
            ttyd_url=urls.ttyd_url,
            tunnel_urls=urls.tunnel_urls,
        )

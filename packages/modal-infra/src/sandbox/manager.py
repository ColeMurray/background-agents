"""
Sandbox lifecycle management for Open-Inspect.

This module handles:
- Creating sandboxes from filesystem snapshots
- Taking snapshots for session persistence

Updated: 2026-01-15 to fix Sandbox.create API
"""

import asyncio
import json
import secrets
import time
from dataclasses import dataclass
from typing import Any

import modal

from sandbox_runtime.constants import (
    CODE_SERVER_PORT,
    CODE_SERVER_PORT_ENV_VAR,
    DEFAULT_SANDBOX_TIMEOUT_SECONDS,
    EXPECTED_TUNNEL_PORTS_ENV_VAR,
    NOVNC_PORT,
    NOVNC_PORT_ENV_VAR,
    SANDBOX_TIMEOUT_ENV_VAR,
    TTYD_PROXY_PORT,
    TTYD_PROXY_PORT_ENV_VAR,
    TUNNEL_ENV_FILE_PATH,
    TUNNEL_ENV_SANDBOX_ID_KEY,
    VNC_PASSWORD_ENV_VAR,
    VNC_PASSWORD_MAX_BYTES,
    VNC_PORT,
)
from sandbox_runtime.log_config import get_logger
from sandbox_runtime.types import SandboxStatus, SessionConfig

from ..app import app, llm_secrets
from ..images.base import base_image
from .vcs_env import inject_vcs_env_vars

log = get_logger("manager")

SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS = 300
MAX_TUNNEL_PORTS = 10
DEFAULT_VNC_ENABLED = False
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


def _has_repository(repo_owner: str | None, repo_name: str | None) -> bool:
    has_owner = bool(repo_owner)
    has_name = bool(repo_name)
    if has_owner != has_name:
        raise ValueError("repo_owner and repo_name must be provided together")
    return has_owner


def _resource_kwargs(settings: dict[str, Any] | None) -> dict:
    """Map sandbox settings to Modal resource kwargs.

    `cpuCores` -> Modal `cpu` (cores, fractional allowed), `memoryMib` -> Modal
    `memory` (MiB). The control plane owns normalization; this only maps
    already-normalized settings into provider-specific argument names.
    """
    if not settings:
        return {}

    kwargs: dict = {}

    cpu_cores = settings.get("cpuCores")
    if cpu_cores is not None:
        kwargs["cpu"] = float(cpu_cores)

    memory_mib = settings.get("memoryMib")
    if memory_mib is not None:
        kwargs["memory"] = memory_mib

    return kwargs


@dataclass
class SandboxConfig:
    """Configuration for creating a sandbox."""

    repo_owner: str | None
    repo_name: str | None
    sandbox_id: str | None = None  # Expected sandbox ID from control plane
    session_config: SessionConfig | dict[str, Any] | None = None
    control_plane_url: str = ""
    sandbox_auth_token: str = ""
    timeout_seconds: int = DEFAULT_SANDBOX_TIMEOUT_SECONDS
    user_env_vars: dict[str, str] | None = None  # User-provided env vars (repo secrets)
    repo_image_id: str | None = None  # Pre-built repo image ID from provider
    repo_image_sha: str | None = None  # Git SHA the repo image was built from
    code_server_enabled: bool = False  # Whether to start code-server in the sandbox
    vnc_enabled: bool = DEFAULT_VNC_ENABLED  # Whether to start the browser-accessible VNC desktop
    agent_slack_notify_enabled: bool = (
        False  # Whether to install the agent-initiated slack-notify tool
    )
    settings: dict[str, Any] | None = (
        None  # Sandbox settings (tunnelPorts, etc.) from control plane
    )


@dataclass
class SandboxHandle:
    """Handle to a sandbox."""

    sandbox_id: str
    modal_sandbox: modal.Sandbox
    status: SandboxStatus
    created_at: float
    snapshot_id: str | None = None
    modal_object_id: str | None = None  # Modal's internal sandbox ID for API calls
    code_server_url: str | None = None
    code_server_password: str | None = None
    vnc_url: str | None = None
    vnc_password: str | None = None
    ttyd_url: str | None = None  # proxy tunnel URL (not ttyd directly)
    tunnel_urls: dict[int, str] | None = None  # port -> tunnel URL mapping for extra ports


@dataclass(frozen=True)
class _BaseImageSource:
    pass


@dataclass(frozen=True)
class _RepositoryImageSource:
    image_id: str
    sha: str | None


@dataclass(frozen=True)
class _SnapshotImageSource:
    image_id: str
    clone_token: str | None


type _SandboxImageSource = _BaseImageSource | _RepositoryImageSource | _SnapshotImageSource


@dataclass(frozen=True)
class _SandboxLaunchSpec:
    """Canonical launch configuration paired with one image source variant."""

    config: SandboxConfig
    source: _SandboxImageSource


class SandboxManager:
    """
    Manages sandbox lifecycle for Open-Inspect sessions.

    Responsibilities:
    - Create sandboxes from snapshots or fresh images
    - Take snapshots for session persistence
    """

    @staticmethod
    def _generate_code_server_password() -> str:
        """Generate a random code-server password."""
        return secrets.token_urlsafe(16)

    @staticmethod
    def _generate_vnc_password() -> str:
        """Generate a random VNC password."""
        return secrets.token_urlsafe(VNC_PASSWORD_MAX_BYTES)[:VNC_PASSWORD_MAX_BYTES]

    @staticmethod
    async def _resolve_tunnels(
        sandbox: modal.Sandbox,
        sandbox_id: str,
        ports: list[int],
        retries: int = 3,
        backoff: float = 1.0,
    ) -> dict[int, str]:
        """Resolve tunnel URLs for the given ports from Modal, retrying on failure."""
        resolved: dict[int, str] = {}
        for attempt in range(retries):
            try:
                loop = asyncio.get_running_loop()
                tunnels = await loop.run_in_executor(None, sandbox.tunnels)
                for port in ports:
                    if port in tunnels and port not in resolved:
                        resolved[port] = tunnels[port].url
                        log.info(
                            "tunnel.resolved",
                            sandbox_id=sandbox_id,
                            port=port,
                            url=tunnels[port].url,
                        )
                if len(resolved) == len(ports):
                    return resolved
            except Exception as e:
                log.warn(
                    "tunnel.resolve_error",
                    sandbox_id=sandbox_id,
                    attempt=attempt + 1,
                    retries=retries,
                    error=type(e).__name__,
                    exc=e,
                )
            if attempt < retries - 1:
                await asyncio.sleep(backoff * (attempt + 1))
        return resolved

    @staticmethod
    def _validate_ports(raw: list) -> list[int]:
        """Validate and sanitize tunnel ports: must be int, 1-65535, max MAX_TUNNEL_PORTS."""
        ports: list[int] = []
        for p in raw:
            if isinstance(p, int) and 1 <= p <= 65535:
                ports.append(p)
            if len(ports) >= MAX_TUNNEL_PORTS:
                break
        return ports

    @staticmethod
    def _resolve_service_ports(settings: dict[str, Any] | None) -> tuple[int, int, int]:
        """Return effective (code_server_port, novnc_port, ttyd_proxy_port) from settings.

        Falls back to the service defaults when unset or invalid. The control
        plane validates these before they reach here.
        """
        s = settings or {}

        def coerce(value: Any, default: int) -> int:
            if isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 65535:
                return value
            return default

        return (
            coerce(s.get("codeServerPort"), CODE_SERVER_PORT),
            coerce(s.get("vncPort"), NOVNC_PORT),
            coerce(s.get("terminalPort"), TTYD_PROXY_PORT),
        )

    @staticmethod
    def _collect_exposed_ports(
        code_server_enabled: bool,
        vnc_enabled: bool,
        terminal_enabled: bool,
        settings: dict[str, Any] | None,
        code_server_port: int,
        novnc_port: int,
        ttyd_proxy_port: int,
    ) -> tuple[list[int], list[int]]:
        """Return (all_exposed_ports, extra_tunnel_ports) from settings and feature flags."""
        # Raw VNC is localhost-only and must never be exposed, including as a
        # user-configured extra tunnel.
        reserved: set[int] = {VNC_PORT}
        exposed: list[int] = []
        if code_server_enabled:
            exposed.append(code_server_port)
            reserved.add(code_server_port)
        if vnc_enabled:
            exposed.append(novnc_port)
            reserved.add(novnc_port)
        if terminal_enabled:
            exposed.append(ttyd_proxy_port)
            reserved.add(ttyd_proxy_port)

        raw_ports = (settings or {}).get("tunnelPorts", [])
        tunnel_ports = SandboxManager._validate_ports(raw_ports) if raw_ports else []
        # Remove reserved ports from tunnel_ports to avoid duplicates
        tunnel_ports = [p for p in tunnel_ports if p not in reserved]
        exposed.extend(tunnel_ports)
        return exposed, tunnel_ports

    @staticmethod
    async def _resolve_and_setup_tunnels(
        sandbox: modal.Sandbox,
        sandbox_id: str,
        code_server_enabled: bool,
        vnc_enabled: bool,
        terminal_enabled: bool,
        extra_ports: list[int],
        code_server_port: int,
        novnc_port: int,
        ttyd_proxy_port: int,
    ) -> tuple[str | None, str | None, str | None, dict[int, str] | None]:
        """Return (code_server_url, vnc_url, ttyd_url, extra_urls)."""
        all_ports: list[int] = []
        if code_server_enabled:
            all_ports.append(code_server_port)
        if vnc_enabled:
            all_ports.append(novnc_port)
        if terminal_enabled:
            all_ports.append(ttyd_proxy_port)
        all_ports.extend(extra_ports)

        if not all_ports:
            return None, None, None, None

        resolved = await SandboxManager._resolve_tunnels(sandbox, sandbox_id, all_ports)

        # Only pull a service port out of the resolved map when that service owns
        # it. Otherwise a user's own port (e.g. 8080 with code-server disabled)
        # would be misrouted to code_server_url and dropped from the tunnel map.
        code_server_url = resolved.pop(code_server_port, None) if code_server_enabled else None
        vnc_url = resolved.pop(novnc_port, None) if vnc_enabled else None
        ttyd_url = resolved.pop(ttyd_proxy_port, None) if terminal_enabled else None
        extra_urls = resolved if resolved else None

        if extra_urls:
            await SandboxManager._write_tunnel_env_file(sandbox, sandbox_id, extra_urls)

        return code_server_url, vnc_url, ttyd_url, extra_urls

    @staticmethod
    async def _write_tunnel_env_file(
        sandbox: modal.Sandbox,
        sandbox_id: str,
        tunnel_urls: dict[int, str],
    ) -> None:
        """Write tunnel URLs to TUNNEL_ENV_FILE_PATH as a dotenv file.

        The first line tags the file with this sandbox's ID so the supervisor's
        stale-file cleanup can tell a fresh write (this write can land before
        the entrypoint runs) from a snapshot/image leftover.

        Failures are logged but do not block sandbox creation; URLs are also
        returned to the control plane via the SandboxHandle.
        """
        lines = [f"{TUNNEL_ENV_SANDBOX_ID_KEY}={sandbox_id}"]
        lines += [f"TUNNEL_{port}={url}" for port, url in sorted(tunnel_urls.items())]
        content = "\n".join(lines) + "\n"
        try:
            await sandbox.filesystem.write_text.aio(content, TUNNEL_ENV_FILE_PATH)
            log.info(
                "tunnel.urls_written",
                sandbox_id=sandbox_id,
                path=TUNNEL_ENV_FILE_PATH,
                ports=list(tunnel_urls.keys()),
            )
        except Exception as e:
            log.warn(
                "tunnel.urls_write_failed",
                sandbox_id=sandbox_id,
                path=TUNNEL_ENV_FILE_PATH,
                exc=e,
            )

    async def _launch_sandbox(self, spec: _SandboxLaunchSpec) -> SandboxHandle:
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
        if isinstance(spec.source, _BaseImageSource):
            image = base_image
        elif isinstance(spec.source, _RepositoryImageSource):
            image = modal.Image.from_id(spec.source.image_id)
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

        terminal_enabled = bool((config.settings or {}).get("terminalEnabled", False))
        if terminal_enabled:
            env_vars["TERMINAL_ENABLED"] = "true"
        if config.agent_slack_notify_enabled:
            env_vars["AGENT_SLACK_NOTIFY_ENABLED"] = "true"

        code_server_port, novnc_port, ttyd_proxy_port = self._resolve_service_ports(config.settings)
        if config.code_server_enabled:
            env_vars[CODE_SERVER_PORT_ENV_VAR] = str(code_server_port)
        if config.vnc_enabled:
            env_vars[NOVNC_PORT_ENV_VAR] = str(novnc_port)
        if terminal_enabled:
            env_vars[TTYD_PROXY_PORT_ENV_VAR] = str(ttyd_proxy_port)

        exposed_ports, tunnel_ports = self._collect_exposed_ports(
            config.code_server_enabled,
            config.vnc_enabled,
            terminal_enabled,
            config.settings,
            code_server_port,
            novnc_port,
            ttyd_proxy_port,
        )
        if tunnel_ports:
            env_vars[EXPECTED_TUNNEL_PORTS_ENV_VAR] = ",".join(str(p) for p in tunnel_ports)

        create_kwargs: dict[str, Any] = {
            "image": image,
            "app": app,
            "secrets": [llm_secrets],
            "timeout": config.timeout_seconds,
            "workdir": "/workspace",
            "env": env_vars,
            **_resource_kwargs(config.settings),
        }
        if exposed_ports:
            create_kwargs["encrypted_ports"] = exposed_ports

        sandbox = await modal.Sandbox.create.aio(
            "python",
            "-m",
            "sandbox_runtime.entrypoint",
            **create_kwargs,
        )
        modal_object_id = sandbox.object_id
        (
            code_server_url,
            vnc_url,
            ttyd_url,
            extra_tunnel_urls,
        ) = await self._resolve_and_setup_tunnels(
            sandbox,
            sandbox_id,
            config.code_server_enabled,
            config.vnc_enabled,
            terminal_enabled,
            tunnel_ports,
            code_server_port,
            novnc_port,
            ttyd_proxy_port,
        )

        return SandboxHandle(
            sandbox_id=sandbox_id,
            modal_sandbox=sandbox,
            status=SandboxStatus.WARMING,
            created_at=time.time(),
            snapshot_id=snapshot_id,
            modal_object_id=modal_object_id,
            code_server_url=code_server_url,
            code_server_password=code_server_password,
            vnc_url=vnc_url,
            vnc_password=vnc_password,
            ttyd_url=ttyd_url,
            tunnel_urls=extra_tunnel_urls,
        )

    async def create_sandbox(
        self,
        config: SandboxConfig,
    ) -> SandboxHandle:
        """
        Create a new sandbox for a session.

        Creates from the pre-built repo image when one is provided,
        otherwise from the base image. Snapshot restores go through
        restore_sandbox, not this path.

        Args:
            config: Sandbox configuration including repo info and session config

        Returns:
            SandboxHandle with the running sandbox
        """
        start_time = time.time()
        _has_repository(config.repo_owner, config.repo_name)

        if config.repo_image_id:
            source: _SandboxImageSource = _RepositoryImageSource(
                image_id=config.repo_image_id,
                sha=config.repo_image_sha,
            )
        else:
            source = _BaseImageSource()

        handle = await self._launch_sandbox(_SandboxLaunchSpec(config=config, source=source))

        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "sandbox.create",
            sandbox_id=handle.sandbox_id,
            modal_object_id=handle.modal_object_id,
            repo_owner=config.repo_owner,
            repo_name=config.repo_name,
            duration_ms=duration_ms,
            outcome="success",
        )

        return handle

    async def take_snapshot(
        self,
        handle: SandboxHandle,
    ) -> str:
        """
        Take a filesystem snapshot of a sandbox using Modal's native API.

        Uses Modal's snapshot_filesystem() which:
        - Creates a copy of the Sandbox's filesystem at a given point in time
        - Returns an Image that can be used to create new Sandboxes
        - Is optimized for performance - calculated as difference from base image
        - Snapshots persist indefinitely

        Captures the full state including:
        - Repository with uncommitted changes
        - OpenCode session state
        - Any cached artifacts

        Args:
            handle: Handle to the sandbox to snapshot

        Returns:
            Image ID that can be used to restore the sandbox later
        """
        start_time = time.time()

        image = await handle.modal_sandbox.snapshot_filesystem.aio(
            timeout=SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS
        )

        # The image object_id is the unique identifier for this snapshot
        # Modal automatically stores the image and it persists indefinitely
        image_id = image.object_id

        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "sandbox.snapshot",
            sandbox_id=handle.sandbox_id,
            image_id=image_id,
            duration_ms=duration_ms,
            outcome="success",
        )

        return image_id

    async def get_sandbox_by_id(self, sandbox_id: str) -> SandboxHandle | None:
        """
        Get a sandbox handle by its ID.

        Uses Modal's Sandbox.from_id() to retrieve an existing sandbox.

        Args:
            sandbox_id: The Modal sandbox ID

        Returns:
            SandboxHandle if found, None otherwise
        """
        try:
            modal_sandbox = await modal.Sandbox.from_id.aio(sandbox_id)
            return SandboxHandle(
                sandbox_id=sandbox_id,
                modal_sandbox=modal_sandbox,
                status=SandboxStatus.READY,  # Assume ready if we can retrieve it
                created_at=time.time(),
            )
        except Exception as e:
            log.warn("sandbox.lookup_error", sandbox_id=sandbox_id, exc=e)
            return None

    async def restore_from_snapshot(
        self,
        snapshot_image_id: str,
        session_config: SessionConfig | dict[str, Any],
        sandbox_id: str | None = None,
        control_plane_url: str = "",
        sandbox_auth_token: str = "",
        clone_token: str | None = None,
        user_env_vars: dict[str, str] | None = None,
        timeout_seconds: int = DEFAULT_SANDBOX_TIMEOUT_SECONDS,
        code_server_enabled: bool = False,
        vnc_enabled: bool = DEFAULT_VNC_ENABLED,
        agent_slack_notify_enabled: bool = False,
        settings: dict[str, Any] | None = None,
    ) -> SandboxHandle:
        """
        Create a new sandbox from a filesystem snapshot Image.

        The OpenCode session resumes with full workspace state intact.
        Git clone is skipped since the workspace already has all changes.

        Args:
            snapshot_image_id: Modal Image ID from snapshot_filesystem()
            session_config: Session configuration
            sandbox_id: Optional sandbox ID (generated if not provided)
            control_plane_url: URL for the control plane
            sandbox_auth_token: Auth token for the sandbox
            clone_token: VCS clone token for git operations

        Returns:
            SandboxHandle for the restored sandbox
        """
        start_time = time.time()

        if isinstance(session_config, dict):
            repo_owner = session_config.get("repo_owner")
            repo_name = session_config.get("repo_name")
        else:
            repo_owner = session_config.repo_owner
            repo_name = session_config.repo_name
        _has_repository(repo_owner, repo_name)

        # Snapshot restore still passes the clone token through for
        # repo-backed sandboxes. Snapshots taken before the credential-helper
        # migration ship an entrypoint that reads VCS_CLONE_TOKEN from env
        # and embeds it in the origin URL; without it, those legacy snapshots
        # can't fetch. GITHUB_TOKEN/GITHUB_APP_TOKEN aliases are restored too
        # so the gh CLI keeps working on snapshots predating the gh wrapper.
        # Host scoping remains common with fresh creates. These compatibility
        # credentials are explicitly requested only by the restore path.
        handle = await self._launch_sandbox(
            _SandboxLaunchSpec(
                config=SandboxConfig(
                    repo_owner=repo_owner,
                    repo_name=repo_name,
                    sandbox_id=sandbox_id,
                    session_config=session_config,
                    control_plane_url=control_plane_url,
                    sandbox_auth_token=sandbox_auth_token,
                    timeout_seconds=timeout_seconds,
                    user_env_vars=user_env_vars,
                    code_server_enabled=code_server_enabled,
                    vnc_enabled=vnc_enabled,
                    agent_slack_notify_enabled=agent_slack_notify_enabled,
                    settings=settings,
                ),
                source=_SnapshotImageSource(
                    image_id=snapshot_image_id,
                    clone_token=clone_token,
                ),
            )
        )

        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "sandbox.restore",
            sandbox_id=handle.sandbox_id,
            modal_object_id=handle.modal_object_id,
            snapshot_image_id=snapshot_image_id,
            repo_owner=repo_owner,
            repo_name=repo_name,
            duration_ms=duration_ms,
            outcome="success",
        )

        return handle

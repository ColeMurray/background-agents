"""Provider lifecycle operations for Open-Inspect session sandboxes."""

import time
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

from .launch import (
    BaseImageSource,
    RepositoryImageSource,
    RepositoryImageUnavailableError,
    SandboxImageSource,
    SandboxLauncher,
    SandboxLaunchSpec,
    SnapshotImageSource,
)
from .models import DEFAULT_VNC_ENABLED, SandboxConfig, SandboxHandle
from .tunnels import MAX_TUNNEL_PORTS

# Preserve the existing public imports after moving their implementations.
__all__ = [
    "CODE_SERVER_PORT",
    "CODE_SERVER_PORT_ENV_VAR",
    "DEFAULT_SANDBOX_TIMEOUT_SECONDS",
    "DEFAULT_VNC_ENABLED",
    "EXPECTED_TUNNEL_PORTS_ENV_VAR",
    "MAX_TUNNEL_PORTS",
    "NOVNC_PORT",
    "NOVNC_PORT_ENV_VAR",
    "SANDBOX_TIMEOUT_ENV_VAR",
    "SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS",
    "TTYD_PROXY_PORT",
    "TTYD_PROXY_PORT_ENV_VAR",
    "TUNNEL_ENV_FILE_PATH",
    "TUNNEL_ENV_SANDBOX_ID_KEY",
    "VNC_PASSWORD_ENV_VAR",
    "VNC_PASSWORD_MAX_BYTES",
    "VNC_PORT",
    "RepositoryImageUnavailableError",
    "SandboxConfig",
    "SandboxHandle",
    "SandboxManager",
]

log = get_logger("manager")

SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS = 300


def _has_repository(repo_owner: str | None, repo_name: str | None) -> bool:
    has_owner = bool(repo_owner)
    has_name = bool(repo_name)
    if has_owner != has_name:
        raise ValueError("repo_owner and repo_name must be provided together")
    return has_owner


class SandboxManager:
    """Normalize create/restore requests and manage existing provider sandboxes.

    Launch translation and networking are owned by provider-local collaborators.
    Session readiness and checkpoint/shutdown policy remain in the control plane.
    """

    async def create_sandbox(
        self,
        config: SandboxConfig,
    ) -> SandboxHandle:
        """
        Create a new sandbox for a session.

        Creates from the pre-built repo image when one is provided,
        otherwise from the base image. Snapshot restores go through
        restore_from_snapshot, not this path.

        Args:
            config: Sandbox configuration including repo info and session config

        Returns:
            SandboxHandle with the running sandbox
        """
        start_time = time.time()
        _has_repository(config.repo_owner, config.repo_name)

        if config.repo_image_id:
            source: SandboxImageSource = RepositoryImageSource(
                image_id=config.repo_image_id,
                sha=config.repo_image_sha,
            )
        else:
            source = BaseImageSource()

        handle = await SandboxLauncher().launch(SandboxLaunchSpec(config=config, source=source))

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
        timeout_seconds: float = SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS,
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

        # Modal takes whole seconds. Round down so conversion cannot extend
        # the caller's deadline, and never pass its unbounded zero sentinel.
        snapshot_timeout_seconds = min(int(timeout_seconds), SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS)
        if snapshot_timeout_seconds <= 0:
            raise TimeoutError("Insufficient time remains for a filesystem snapshot")
        image = await handle.modal_sandbox.snapshot_filesystem.aio(timeout=snapshot_timeout_seconds)

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

    async def stop_sandbox(self, sandbox_id: str) -> None:
        """Terminate a provider sandbox by its immutable Modal object id."""
        try:
            sandbox = await modal.Sandbox.from_id.aio(sandbox_id)
            await sandbox.terminate.aio(wait=True)
        except modal.exception.NotFoundError:
            # Already absent is the terminal state requested by stop.
            return

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
        handle = await SandboxLauncher().launch(
            SandboxLaunchSpec(
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
                source=SnapshotImageSource(
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

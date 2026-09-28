"""Provider lifecycle operations for Open-Inspect session sandboxes."""

import time
from typing import Any

import modal

from sandbox_runtime.constants import (
    CODE_SERVER_PORT,
    CODE_SERVER_PORT_ENV_VAR,
    DEFAULT_SANDBOX_TIMEOUT_SECONDS,
    DOCKER_ENABLED_ENV_VAR,
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
from sandbox_runtime.docker_control import CONTROL_TIMEOUT_SECONDS
from sandbox_runtime.log_config import get_logger
from sandbox_runtime.types import SandboxStatus, SessionConfig

from ..app_config import APP_NAME
from .launch import (
    ACCESS_PASSWORD_READ_TIMEOUT_SECONDS,
    BaseImageSource,
    RepositoryImageSource,
    RepositoryImageUnavailableError,
    SandboxImageSource,
    SandboxLauncher,
    SandboxLaunchSpec,
    SnapshotImageSource,
)
from .launch_policy import (
    PENDING_VM_REFERENCE_PREFIX,
    ModalBackend,
    docker_allocation_name,
    docker_allocation_tags,
    parse_pending_vm_reference,
)
from .models import DEFAULT_VNC_ENABLED, SandboxConfig, SandboxHandle
from .tunnels import MAX_TUNNEL_PORTS

# Preserve the existing public imports after moving their implementations.
__all__ = [
    "ACCESS_PASSWORD_READ_TIMEOUT_SECONDS",
    "APP_NAME",
    "CODE_SERVER_PORT",
    "CODE_SERVER_PORT_ENV_VAR",
    "CONTROL_TIMEOUT_SECONDS",
    "DEFAULT_SANDBOX_TIMEOUT_SECONDS",
    "DEFAULT_VNC_ENABLED",
    "DOCKER_ENABLED_ENV_VAR",
    "EXPECTED_TUNNEL_PORTS_ENV_VAR",
    "MAX_TUNNEL_PORTS",
    "NOVNC_PORT",
    "NOVNC_PORT_ENV_VAR",
    "PENDING_VM_REFERENCE_PREFIX",
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


class PendingVMReferenceNotVisible(RuntimeError):
    """The named allocation is absent or belongs to a different generation."""


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
        if handle.sandbox_backend == "modal-vm":
            preparation_started = time.monotonic()
            probe = await handle.modal_sandbox.exec.aio(
                "python",
                "-m",
                "sandbox_runtime.docker_control",
                "prepare",
                timeout=min(snapshot_timeout_seconds, CONTROL_TIMEOUT_SECONDS),
            )
            if await probe.wait.aio() != 0:
                raise RuntimeError("Modal VM Docker shutdown preparation was not confirmed")
            snapshot_timeout_seconds = min(
                int(timeout_seconds - (time.monotonic() - preparation_started)),
                SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS,
            )
            if snapshot_timeout_seconds <= 0:
                raise TimeoutError("Snapshot deadline expired during Docker preparation")
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
        """Resolve a pending reference if needed, then confirm immutable-ID retirement."""
        if sandbox_id.startswith(PENDING_VM_REFERENCE_PREFIX):
            handle = await self.get_sandbox_by_id(sandbox_id)
            assert handle is not None and handle.modal_object_id is not None
            sandbox_id = handle.modal_object_id
        try:
            sandbox = await modal.Sandbox.from_id.aio(sandbox_id)
            await sandbox.terminate.aio(wait=True)
        except modal.exception.NotFoundError:
            # Already absent is the terminal state requested by stop.
            return

    async def get_sandbox_by_id(self, sandbox_id: str) -> SandboxHandle | None:
        """
        Get a sandbox by immutable ID or a generation-checked pending reference.

        Args:
            sandbox_id: The Modal sandbox ID or opaque VM session reference

        Returns:
            SandboxHandle if found, None for a confirmed missing immutable ID.
            Missing pending references remain ambiguous and raise an error.
        """
        identity = parse_pending_vm_reference(sandbox_id)
        if sandbox_id.startswith(PENDING_VM_REFERENCE_PREFIX):
            if identity is None:
                raise ValueError("Invalid pending VM reference")
            try:
                modal_sandbox = await modal.Sandbox.from_name.aio(
                    APP_NAME, docker_allocation_name(identity[0])
                )
            except modal.exception.NotFoundError:
                raise PendingVMReferenceNotVisible(
                    "VM launch identity is not yet visible"
                ) from None
        else:
            try:
                modal_sandbox = await modal.Sandbox.from_id.aio(sandbox_id)
            except modal.exception.NotFoundError:
                return None
        tags = await modal_sandbox.get_tags.aio()
        if identity is not None and tags != docker_allocation_tags(*identity):
            raise PendingVMReferenceNotVisible("Docker sandbox allocation ownership mismatch")
        backend = tags.get("openinspect_backend", "modal")
        if backend not in ("modal", "modal-vm"):
            raise ValueError("Unknown sandbox backend tag")
        return SandboxHandle(
            sandbox_backend="modal-vm" if backend == "modal-vm" else "modal",
            sandbox_id=sandbox_id,
            modal_object_id=modal_sandbox.object_id,
            modal_sandbox=modal_sandbox,
            status=SandboxStatus.READY,
            created_at=time.time(),
        )

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
        retire_sandbox_id: str | None = None,
        sandbox_backend: ModalBackend = "modal",
        launch_deadline_at_ms: int | None = None,
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
                    retire_sandbox_id=retire_sandbox_id,
                    sandbox_backend=sandbox_backend,
                    launch_deadline_at_ms=launch_deadline_at_ms,
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

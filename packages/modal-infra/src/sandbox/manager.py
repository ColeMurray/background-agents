"""
Sandbox lifecycle management for Open-Inspect.

This module handles:
- Creating sandboxes from filesystem snapshots
- Pre-warming sandboxes for faster startup
- Taking snapshots for session persistence
- Managing sandbox pools for high-volume repos

Updated: 2026-01-15 to fix Sandbox.create API
"""

import json
import os
import time
from dataclasses import dataclass

import modal

from ..app import app, llm_secrets
from ..images.base import base_image
from .log_config import get_logger
from .types import SandboxStatus, SessionConfig

log = get_logger("manager")

DEFAULT_SANDBOX_TIMEOUT_SECONDS = 7200  # 2 hours


@dataclass
class SandboxConfig:
    """Configuration for creating a sandbox."""

    repo_owner: str
    repo_name: str
    sandbox_id: str | None = None  # Expected sandbox ID from control plane
    snapshot_id: str | None = None
    session_config: SessionConfig | None = None
    control_plane_url: str = ""
    sandbox_auth_token: str = ""
    timeout_seconds: int = DEFAULT_SANDBOX_TIMEOUT_SECONDS
    clone_token: str | None = None  # VCS clone token for git operations
    user_env_vars: dict[str, str] | None = None  # User-provided env vars (repo secrets)
    repo_image_id: str | None = None  # Pre-built repo image ID from provider
    repo_image_sha: str | None = None  # Git SHA the repo image was built from


@dataclass
class SandboxHandle:
    """Handle to a running or warm sandbox."""

    sandbox_id: str
    modal_sandbox: modal.Sandbox
    status: SandboxStatus
    created_at: float
    snapshot_id: str | None = None
    modal_object_id: str | None = None  # Modal's internal sandbox ID for API calls

    def get_logs(self) -> str:
        """Get sandbox logs."""
        return self.modal_sandbox.stdout.read() if self.modal_sandbox.stdout else ""

    async def terminate(self) -> None:
        """Terminate the sandbox."""
        await self.modal_sandbox.terminate()


class SandboxManager:
    """
    Manages sandbox lifecycle for Open-Inspect sessions.

    Responsibilities:
    - Create sandboxes from snapshots or fresh images
    - Warm sandboxes proactively when user starts typing
    - Take snapshots for session persistence
    - Maintain warm pools for high-volume repos
    """

    def __init__(self):
        self._warm_pools: dict[str, list[SandboxHandle]] = {}

    def _get_repo_key(self, repo_owner: str, repo_name: str) -> str:
        """Get unique key for a repository."""
        return f"{repo_owner}/{repo_name}"

    @staticmethod
    def _inject_vcs_env_vars(env_vars: dict[str, str], clone_token: str | None) -> None:
        """Inject VCS-neutral env vars based on SCM_PROVIDER."""
        scm_provider = os.environ.get("SCM_PROVIDER", "github")
        if scm_provider == "bitbucket":
            env_vars["VCS_HOST"] = "bitbucket.org"
            env_vars["VCS_CLONE_USERNAME"] = "x-token-auth"
        else:
            env_vars["VCS_HOST"] = "github.com"
            env_vars["VCS_CLONE_USERNAME"] = "x-access-token"

        if clone_token:
            env_vars["VCS_CLONE_TOKEN"] = clone_token
            if scm_provider == "github":
                # Required by gh CLI and git push operations in the sandbox
                env_vars["GITHUB_APP_TOKEN"] = clone_token
                env_vars["GITHUB_TOKEN"] = clone_token

    async def create_sandbox(
        self,
        config: SandboxConfig,
    ) -> SandboxHandle:
        """
        Create a new sandbox for a session.

        If a snapshot_id is provided, restores from that snapshot.
        Otherwise, creates from the latest image for the repo.

        Args:
            config: Sandbox configuration including repo info and session config

        Returns:
            SandboxHandle with the running sandbox
        """
        start_time = time.time()

        # Use provided sandbox_id from control plane, or generate one
        if config.sandbox_id:
            sandbox_id = config.sandbox_id
        else:
            sandbox_id = f"sandbox-{config.repo_owner}-{config.repo_name}-{int(time.time() * 1000)}"

        # Prepare environment variables (user vars first, system vars override)
        env_vars: dict[str, str] = {}

        if config.user_env_vars:
            env_vars.update(config.user_env_vars)

        env_vars.update(
            {
                "PYTHONUNBUFFERED": "1",  # Ensure logs are flushed immediately
                "SANDBOX_ID": sandbox_id,
                "CONTROL_PLANE_URL": config.control_plane_url,
                "SANDBOX_AUTH_TOKEN": config.sandbox_auth_token,
                "REPO_OWNER": config.repo_owner,
                "REPO_NAME": config.repo_name,
            }
        )

        self._inject_vcs_env_vars(env_vars, config.clone_token)

        if config.session_config:
            env_vars["SESSION_CONFIG"] = config.session_config.model_dump_json()

        # Determine image to use (priority: session snapshot > repo image > base image)
        if config.snapshot_id:
            image = modal.Image.from_registry(f"open-inspect-snapshot:{config.snapshot_id}")
        elif config.repo_image_id:
            image = modal.Image.from_id(config.repo_image_id)
            env_vars["FROM_REPO_IMAGE"] = "true"
            env_vars["REPO_IMAGE_SHA"] = config.repo_image_sha or ""
        else:
            image = base_image

        # Create the sandbox
        # The entrypoint command is passed as positional args
        sandbox = modal.Sandbox.create(
            "python",
            "-m",
            "sandbox.entrypoint",  # Run the supervisor entrypoint
            image=image,
            app=app,
            secrets=[llm_secrets],
            timeout=config.timeout_seconds,
            workdir="/workspace",
            env=env_vars,
            # Note: volumes parameter is not supported in Sandbox.create
        )

        # Get Modal's internal object ID for API calls (snapshot, etc.)
        modal_object_id = sandbox.object_id
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "sandbox.create",
            sandbox_id=sandbox_id,
            modal_object_id=modal_object_id,
            repo_owner=config.repo_owner,
            repo_name=config.repo_name,
            duration_ms=duration_ms,
            outcome="success",
        )

        return SandboxHandle(
            sandbox_id=sandbox_id,
            modal_sandbox=sandbox,
            status=SandboxStatus.WARMING,
            created_at=time.time(),
            snapshot_id=config.snapshot_id,
            modal_object_id=modal_object_id,
        )

    async def create_build_sandbox(
        self,
        repo_owner: str,
        repo_name: str,
        default_branch: str = "main",
        clone_token: str = "",
        user_env_vars: dict[str, str] | None = None,
    ) -> SandboxHandle:
        """
        Create a sandbox specifically for image building.

        Like create_sandbox() but:
        - Sets IMAGE_BUILD_MODE=true (exits after setup, no OpenCode/bridge)
        - No CONTROL_PLANE_URL, SANDBOX_AUTH_TOKEN, or LLM secrets
        - Shorter timeout (30 min vs 2 hours)
        - Always uses base_image (builds start from the universal base)
        """
        BUILD_TIMEOUT_SECONDS = 1800

        start_time = time.time()
        sandbox_id = f"build-{repo_owner}-{repo_name}-{int(time.time() * 1000)}"

        # Prepare environment variables (user vars first, system vars override)
        env_vars: dict[str, str] = {}

        if user_env_vars:
            env_vars.update(user_env_vars)

        env_vars.update(
            {
                "PYTHONUNBUFFERED": "1",
                "SANDBOX_ID": sandbox_id,
                "REPO_OWNER": repo_owner,
                "REPO_NAME": repo_name,
                "IMAGE_BUILD_MODE": "true",
                "SESSION_CONFIG": json.dumps({"branch": default_branch}),
            }
        )

        self._inject_vcs_env_vars(env_vars, clone_token or None)

        sandbox = modal.Sandbox.create(
            "python",
            "-m",
            "sandbox.entrypoint",
            image=base_image,
            app=app,
            secrets=[],
            timeout=BUILD_TIMEOUT_SECONDS,
            workdir="/workspace",
            env=env_vars,
        )

        modal_object_id = sandbox.object_id
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "sandbox.create_build",
            sandbox_id=sandbox_id,
            modal_object_id=modal_object_id,
            repo_owner=repo_owner,
            repo_name=repo_name,
            duration_ms=duration_ms,
            outcome="success",
        )

        return SandboxHandle(
            sandbox_id=sandbox_id,
            modal_sandbox=sandbox,
            status=SandboxStatus.WARMING,
            created_at=time.time(),
            modal_object_id=modal_object_id,
        )

    async def warm_sandbox(
        self,
        repo_owner: str,
        repo_name: str,
        control_plane_url: str = "",
    ) -> SandboxHandle:
        """
        Pre-warm a sandbox for a repository.

        Called when user starts typing to reduce latency. The sandbox
        begins syncing with the latest code immediately.

        Args:
            repo_owner: GitHub repository owner
            repo_name: GitHub repository name
            control_plane_url: URL for the control plane WebSocket

        Returns:
            SandboxHandle for the warming sandbox
        """
        repo_key = self._get_repo_key(repo_owner, repo_name)

        # Check if we have a warm sandbox in the pool
        if self._warm_pools.get(repo_key):
            return self._warm_pools[repo_key].pop(0)

        # Create a new warming sandbox
        config = SandboxConfig(
            repo_owner=repo_owner,
            repo_name=repo_name,
            control_plane_url=control_plane_url,
        )

        return await self.create_sandbox(config)

    def take_snapshot(
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
        snapshot_id = f"snap-{handle.sandbox_id}-{int(time.time() * 1000)}"

        # Use Modal's native snapshot_filesystem() API
        # This returns an Image directly (not async)
        image = handle.modal_sandbox.snapshot_filesystem()

        # The image object_id is the unique identifier for this snapshot
        # Modal automatically stores the image and it persists indefinitely
        image_id = image.object_id

        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "sandbox.snapshot",
            sandbox_id=handle.sandbox_id,
            snapshot_id=snapshot_id,
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
            modal_sandbox = modal.Sandbox.from_id(sandbox_id)
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
        session_config: SessionConfig | dict,
        sandbox_id: str | None = None,
        control_plane_url: str = "",
        sandbox_auth_token: str = "",
        clone_token: str | None = None,
        user_env_vars: dict[str, str] | None = None,
        timeout_seconds: int = DEFAULT_SANDBOX_TIMEOUT_SECONDS,
    ) -> SandboxHandle:
        """
        Create a new sandbox from a filesystem snapshot Image.

        The OpenCode session resumes with full workspace state intact.
        Git clone is skipped since the workspace already has all changes.

        Args:
            snapshot_image_id: Modal Image ID from snapshot_filesystem()
            session_config: Session configuration (SessionConfig or dict)
            sandbox_id: Optional sandbox ID (generated if not provided)
            control_plane_url: URL for the control plane
            sandbox_auth_token: Auth token for the sandbox
            clone_token: VCS clone token for git operations

        Returns:
            SandboxHandle for the restored sandbox
        """
        start_time = time.time()

        # Handle both SessionConfig and dict
        if isinstance(session_config, dict):
            repo_owner = session_config.get("repo_owner", "")
            repo_name = session_config.get("repo_name", "")
            provider = session_config.get("provider", "anthropic")
            model = session_config.get("model", "claude-sonnet-4-6")
            session_id = session_config.get("session_id", "")
        else:
            repo_owner = session_config.repo_owner
            repo_name = session_config.repo_name
            provider = session_config.provider
            model = session_config.model
            session_id = session_config.session_id

        # Use provided sandbox_id or generate one
        if not sandbox_id:
            sandbox_id = f"sandbox-{repo_owner}-{repo_name}-{int(time.time() * 1000)}"

        # Lookup the image by ID
        image = modal.Image.from_id(snapshot_image_id)

        # Prepare environment variables (user vars first, system vars override)
        env_vars: dict[str, str] = {}

        if user_env_vars:
            env_vars.update(user_env_vars)

        env_vars.update(
            {
                "PYTHONUNBUFFERED": "1",
                "SANDBOX_ID": sandbox_id,
                "CONTROL_PLANE_URL": control_plane_url,
                "SANDBOX_AUTH_TOKEN": sandbox_auth_token,
                "REPO_OWNER": repo_owner,
                "REPO_NAME": repo_name,
                "RESTORED_FROM_SNAPSHOT": "true",  # Signal to skip git clone
                "SESSION_CONFIG": json.dumps(
                    {
                        "session_id": session_id,
                        "repo_owner": repo_owner,
                        "repo_name": repo_name,
                        "provider": provider,
                        "model": model,
                    }
                ),
            }
        )

        self._inject_vcs_env_vars(env_vars, clone_token)

        # Create the sandbox from the snapshot image
        sandbox = modal.Sandbox.create(
            "python",
            "-m",
            "sandbox.entrypoint",
            image=image,  # Use the snapshot image directly
            app=app,
            secrets=[llm_secrets],
            timeout=timeout_seconds,
            workdir="/workspace",
            env=env_vars,
        )

        modal_object_id = sandbox.object_id

        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "sandbox.restore",
            sandbox_id=sandbox_id,
            modal_object_id=modal_object_id,
            snapshot_image_id=snapshot_image_id,
            repo_owner=repo_owner,
            repo_name=repo_name,
            duration_ms=duration_ms,
            outcome="success",
        )

        return SandboxHandle(
            sandbox_id=sandbox_id,
            modal_sandbox=sandbox,
            status=SandboxStatus.WARMING,
            created_at=time.time(),
            snapshot_id=snapshot_image_id,
            modal_object_id=modal_object_id,
        )

    async def maintain_warm_pool(
        self,
        repo_owner: str,
        repo_name: str,
        pool_size: int = 2,
    ) -> None:
        """
        Maintain a pool of warm sandboxes for a high-volume repo.

        Args:
            repo_owner: GitHub repository owner
            repo_name: GitHub repository name
            pool_size: Number of warm sandboxes to maintain
        """
        repo_key = self._get_repo_key(repo_owner, repo_name)

        if repo_key not in self._warm_pools:
            self._warm_pools[repo_key] = []

        current_size = len(self._warm_pools[repo_key])

        # Create additional warm sandboxes if needed
        for _ in range(pool_size - current_size):
            handle = await self.warm_sandbox(repo_owner, repo_name)
            self._warm_pools[repo_key].append(handle)

    async def cleanup_stale_pools(
        self,
        max_age_seconds: float = 1800,  # 30 minutes
    ) -> None:
        """
        Clean up stale sandboxes from warm pools.

        Sandboxes older than max_age_seconds are terminated
        to prevent using outdated code.

        Args:
            max_age_seconds: Maximum age before sandbox is considered stale
        """
        now = time.time()

        for repo_key, pool in self._warm_pools.items():
            fresh_sandboxes = []
            for handle in pool:
                if now - handle.created_at > max_age_seconds:
                    await handle.terminate()
                else:
                    fresh_sandboxes.append(handle)
            self._warm_pools[repo_key] = fresh_sandboxes


# Global sandbox manager instance
sandbox_manager = SandboxManager()

"""
Sandbox lifecycle management for Open-Inspect (Daytona backend).

This module handles:
- Creating sandboxes via Daytona SDK
- Pre-warming sandboxes for faster startup
- Taking snapshots (tarball to S3)
- Restoring sandboxes from S3 snapshots
- Managing sandbox pools for high-volume repos
"""

import json
import os
import time
from dataclasses import dataclass

from daytona_sdk import Daytona, CreateSandboxFromImageParams

from ..config import Config
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
    provider_sandbox: object  # Daytona sandbox object
    status: SandboxStatus
    created_at: float
    snapshot_id: str | None = None
    provider_object_id: str | None = None  # Daytona's internal sandbox ID

    def get_logs(self) -> str:
        """Get sandbox logs."""
        try:
            result = self.provider_sandbox.process.exec("cat /tmp/sandbox.log")
            return result.output if hasattr(result, "output") else str(result)
        except Exception:
            return ""

    async def terminate(self) -> None:
        """Terminate the sandbox."""
        try:
            self.provider_sandbox.delete()
        except Exception as e:
            log.warn("sandbox.terminate_error", sandbox_id=self.sandbox_id, exc=e)


class DaytonaSandboxManager:
    """
    Manages sandbox lifecycle for Open-Inspect sessions using Daytona SDK.

    Responsibilities:
    - Create sandboxes from snapshots or fresh images
    - Warm sandboxes proactively when user starts typing
    - Take snapshots for session persistence (tarball to S3)
    - Maintain warm pools for high-volume repos
    """

    def __init__(self, daytona: Daytona, s3_client, config: Config):
        self.daytona = daytona
        self.s3 = s3_client
        self.config = config
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
            # Support GHES: use GITHUB_HOSTNAME if set, otherwise default to github.com
            env_vars["VCS_HOST"] = os.environ.get("GITHUB_HOSTNAME", "github.com").lower().rstrip("/")
            env_vars["VCS_CLONE_USERNAME"] = "x-access-token"

        if clone_token:
            env_vars["VCS_CLONE_TOKEN"] = clone_token
            if scm_provider == "github":
                # Required by gh CLI and git push operations in the sandbox
                env_vars["GITHUB_APP_TOKEN"] = clone_token
                env_vars["GITHUB_TOKEN"] = clone_token

    def _build_env_vars(self, config: SandboxConfig) -> dict[str, str]:
        """Build environment variables for a sandbox."""
        env_vars: dict[str, str] = {}

        if config.user_env_vars:
            env_vars.update(config.user_env_vars)

        # Use provided sandbox_id from control plane, or generate one
        sandbox_id = config.sandbox_id or f"sandbox-{config.repo_owner}-{config.repo_name}-{int(time.time() * 1000)}"

        env_vars.update(
            {
                "PYTHONUNBUFFERED": "1",
                "SANDBOX_ID": sandbox_id,
                "CONTROL_PLANE_URL": config.control_plane_url,
                "SANDBOX_AUTH_TOKEN": config.sandbox_auth_token,
                "REPO_OWNER": config.repo_owner,
                "REPO_NAME": config.repo_name,
            }
        )

        # Inject LLM API key
        if self.config.anthropic_api_key:
            env_vars["ANTHROPIC_API_KEY"] = self.config.anthropic_api_key

        self._inject_vcs_env_vars(env_vars, config.clone_token)

        if config.session_config:
            env_vars["SESSION_CONFIG"] = config.session_config.model_dump_json()

        if config.repo_image_id:
            env_vars["FROM_REPO_IMAGE"] = "true"
            env_vars["REPO_IMAGE_SHA"] = config.repo_image_sha or ""

        return env_vars

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
        sandbox_id = config.sandbox_id or f"sandbox-{config.repo_owner}-{config.repo_name}-{int(time.time() * 1000)}"

        env_vars = self._build_env_vars(config)
        env_vars["SANDBOX_ID"] = sandbox_id  # Ensure consistency

        # Determine image to use
        image = config.repo_image_id or self.config.sandbox_base_image

        # Create the sandbox via Daytona SDK
        # Daytona overrides the image CMD with its own daemon, so we start
        # the Open-Inspect entrypoint as a background process after creation.
        sandbox = self.daytona.create(CreateSandboxFromImageParams(
            image=image,
            env_vars=env_vars,
        ))

        # Start the Open-Inspect supervisor entrypoint inside the sandbox.
        # The Daytona daemon is PID 1; we run our entrypoint alongside it
        # via docker exec (the bridge has the Docker socket mounted).
        try:
            import asyncio
            proc = await asyncio.create_subprocess_exec(
                "docker", "exec", "-d",
                "-e", "PYTHONPATH=/app",
                sandbox.id,
                "python", "-m", "sandbox.entrypoint",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
            if proc.returncode == 0:
                log.info("sandbox.entrypoint_started", sandbox_id=sandbox_id, provider_id=sandbox.id)
            else:
                log.warning("sandbox.entrypoint_start_failed", sandbox_id=sandbox_id, stderr=(stderr or b"").decode()[:500])
        except Exception as e:
            log.warning("sandbox.entrypoint_start_error", sandbox_id=sandbox_id, error=str(e))

        provider_object_id = sandbox.id
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "sandbox.create",
            sandbox_id=sandbox_id,
            provider_object_id=provider_object_id,
            repo_owner=config.repo_owner,
            repo_name=config.repo_name,
            duration_ms=duration_ms,
            outcome="success",
        )

        return SandboxHandle(
            sandbox_id=sandbox_id,
            provider_sandbox=sandbox,
            status=SandboxStatus.WARMING,
            created_at=time.time(),
            snapshot_id=config.snapshot_id,
            provider_object_id=provider_object_id,
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
        - Always uses sandbox_base_image (builds start from the universal base)
        """
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

        sandbox = self.daytona.create(CreateSandboxFromImageParams(
            image=self.config.sandbox_base_image,
            env_vars=env_vars,
        ))

        provider_object_id = sandbox.id
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "sandbox.create_build",
            sandbox_id=sandbox_id,
            provider_object_id=provider_object_id,
            repo_owner=repo_owner,
            repo_name=repo_name,
            duration_ms=duration_ms,
            outcome="success",
        )

        return SandboxHandle(
            sandbox_id=sandbox_id,
            provider_sandbox=sandbox,
            status=SandboxStatus.WARMING,
            created_at=time.time(),
            provider_object_id=provider_object_id,
        )

    async def warm_sandbox(
        self,
        repo_owner: str,
        repo_name: str,
        control_plane_url: str = "",
    ) -> SandboxHandle:
        """
        Pre-warm a sandbox for a repository.

        Called when user starts typing to reduce latency.

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

    async def take_snapshot(
        self,
        sandbox_id: str,
        session_id: str,
        reason: str,
    ) -> str:
        """
        Take a filesystem snapshot of a sandbox.

        Creates a tarball of the sandbox's /workspace directory and
        uploads it to S3. Returns the S3 key that can be used to
        restore the sandbox later.

        Args:
            sandbox_id: The Daytona sandbox ID
            session_id: Session ID for organizing snapshots
            reason: Reason for the snapshot

        Returns:
            S3 key (image_id) that can be used to restore the sandbox later
        """
        start_time = time.time()

        # Get the sandbox from Daytona
        sandbox = self.daytona.get(sandbox_id)

        # Create tarball of workspace
        sandbox.process.exec("tar czf /tmp/snapshot.tar.gz -C /workspace .")

        # Download the tarball from sandbox
        snapshot_data = sandbox.filesystem.download("/tmp/snapshot.tar.gz")

        # Upload to S3
        snapshot_key = f"snapshots/{session_id}/{int(time.time() * 1000)}.tar.gz"
        self.s3.put_object(
            Bucket=self.config.s3_bucket,
            Key=snapshot_key,
            Body=snapshot_data,
        )

        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "sandbox.snapshot",
            sandbox_id=sandbox_id,
            session_id=session_id,
            snapshot_key=snapshot_key,
            reason=reason,
            duration_ms=duration_ms,
            outcome="success",
        )

        return snapshot_key

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
        Create a new sandbox from a filesystem snapshot stored in S3.

        The workspace state is restored from the tarball.
        Git clone is skipped since the workspace already has all changes.

        Args:
            snapshot_image_id: S3 key from take_snapshot()
            session_config: Session configuration (SessionConfig or dict)
            sandbox_id: Optional sandbox ID (generated if not provided)
            control_plane_url: URL for the control plane
            sandbox_auth_token: Auth token for the sandbox
            clone_token: VCS clone token for git operations
            user_env_vars: User-defined env vars (repo secrets)
            timeout_seconds: Sandbox timeout

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

        # Inject LLM API key
        if self.config.anthropic_api_key:
            env_vars["ANTHROPIC_API_KEY"] = self.config.anthropic_api_key

        self._inject_vcs_env_vars(env_vars, clone_token)

        # Create fresh sandbox
        sandbox = self.daytona.create(CreateSandboxFromImageParams(
            image=self.config.sandbox_base_image,
            env_vars=env_vars,
        ))

        provider_object_id = sandbox.id

        # Download snapshot from S3 and restore into sandbox
        obj = self.s3.get_object(Bucket=self.config.s3_bucket, Key=snapshot_image_id)
        snapshot_data = obj["Body"].read()

        # Upload tarball to sandbox and extract
        sandbox.filesystem.upload(snapshot_data, "/tmp/snapshot.tar.gz")
        sandbox.process.exec("tar xzf /tmp/snapshot.tar.gz -C /workspace")

        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "sandbox.restore",
            sandbox_id=sandbox_id,
            provider_object_id=provider_object_id,
            snapshot_image_id=snapshot_image_id,
            repo_owner=repo_owner,
            repo_name=repo_name,
            duration_ms=duration_ms,
            outcome="success",
        )

        return SandboxHandle(
            sandbox_id=sandbox_id,
            provider_sandbox=sandbox,
            status=SandboxStatus.WARMING,
            created_at=time.time(),
            snapshot_id=snapshot_image_id,
            provider_object_id=provider_object_id,
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

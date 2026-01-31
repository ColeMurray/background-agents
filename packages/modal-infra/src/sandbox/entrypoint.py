#!/usr/bin/env python3
"""
Sandbox entrypoint - manages OpenCode server and bridge lifecycle.

Runs as PID 1 inside the sandbox. Responsibilities:
1. Perform git sync with latest code
2. Start OpenCode server
3. Start bridge process for control plane communication
4. Monitor processes and restart on crash with exponential backoff
5. Handle graceful shutdown on SIGTERM/SIGINT
"""

import asyncio
import json
import os
import shutil
import signal
import time
from pathlib import Path

import httpx


class SandboxSupervisor:
    """
    Supervisor process for sandbox lifecycle management.

    Manages:
    - Git synchronization with base branch
    - OpenCode server process
    - Bridge process for control plane communication
    - Process monitoring with crash recovery
    """

    # Configuration
    OPENCODE_PORT = 4096
    HEALTH_CHECK_TIMEOUT = 30.0
    MAX_RESTARTS = 5
    BACKOFF_BASE = 2.0
    BACKOFF_MAX = 60.0

    def __init__(self):
        self.opencode_process: asyncio.subprocess.Process | None = None
        self.bridge_process: asyncio.subprocess.Process | None = None
        self.shutdown_event = asyncio.Event()
        self.git_sync_complete = asyncio.Event()
        self.opencode_ready = asyncio.Event()

        # Configuration from environment (set by Modal/SandboxManager)
        self.sandbox_id = os.environ.get("SANDBOX_ID", "unknown")
        self.control_plane_url = os.environ.get("CONTROL_PLANE_URL", "")
        self.sandbox_token = os.environ.get("SANDBOX_AUTH_TOKEN", "")
        self.repo_owner = os.environ.get("REPO_OWNER", "")
        self.repo_name = os.environ.get("REPO_NAME", "")
        self.github_app_token = os.environ.get("GITHUB_APP_TOKEN", "")

        # Parse session config if provided
        session_config_json = os.environ.get("SESSION_CONFIG", "{}")
        self.session_config = json.loads(session_config_json)

        # Paths
        self.workspace_path = Path("/workspace")
        self.repo_path = self.workspace_path / self.repo_name
        self.session_id_file = Path("/tmp/opencode-session-id")

    async def perform_git_sync(self) -> bool:
        """
        Clone repository if needed, then synchronize with latest changes.

        Returns:
            True if sync completed successfully, False otherwise
        """
        # Debug: Print all relevant environment variables
        print("[supervisor] Git sync environment:")
        print(f"[supervisor]   REPO_OWNER={self.repo_owner!r}")
        print(f"[supervisor]   REPO_NAME={self.repo_name!r}")
        print(f"[supervisor]   repo_path={self.repo_path}")
        print(f"[supervisor]   SESSION_CONFIG={os.environ.get('SESSION_CONFIG', 'NOT SET')}")
        print(
            f"[supervisor]   GITHUB_APP_TOKEN={'<set>' if self.github_app_token else '<not set>'}"
        )
        print(f"[supervisor] Starting git sync for {self.repo_owner}/{self.repo_name}")

        # Clone the repository if it doesn't exist
        if not self.repo_path.exists():
            print(f"[supervisor] Repository not found at {self.repo_path}, cloning...")

            if not self.repo_owner or not self.repo_name:
                print("[supervisor] No repository configured, skipping clone")
                self.git_sync_complete.set()
                return True

            # Use authenticated URL if GitHub App token is available
            if self.github_app_token:
                clone_url = f"https://x-access-token:{self.github_app_token}@github.com/{self.repo_owner}/{self.repo_name}.git"
                print("[supervisor] Cloning from authenticated URL (token hidden)")
            else:
                clone_url = f"https://github.com/{self.repo_owner}/{self.repo_name}.git"
                print(f"[supervisor] Cloning from {clone_url} (no auth token)")

            result = await asyncio.create_subprocess_exec(
                "git",
                "clone",
                "--depth",
                "1",
                clone_url,
                str(self.repo_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await result.communicate()

            if result.returncode != 0:
                print(f"[supervisor] Git clone failed: {stderr.decode()}")
                self.git_sync_complete.set()
                return False

            print(f"[supervisor] Repository cloned successfully to {self.repo_path}")

        try:
            # Configure remote URL with auth token if available
            if self.github_app_token:
                auth_url = f"https://x-access-token:{self.github_app_token}@github.com/{self.repo_owner}/{self.repo_name}.git"
                await asyncio.create_subprocess_exec(
                    "git",
                    "remote",
                    "set-url",
                    "origin",
                    auth_url,
                    cwd=self.repo_path,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                print("[supervisor] Configured remote with auth token")

            # Fetch latest changes
            result = await asyncio.create_subprocess_exec(
                "git",
                "fetch",
                "origin",
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await result.wait()

            if result.returncode != 0:
                stderr = await result.stderr.read() if result.stderr else b""
                print(f"[supervisor] Git fetch failed: {stderr.decode()}")
                return False

            # Get the base branch (default to main)
            base_branch = self.session_config.get("branch", "main")

            # Rebase onto latest
            result = await asyncio.create_subprocess_exec(
                "git",
                "rebase",
                f"origin/{base_branch}",
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await result.wait()

            if result.returncode != 0:
                # Check if there's actually a rebase in progress before trying to abort
                rebase_merge = self.repo_path / ".git" / "rebase-merge"
                rebase_apply = self.repo_path / ".git" / "rebase-apply"
                if rebase_merge.exists() or rebase_apply.exists():
                    await asyncio.create_subprocess_exec(
                        "git",
                        "rebase",
                        "--abort",
                        cwd=self.repo_path,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                    )
                    print("[supervisor] Git rebase aborted")
                print("[supervisor] Git rebase failed, continuing with current state")

            # Get current SHA
            result = await asyncio.create_subprocess_exec(
                "git",
                "rev-parse",
                "HEAD",
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
            )
            stdout, _ = await result.communicate()
            current_sha = stdout.decode().strip()
            print(f"[supervisor] Git sync complete, HEAD: {current_sha}")

            self.git_sync_complete.set()
            return True

        except Exception as e:
            print(f"[supervisor] Git sync error: {e}")
            self.git_sync_complete.set()  # Allow agent to proceed anyway
            return False

    async def start_opencode(self) -> None:
        """Start OpenCode server with configuration."""
        print("[supervisor] Starting OpenCode server...")

        # Build OpenCode config from session settings
        # Model format is "provider/model", e.g. "anthropic/claude-sonnet-4-5"
        provider = self.session_config.get("provider", "anthropic")
        model = self.session_config.get("model", "claude-sonnet-4-5")
        opencode_config = {
            "model": f"{provider}/{model}",
        }

        # Check for user's Anthropic OAuth token (for user-specific API access)
        # OAuth tokens (sk-ant-oat01-...) cannot be used as x-api-key headers.
        # Instead, write auth.json so OpenCode uses its native OAuth auth flow.
        # The shared ANTHROPIC_API_KEY remains as a fallback.
        anthropic_oauth_token = os.environ.get("ANTHROPIC_OAUTH_TOKEN")
        if anthropic_oauth_token:
            print("[supervisor] Using user's Anthropic OAuth token for API access")

            # Write the auth.json file for OpenCode's native OAuth auth
            opencode_data_dir = Path.home() / ".local" / "share" / "opencode"
            opencode_data_dir.mkdir(parents=True, exist_ok=True)
            auth_json_path = opencode_data_dir / "auth.json"
            auth_data = {
                "accessToken": anthropic_oauth_token,
                "expiresAt": int(time.time() * 1000) + 3600000,  # 1 hour from now
            }
            auth_json_path.write_text(json.dumps(auth_data))
            print(f"[supervisor] Wrote OAuth token to {auth_json_path}")
        else:
            print("[supervisor] No OAuth token, using shared ANTHROPIC_API_KEY")

        api_key = os.environ.get("ANTHROPIC_API_KEY", "")
        print(
            f"[supervisor] ANTHROPIC_API_KEY is "
            f"{'set (' + str(len(api_key)) + ' chars)' if api_key else 'NOT SET'}"
        )

        # Determine working directory - use repo path if cloned, otherwise /workspace
        workdir = self.workspace_path
        if self.repo_path.exists() and (self.repo_path / ".git").exists():
            workdir = self.repo_path
            print(f"[supervisor] Using repo directory as workdir: {workdir}")
        else:
            print(f"[supervisor] Repo not found, using workspace: {workdir}")

        # Set up .opencode directory for custom tools
        opencode_dir = workdir / ".opencode"
        tool_dest = opencode_dir / "tool"
        tool_source = Path("/app/sandbox/inspect-plugin.js")

        if tool_source.exists():
            # Create .opencode/tool directory
            tool_dest.mkdir(parents=True, exist_ok=True)
            shutil.copy(tool_source, tool_dest / "create-pull-request.js")
            print("[supervisor] Copied create-pull-request tool")

            # Create node_modules symlink to global modules so OpenCode doesn't try to install
            # and so imports resolve correctly via NODE_PATH
            node_modules = opencode_dir / "node_modules"
            global_modules = Path("/usr/lib/node_modules")
            if not node_modules.exists() and global_modules.exists():
                try:
                    node_modules.symlink_to(global_modules)
                    print("[supervisor] Symlinked .opencode/node_modules to global modules")
                except Exception as e:
                    print(f"[supervisor] Warning: Could not symlink node_modules: {e}")

            # Create a minimal package.json so OpenCode sees this as a configured directory
            package_json = opencode_dir / "package.json"
            if not package_json.exists():
                package_json.write_text('{"name": "opencode-tools", "type": "module"}')

        env = {
            **os.environ,
            "OPENCODE_CONFIG_CONTENT": json.dumps(opencode_config),
        }

        # Start OpenCode server in the repo directory
        self.opencode_process = await asyncio.create_subprocess_exec(
            "opencode",
            "serve",
            "--port",
            str(self.OPENCODE_PORT),
            "--hostname",
            "0.0.0.0",
            "--print-logs",  # Print logs to stdout for debugging
            cwd=workdir,  # Start in repo directory
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )

        # Start log forwarder
        asyncio.create_task(self._forward_opencode_logs())

        # Wait for health check
        await self._wait_for_health()
        self.opencode_ready.set()
        print("[supervisor] OpenCode server is ready")

    async def _forward_opencode_logs(self) -> None:
        """Forward OpenCode stdout to supervisor stdout."""
        if not self.opencode_process or not self.opencode_process.stdout:
            return

        try:
            async for line in self.opencode_process.stdout:
                print(f"[opencode] {line.decode().rstrip()}")
        except Exception as e:
            print(f"[supervisor] Log forwarding error: {e}")

    async def _wait_for_health(self) -> None:
        """Poll health endpoint until server is ready."""
        health_url = f"http://localhost:{self.OPENCODE_PORT}/global/health"
        start_time = time.time()

        async with httpx.AsyncClient() as client:
            while time.time() - start_time < self.HEALTH_CHECK_TIMEOUT:
                if self.shutdown_event.is_set():
                    raise RuntimeError("Shutdown requested during startup")

                try:
                    resp = await client.get(health_url, timeout=2.0)
                    if resp.status_code == 200:
                        return
                except httpx.ConnectError:
                    pass
                except Exception as e:
                    print(f"[supervisor] Health check error: {e}")

                await asyncio.sleep(0.5)

        raise RuntimeError("OpenCode server failed to become healthy")

    async def start_bridge(self) -> None:
        """Start the agent bridge process."""
        print("[supervisor] Starting bridge process...")

        if not self.control_plane_url:
            print("[supervisor] No control plane URL, skipping bridge")
            return

        # Wait for OpenCode to be ready
        await self.opencode_ready.wait()

        # Get session_id from config (required for WebSocket connection)
        session_id = self.session_config.get("session_id", "")
        if not session_id:
            print("[supervisor] Warning: No session_id in config, bridge may fail to connect")

        # Run bridge as a module (works with relative imports)
        self.bridge_process = await asyncio.create_subprocess_exec(
            "python",
            "-m",
            "sandbox.bridge",
            "--sandbox-id",
            self.sandbox_id,
            "--session-id",
            session_id,
            "--control-plane",
            self.control_plane_url,
            "--token",
            self.sandbox_token,
            "--opencode-port",
            str(self.OPENCODE_PORT),
            env=os.environ,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )

        # Start log forwarder for bridge
        asyncio.create_task(self._forward_bridge_logs())
        print("[supervisor] Bridge process started")

        # Check if bridge crashed immediately during startup
        await asyncio.sleep(0.5)
        if self.bridge_process.returncode is not None:
            # Bridge exited immediately - read any error output
            stdout, _ = await self.bridge_process.communicate()
            print(
                f"[supervisor] Bridge crashed on startup! Exit code: {self.bridge_process.returncode}"
            )
            if stdout:
                print(f"[supervisor] Bridge output: {stdout.decode()}")

    async def _forward_bridge_logs(self) -> None:
        """Forward bridge stdout to supervisor stdout."""
        if not self.bridge_process or not self.bridge_process.stdout:
            return

        try:
            async for line in self.bridge_process.stdout:
                # Bridge already prefixes its output with [bridge], don't double it
                print(line.decode().rstrip())
        except Exception as e:
            print(f"[supervisor] Bridge log forwarding error: {e}")

    async def monitor_processes(self) -> None:
        """Monitor child processes and restart on crash."""
        restart_count = 0

        while not self.shutdown_event.is_set():
            # Check OpenCode process
            if self.opencode_process and self.opencode_process.returncode is not None:
                exit_code = self.opencode_process.returncode
                restart_count += 1

                print(
                    f"[supervisor] OpenCode crashed (exit code: {exit_code}, restart #{restart_count})"
                )

                if restart_count > self.MAX_RESTARTS:
                    print("[supervisor] Max restarts exceeded, shutting down")
                    await self._report_fatal_error(
                        f"OpenCode crashed {restart_count} times, giving up"
                    )
                    self.shutdown_event.set()
                    break

                # Exponential backoff
                delay = min(self.BACKOFF_BASE**restart_count, self.BACKOFF_MAX)
                print(f"[supervisor] Restarting OpenCode in {delay:.1f}s...")

                await asyncio.sleep(delay)
                self.opencode_ready.clear()
                await self.start_opencode()

            # Check bridge process
            if self.bridge_process and self.bridge_process.returncode is not None:
                exit_code = self.bridge_process.returncode
                print(f"[supervisor] Bridge exited (exit code: {exit_code}), restarting...")
                await self.start_bridge()

            await asyncio.sleep(1.0)

    async def _report_fatal_error(self, message: str) -> None:
        """Report a fatal error to the control plane."""
        print(f"[supervisor] FATAL: {message}")

        if not self.control_plane_url:
            return

        try:
            async with httpx.AsyncClient() as client:
                await client.post(
                    f"{self.control_plane_url}/sandbox/{self.sandbox_id}/error",
                    json={"error": message, "fatal": True},
                    headers={"Authorization": f"Bearer {self.sandbox_token}"},
                    timeout=5.0,
                )
        except Exception as e:
            print(f"[supervisor] Failed to report error: {e}")

    async def configure_git_identity(self) -> None:
        """Configure git identity from session owner."""
        git_user = self.session_config.get("git_user")
        if not git_user or not self.repo_path.exists():
            return

        try:
            await asyncio.create_subprocess_exec(
                "git",
                "config",
                "--local",
                "user.name",
                git_user["name"],
                cwd=self.repo_path,
            )
            await asyncio.create_subprocess_exec(
                "git",
                "config",
                "--local",
                "user.email",
                git_user["email"],
                cwd=self.repo_path,
            )
            print(f"[supervisor] Git identity configured: {git_user['name']} <{git_user['email']}>")
        except Exception as e:
            print(f"[supervisor] Failed to configure git identity: {e}")

    async def _quick_git_fetch(self) -> None:
        """
        Quick fetch to check if we're behind after snapshot restore.

        When restored from a snapshot, the workspace already has all changes.
        This just checks if the remote has new commits since the snapshot.
        """
        if not self.repo_path.exists():
            print("[supervisor] No repo path, skipping quick git fetch")
            return

        try:
            # Configure remote URL with auth token if available
            if self.github_app_token:
                auth_url = f"https://x-access-token:{self.github_app_token}@github.com/{self.repo_owner}/{self.repo_name}.git"
                await asyncio.create_subprocess_exec(
                    "git",
                    "remote",
                    "set-url",
                    "origin",
                    auth_url,
                    cwd=self.repo_path,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                print("[supervisor] Configured remote with auth token for quick fetch")

            # Fetch from origin
            result = await asyncio.create_subprocess_exec(
                "git",
                "fetch",
                "--quiet",
                "origin",
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await result.communicate()

            if result.returncode != 0:
                print(f"[supervisor] Quick git fetch failed: {stderr.decode()}")
                return

            # Check if we're behind the remote
            # Get the current branch
            result = await asyncio.create_subprocess_exec(
                "git",
                "rev-parse",
                "--abbrev-ref",
                "HEAD",
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await result.communicate()
            current_branch = stdout.decode().strip()

            # Check if we have an upstream set
            result = await asyncio.create_subprocess_exec(
                "git",
                "rev-list",
                "--count",
                f"HEAD..origin/{current_branch}",
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await result.communicate()

            if result.returncode == 0:
                commits_behind = int(stdout.decode().strip() or "0")
                if commits_behind > 0:
                    print(
                        f"[supervisor] Snapshot is {commits_behind} commits behind origin/{current_branch}"
                    )
                    print("[supervisor] Note: Not auto-rebasing to preserve snapshot state")
                else:
                    print("[supervisor] Snapshot is up to date with remote")
            else:
                print("[supervisor] Could not check commits behind (may not have upstream)")

        except Exception as e:
            print(f"[supervisor] Quick git fetch error: {e}")

    async def run(self) -> None:
        """Main supervisor loop."""
        print(f"[supervisor] Starting sandbox {self.sandbox_id}")
        print(f"[supervisor] Repository: {self.repo_owner}/{self.repo_name}")

        # Check if restored from snapshot
        restored_from_snapshot = os.environ.get("RESTORED_FROM_SNAPSHOT") == "true"
        if restored_from_snapshot:
            print("[supervisor] Restored from snapshot, will skip full git sync")

        # Set up signal handlers
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, lambda s=sig: asyncio.create_task(self._handle_signal(s)))

        try:
            # Phase 1: Git sync
            if restored_from_snapshot:
                # Restored from snapshot - just do a quick fetch to check for updates
                print("[supervisor] Restored from snapshot, performing quick git fetch")
                await self._quick_git_fetch()
                self.git_sync_complete.set()
            else:
                # Fresh sandbox - full git clone and sync
                await self.perform_git_sync()

            # Phase 2: Configure git identity (if repo was cloned)
            await self.configure_git_identity()

            # Phase 3: Start OpenCode server (in repo directory)
            await self.start_opencode()

            # Phase 4: Start bridge (after OpenCode is ready)
            await self.start_bridge()

            # Phase 5: Monitor processes
            print("[supervisor] Entering monitor_processes loop")
            await self.monitor_processes()

        except Exception as e:
            print(f"[supervisor] Error: {e}")
            await self._report_fatal_error(str(e))

        finally:
            await self.shutdown()

    async def _handle_signal(self, sig: signal.Signals) -> None:
        """Handle shutdown signal."""
        import traceback

        print(f"[supervisor] Received signal {sig.name}, shutting down...")
        print(f"[supervisor] Signal received from: {traceback.format_stack()[-3]}")
        self.shutdown_event.set()

    async def shutdown(self) -> None:
        """Graceful shutdown of all processes."""
        print("[supervisor] Shutting down...")

        # Terminate bridge first
        if self.bridge_process and self.bridge_process.returncode is None:
            print("[supervisor] Terminating bridge...")
            self.bridge_process.terminate()
            try:
                await asyncio.wait_for(self.bridge_process.wait(), timeout=5.0)
            except TimeoutError:
                self.bridge_process.kill()

        # Terminate OpenCode
        if self.opencode_process and self.opencode_process.returncode is None:
            print("[supervisor] Terminating OpenCode...")
            self.opencode_process.terminate()
            try:
                await asyncio.wait_for(self.opencode_process.wait(), timeout=10.0)
            except TimeoutError:
                self.opencode_process.kill()

        print("[supervisor] Shutdown complete")


async def main():
    """Entry point for the sandbox supervisor."""
    supervisor = SandboxSupervisor()
    await supervisor.run()


if __name__ == "__main__":
    asyncio.run(main())

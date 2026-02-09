#!/usr/bin/env python3
"""
Sandbox entrypoint - supervisor process that runs as PID 1 inside the K8s pod.

Responsibilities:
1. Git clone and sync (with GitHub App token authentication)
2. Run repo-specific setup (.openinspect/setup.sh)
3. Start OpenCode server
4. Start bridge process for control plane communication
5. Monitor processes and restart on failure with exponential backoff
6. Handle graceful shutdown on SIGTERM/SIGINT
"""

import asyncio
import json
import os
import shutil
import signal
import time
from pathlib import Path

import httpx

from .log_config import configure_logging, get_logger

configure_logging()


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
    SETUP_SCRIPT_PATH = ".openinspect/setup.sh"
    DEFAULT_SETUP_TIMEOUT_SECONDS = 300

    def __init__(self):
        self.opencode_process: asyncio.subprocess.Process | None = None
        self.bridge_process: asyncio.subprocess.Process | None = None
        self.shutdown_event = asyncio.Event()
        self.git_sync_complete = asyncio.Event()
        self.opencode_ready = asyncio.Event()

        # Configuration from environment variables (set by K8s pod spec)
        self.sandbox_id = os.environ.get("SANDBOX_ID", "unknown")
        self.control_plane_url = os.environ.get("CONTROL_PLANE_URL", "")
        self.sandbox_token = os.environ.get("SANDBOX_AUTH_TOKEN", "")
        self.repo_owner = os.environ.get("REPO_OWNER", "")
        self.repo_name = os.environ.get("REPO_NAME", "")
        self.session_id = os.environ.get("SESSION_ID", "")
        self.provider = os.environ.get("PROVIDER", "anthropic")
        self.model = os.environ.get("MODEL", "claude-haiku-4-5")
        self.git_user_name = os.environ.get("GIT_USER_NAME", "")
        self.git_user_email = os.environ.get("GIT_USER_EMAIL", "")
        self.opencode_session_id = os.environ.get("OPENCODE_SESSION_ID", "")
        self.branch = os.environ.get("BRANCH", "main")

        # GitHub App credentials for generating installation tokens
        self.github_app_id = os.environ.get("GITHUB_APP_ID", "")
        self.github_app_private_key = os.environ.get("GITHUB_APP_PRIVATE_KEY", "")
        self.github_app_installation_id = os.environ.get("GITHUB_APP_INSTALLATION_ID", "")

        # Pre-generated token (if provided directly instead of App credentials)
        self.github_app_token = os.environ.get("GITHUB_APP_TOKEN", "")

        # Paths
        self.workspace_path = Path("/workspace")
        self.repo_path = self.workspace_path / self.repo_name
        self.session_id_file = Path("/tmp/opencode-session-id")

        # Logger
        self.log = get_logger(
            "supervisor",
            service="sandbox",
            sandbox_id=self.sandbox_id,
            session_id=self.session_id,
        )

    def _generate_github_token(self) -> str:
        """
        Generate a GitHub App installation token if credentials are available.

        Falls back to the pre-configured GITHUB_APP_TOKEN if App credentials
        are not provided.

        Returns:
            GitHub access token, or empty string if no credentials available.
        """
        # If we already have a token, use it
        if self.github_app_token:
            return self.github_app_token

        # Try to generate from GitHub App credentials
        if self.github_app_id and self.github_app_private_key and self.github_app_installation_id:
            try:
                from ..auth.github_app import generate_installation_token

                token = generate_installation_token(
                    app_id=self.github_app_id,
                    private_key=self.github_app_private_key,
                    installation_id=self.github_app_installation_id,
                )
                self.log.info("github.token_generated")
                return token
            except Exception as e:
                self.log.error("github.token_generation_error", exc=e)
                return ""

        return ""

    async def perform_git_sync(self) -> bool:
        """
        Clone repository if needed, then synchronize with latest changes.

        Returns:
            True if sync completed successfully, False otherwise
        """
        # Generate a fresh GitHub token for git operations
        github_token = self._generate_github_token()

        self.log.debug(
            "git.sync_start",
            repo_owner=self.repo_owner,
            repo_name=self.repo_name,
            repo_path=str(self.repo_path),
            has_github_token=bool(github_token),
        )

        # Clone the repository if it doesn't exist
        if not self.repo_path.exists():
            if not self.repo_owner or not self.repo_name:
                self.log.info("git.skip_clone", reason="no_repo_configured")
                self.git_sync_complete.set()
                return True

            self.log.info(
                "git.clone_start",
                repo_owner=self.repo_owner,
                repo_name=self.repo_name,
                authenticated=bool(github_token),
            )

            # Use authenticated URL if GitHub App token is available
            if github_token:
                clone_url = f"https://x-access-token:{github_token}@github.com/{self.repo_owner}/{self.repo_name}.git"
            else:
                clone_url = f"https://github.com/{self.repo_owner}/{self.repo_name}.git"

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
                self.log.error(
                    "git.clone_error",
                    stderr=stderr.decode(),
                    exit_code=result.returncode,
                )
                self.git_sync_complete.set()
                return False

            self.log.info("git.clone_complete", repo_path=str(self.repo_path))

        try:
            # Configure remote URL with auth token if available
            if github_token:
                auth_url = f"https://x-access-token:{github_token}@github.com/{self.repo_owner}/{self.repo_name}.git"
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
                self.log.error(
                    "git.fetch_error",
                    stderr=stderr.decode(),
                    exit_code=result.returncode,
                )
                return False

            # Get the base branch
            base_branch = self.branch

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
                self.log.warn("git.rebase_error", base_branch=base_branch)

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
            self.log.info("git.sync_complete", head_sha=current_sha)

            self.git_sync_complete.set()
            return True

        except Exception as e:
            self.log.error("git.sync_error", exc=e)
            self.git_sync_complete.set()  # Allow agent to proceed anyway
            return False

    async def start_opencode(self) -> None:
        """Start OpenCode server with configuration."""
        self.log.info("opencode.start")

        # Build OpenCode config from environment
        # Model format is "provider/model", e.g. "anthropic/claude-haiku-4-5"
        opencode_config = {
            "model": f"{self.provider}/{self.model}",
            "permission": {
                "*": {
                    "*": "allow",
                },
            },
        }

        # Determine working directory - use repo path if cloned, otherwise /workspace
        workdir = self.workspace_path
        if self.repo_path.exists() and (self.repo_path / ".git").exists():
            workdir = self.repo_path

        # Set up .opencode directory for custom tools
        opencode_dir = workdir / ".opencode"
        tool_dest = opencode_dir / "tool"
        tool_source = Path("/opt/sandbox/src/sandbox/inspect-plugin.js")

        if tool_source.exists():
            # Create .opencode/tool directory
            tool_dest.mkdir(parents=True, exist_ok=True)
            shutil.copy(tool_source, tool_dest / "create-pull-request.js")

            # Create node_modules symlink to global modules so OpenCode doesn't try to install
            # and so imports resolve correctly via NODE_PATH
            node_modules = opencode_dir / "node_modules"
            global_modules = Path("/usr/lib/node_modules")
            if not node_modules.exists() and global_modules.exists():
                try:
                    node_modules.symlink_to(global_modules)
                except Exception as e:
                    self.log.warn("opencode.symlink_error", exc=e)

            # Create a minimal package.json so OpenCode sees this as a configured directory
            package_json = opencode_dir / "package.json"
            if not package_json.exists():
                package_json.write_text('{"name": "opencode-tools", "type": "module"}')

        # Build SESSION_CONFIG JSON for the inspect-plugin.js tool
        # (it reads session_id from this env var)
        session_config_json = json.dumps({
            "session_id": self.session_id,
            "repo_owner": self.repo_owner,
            "repo_name": self.repo_name,
            "provider": self.provider,
            "model": self.model,
        })

        env = {
            **os.environ,
            "OPENCODE_CONFIG_CONTENT": json.dumps(opencode_config),
            "SESSION_CONFIG": session_config_json,
            # Disable OpenCode's question tool in headless mode. The tool blocks
            # on a Promise waiting for user input via the HTTP API, but the bridge
            # has no channel to relay questions to the web client and back. Without
            # this, the session hangs until the SSE inactivity timeout (120s).
            "OPENCODE_CLIENT": "serve",
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
        self.log.info("opencode.ready")

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
                    self.log.debug("opencode.health_check_error", exc=e)

                await asyncio.sleep(0.5)

        raise RuntimeError("OpenCode server failed to become healthy")

    async def start_bridge(self) -> None:
        """Start the agent bridge process."""
        self.log.info("bridge.start")

        if not self.control_plane_url:
            self.log.info("bridge.skip", reason="no_control_plane_url")
            return

        # Wait for OpenCode to be ready
        await self.opencode_ready.wait()

        if not self.session_id:
            self.log.info("bridge.skip", reason="no_session_id")
            return

        # Run bridge as a module (works with relative imports)
        self.bridge_process = await asyncio.create_subprocess_exec(
            "python",
            "-m",
            "src.sandbox.bridge",
            "--sandbox-id",
            self.sandbox_id,
            "--session-id",
            self.session_id,
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
        self.log.info("bridge.started")

        # Check if bridge exited immediately during startup
        await asyncio.sleep(0.5)
        if self.bridge_process.returncode is not None:
            exit_code = self.bridge_process.returncode
            # Bridge exited immediately - read any error output
            stdout, _ = await self.bridge_process.communicate()
            if exit_code == 0:
                self.log.warn("bridge.early_exit", exit_code=exit_code)
            else:
                self.log.error(
                    "bridge.startup_crash",
                    exit_code=exit_code,
                    output=stdout.decode() if stdout else "",
                )

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
        bridge_restart_count = 0

        while not self.shutdown_event.is_set():
            # Check OpenCode process
            if self.opencode_process and self.opencode_process.returncode is not None:
                exit_code = self.opencode_process.returncode
                restart_count += 1

                self.log.error(
                    "opencode.crash",
                    exit_code=exit_code,
                    restart_count=restart_count,
                )

                if restart_count > self.MAX_RESTARTS:
                    self.log.error(
                        "opencode.max_restarts",
                        restart_count=restart_count,
                    )
                    await self._report_fatal_error(
                        f"OpenCode crashed {restart_count} times, giving up"
                    )
                    self.shutdown_event.set()
                    break

                # Exponential backoff
                delay = min(self.BACKOFF_BASE**restart_count, self.BACKOFF_MAX)
                self.log.info(
                    "opencode.restart",
                    delay_s=round(delay, 1),
                    restart_count=restart_count,
                )

                await asyncio.sleep(delay)
                self.opencode_ready.clear()
                await self.start_opencode()

            # Check bridge process
            if self.bridge_process and self.bridge_process.returncode is not None:
                exit_code = self.bridge_process.returncode

                if exit_code == 0:
                    # Graceful exit: shutdown command, session terminated, or fatal
                    # connection error. Propagate shutdown rather than restarting.
                    self.log.info(
                        "bridge.graceful_exit",
                        exit_code=exit_code,
                    )
                    self.shutdown_event.set()
                    break
                else:
                    # Crash: restart with backoff and retry limit
                    bridge_restart_count += 1
                    self.log.error(
                        "bridge.crash",
                        exit_code=exit_code,
                        restart_count=bridge_restart_count,
                    )

                    if bridge_restart_count > self.MAX_RESTARTS:
                        self.log.error(
                            "bridge.max_restarts",
                            restart_count=bridge_restart_count,
                        )
                        await self._report_fatal_error(
                            f"Bridge crashed {bridge_restart_count} times, giving up"
                        )
                        self.shutdown_event.set()
                        break

                    delay = min(self.BACKOFF_BASE**bridge_restart_count, self.BACKOFF_MAX)
                    self.log.info(
                        "bridge.restart",
                        delay_s=round(delay, 1),
                        restart_count=bridge_restart_count,
                    )
                    await asyncio.sleep(delay)
                    await self.start_bridge()

            await asyncio.sleep(1.0)

    async def _report_fatal_error(self, message: str) -> None:
        """Report a fatal error to the control plane."""
        self.log.error("supervisor.fatal", message=message)

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
            self.log.error("supervisor.report_error_failed", exc=e)

    async def configure_git_identity(self) -> None:
        """Configure git identity from environment variables."""
        if not self.git_user_name or not self.git_user_email:
            self.log.debug("git.identity_skip", reason="no_git_user_configured")
            return

        if not self.repo_path.exists():
            return

        try:
            await asyncio.create_subprocess_exec(
                "git",
                "config",
                "--local",
                "user.name",
                self.git_user_name,
                cwd=self.repo_path,
            )
            await asyncio.create_subprocess_exec(
                "git",
                "config",
                "--local",
                "user.email",
                self.git_user_email,
                cwd=self.repo_path,
            )
            self.log.info(
                "git.identity_configured",
                git_name=self.git_user_name,
                git_email=self.git_user_email,
            )
        except Exception as e:
            self.log.error("git.identity_error", exc=e)

    async def run_setup_script(self) -> bool:
        """
        Run .openinspect/setup.sh if it exists in the cloned repo.

        Non-fatal: failures are logged but don't block startup.

        Returns:
            True if script succeeded or was not present, False on failure/timeout.
        """
        setup_script = self.repo_path / self.SETUP_SCRIPT_PATH

        if not setup_script.exists():
            self.log.debug("setup.skip", reason="no_setup_script", path=str(setup_script))
            return True

        try:
            timeout_seconds = int(
                os.environ.get("SETUP_TIMEOUT_SECONDS", str(self.DEFAULT_SETUP_TIMEOUT_SECONDS))
            )
        except ValueError:
            timeout_seconds = self.DEFAULT_SETUP_TIMEOUT_SECONDS

        self.log.info("setup.start", script=str(setup_script), timeout_seconds=timeout_seconds)

        try:
            process = await asyncio.create_subprocess_exec(
                "bash",
                str(setup_script),
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env=os.environ.copy(),
            )

            try:
                stdout, _ = await asyncio.wait_for(process.communicate(), timeout=timeout_seconds)
            except TimeoutError:
                process.kill()
                stdout = await process.stdout.read() if process.stdout else b""
                await process.wait()
                output_tail = "\n".join(stdout.decode(errors="replace").splitlines()[-50:])
                self.log.error(
                    "setup.timeout",
                    timeout_seconds=timeout_seconds,
                    output_tail=output_tail,
                    script=str(setup_script),
                )
                return False

            output_tail = "\n".join(
                (stdout.decode(errors="replace") if stdout else "").splitlines()[-50:]
            )

            if process.returncode == 0:
                self.log.debug("setup.complete", exit_code=0, output_tail=output_tail)
                return True
            else:
                self.log.error(
                    "setup.failed",
                    exit_code=process.returncode,
                    output_tail=output_tail,
                    script=str(setup_script),
                )
                return False

        except Exception as e:
            self.log.error("setup.error", exc=e, script=str(setup_script))
            return False

    async def run(self) -> None:
        """Main supervisor loop."""
        startup_start = time.time()

        self.log.info(
            "supervisor.start",
            repo_owner=self.repo_owner,
            repo_name=self.repo_name,
            session_id=self.session_id,
            provider=self.provider,
            model=self.model,
        )

        # Set up signal handlers
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, lambda s=sig: asyncio.create_task(self._handle_signal(s)))

        git_sync_success = False
        opencode_ready = False
        try:
            # Phase 1: Git clone and sync
            git_sync_success = await self.perform_git_sync()

            # Phase 2: Configure git identity
            await self.configure_git_identity()

            # Phase 3: Run repo setup script
            setup_success = await self.run_setup_script()

            # Phase 4: Start OpenCode server (in repo directory)
            await self.start_opencode()
            opencode_ready = True

            # Phase 5: Start bridge (after OpenCode is ready)
            await self.start_bridge()

            # Emit sandbox.startup event
            duration_ms = int((time.time() - startup_start) * 1000)
            self.log.info(
                "sandbox.startup",
                repo_owner=self.repo_owner,
                repo_name=self.repo_name,
                git_sync_success=git_sync_success,
                setup_success=setup_success,
                opencode_ready=opencode_ready,
                duration_ms=duration_ms,
                outcome="success",
            )

            # Phase 6: Monitor processes
            await self.monitor_processes()

        except Exception as e:
            self.log.error("supervisor.error", exc=e)
            await self._report_fatal_error(str(e))

        finally:
            await self.shutdown()

    async def _handle_signal(self, sig: signal.Signals) -> None:
        """Handle shutdown signal."""
        self.log.info("supervisor.signal", signal_name=sig.name)
        self.shutdown_event.set()

    async def shutdown(self) -> None:
        """Graceful shutdown of all processes."""
        self.log.info("supervisor.shutdown_start")

        # Terminate bridge first
        if self.bridge_process and self.bridge_process.returncode is None:
            self.bridge_process.terminate()
            try:
                await asyncio.wait_for(self.bridge_process.wait(), timeout=5.0)
            except TimeoutError:
                self.bridge_process.kill()

        # Terminate OpenCode
        if self.opencode_process and self.opencode_process.returncode is None:
            self.opencode_process.terminate()
            try:
                await asyncio.wait_for(self.opencode_process.wait(), timeout=10.0)
            except TimeoutError:
                self.opencode_process.kill()

        self.log.info("supervisor.shutdown_complete")


async def main():
    """Entry point for the sandbox supervisor."""
    supervisor = SandboxSupervisor()
    await supervisor.run()


if __name__ == "__main__":
    asyncio.run(main())

#!/usr/bin/env python3
"""
Sandbox entrypoint - manages OpenCode server and bridge lifecycle.

Runs as PID 1 inside the sandbox. Responsibilities:
1. Perform git sync with latest code
2. Run repo hooks (setup/start) based on boot mode
3. Start OpenCode server
4. Start bridge process for control plane communication
5. Monitor processes and restart on crash with exponential backoff
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
    START_SCRIPT_PATH = ".openinspect/start.sh"
    DEFAULT_SETUP_TIMEOUT_SECONDS = 300
    DEFAULT_START_TIMEOUT_SECONDS = 120

    def __init__(self):
        self.opencode_process: asyncio.subprocess.Process | None = None
        self.bridge_process: asyncio.subprocess.Process | None = None
        self.shutdown_event = asyncio.Event()
        self.git_sync_complete = asyncio.Event()
        self.opencode_ready = asyncio.Event()
        self.boot_mode = "unknown"

        # Configuration from environment (set by Modal/SandboxManager)
        self.sandbox_id = os.environ.get("SANDBOX_ID", "unknown")
        self.control_plane_url = os.environ.get("CONTROL_PLANE_URL", "")
        self.sandbox_token = os.environ.get("SANDBOX_AUTH_TOKEN", "")
        self.repo_owner = os.environ.get("REPO_OWNER", "")
        self.repo_name = os.environ.get("REPO_NAME", "")
        self.vcs_host = os.environ.get("VCS_HOST", "github.com")
        self.vcs_clone_username = os.environ.get("VCS_CLONE_USERNAME", "x-access-token")
        self.vcs_clone_token = os.environ.get("VCS_CLONE_TOKEN") or os.environ.get(
            "GITHUB_APP_TOKEN", ""
        )

        # Parse session config if provided
        session_config_json = os.environ.get("SESSION_CONFIG", "{}")
        self.session_config = json.loads(session_config_json)

        # Paths
        self.workspace_path = Path("/workspace")
        self.repo_path = self.workspace_path / self.repo_name
        self.session_id_file = Path("/tmp/opencode-session-id")

        # Logger
        session_id = self.session_config.get("session_id", "")
        self.log = get_logger(
            "supervisor",
            service="sandbox",
            sandbox_id=self.sandbox_id,
            session_id=session_id,
        )

    @property
    def base_branch(self) -> str:
        """The branch to clone/fetch — defaults to 'main'."""
        return self.session_config.get("branch", "main")

    def _build_repo_url(self, authenticated: bool = True) -> str:
        """Build the HTTPS URL for the repository, optionally with clone credentials."""
        if authenticated and self.vcs_clone_token:
            return f"https://{self.vcs_clone_username}:{self.vcs_clone_token}@{self.vcs_host}/{self.repo_owner}/{self.repo_name}.git"
        return f"https://{self.vcs_host}/{self.repo_owner}/{self.repo_name}.git"

    async def perform_git_sync(self) -> bool:
        """
        Clone repository if needed, then synchronize with latest changes.

        Returns:
            True if sync completed successfully, False otherwise
        """
        self.log.debug(
            "git.sync_start",
            repo_owner=self.repo_owner,
            repo_name=self.repo_name,
            repo_path=str(self.repo_path),
            has_clone_token=bool(self.vcs_clone_token),
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
                authenticated=bool(self.vcs_clone_token),
            )

            clone_url = self._build_repo_url()
            image_build_mode = os.environ.get("IMAGE_BUILD_MODE") == "true"
            clone_depth = "100" if image_build_mode else "1"
            base_branch = self.base_branch

            result = await asyncio.create_subprocess_exec(
                "git",
                "clone",
                "--depth",
                clone_depth,
                "--branch",
                base_branch,
                clone_url,
                str(self.repo_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _stdout, stderr = await result.communicate()

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
            if self.vcs_clone_token:
                await asyncio.create_subprocess_exec(
                    "git",
                    "remote",
                    "set-url",
                    "origin",
                    self._build_repo_url(),
                    cwd=self.repo_path,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )

            # Fetch latest changes for the target branch
            base_branch = self.base_branch
            result = await asyncio.create_subprocess_exec(
                "git",
                "fetch",
                "origin",
                base_branch,
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

    def _install_tools(self, workdir: Path) -> None:
        """Copy custom tools into the .opencode/tool directory for OpenCode to discover."""
        opencode_dir = workdir / ".opencode"
        tool_dest = opencode_dir / "tool"

        # Legacy tool (inspect-plugin.js → create-pull-request.js)
        legacy_tool = Path("/app/sandbox/inspect-plugin.js")
        # New tools directory
        tools_dir = Path("/app/sandbox/tools")

        has_tools = legacy_tool.exists() or tools_dir.exists()
        if not has_tools:
            return

        tool_dest.mkdir(parents=True, exist_ok=True)

        if legacy_tool.exists():
            shutil.copy(legacy_tool, tool_dest / "create-pull-request.js")

        # Copy all .js files from tools/ (including _-prefixed internal modules)
        if tools_dir.exists():
            for tool_file in tools_dir.iterdir():
                if tool_file.is_file() and tool_file.suffix == ".js":
                    shutil.copy(tool_file, tool_dest / tool_file.name)

        # Node modules symlink
        node_modules = opencode_dir / "node_modules"
        global_modules = Path("/usr/lib/node_modules")
        if not node_modules.exists() and global_modules.exists():
            try:
                node_modules.symlink_to(global_modules)
            except Exception as e:
                self.log.warn("opencode.symlink_error", exc=e)

        # Minimal package.json
        package_json = opencode_dir / "package.json"
        if not package_json.exists():
            package_json.write_text('{"name": "opencode-tools", "type": "module"}')

    def _setup_openai_oauth(self) -> None:
        """Write OpenCode auth.json for ChatGPT OAuth if refresh token is configured."""
        refresh_token = os.environ.get("OPENAI_OAUTH_REFRESH_TOKEN")
        if not refresh_token:
            return

        try:
            auth_dir = Path.home() / ".local" / "share" / "opencode"
            auth_dir.mkdir(parents=True, exist_ok=True)

            openai_entry = {
                "type": "oauth",
                "refresh": "managed-by-control-plane",
                "access": "",
                "expires": 0,
            }

            account_id = os.environ.get("OPENAI_OAUTH_ACCOUNT_ID")
            if account_id:
                openai_entry["accountId"] = account_id

            auth_file = auth_dir / "auth.json"
            tmp_file = auth_dir / ".auth.json.tmp"

            # Write to a temp file created with 0o600 from the start, then
            # atomically rename so the target is never world-readable.
            fd = os.open(str(tmp_file), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            try:
                os.write(fd, json.dumps({"openai": openai_entry}).encode())
            finally:
                os.close(fd)
            tmp_file.replace(auth_file)

            self.log.info("openai_oauth.setup")
        except Exception as e:
            self.log.warn("openai_oauth.setup_error", exc=e)

    async def start_opencode(self) -> None:
        """Start OpenCode server with configuration."""
        self._setup_openai_oauth()
        self.log.info("opencode.start")

        # Build OpenCode config from session settings
        # Model format is "provider/model", e.g. "anthropic/claude-sonnet-4-6"
        provider = self.session_config.get("provider", "anthropic")
        model = self.session_config.get("model", "claude-sonnet-4-6")
        opencode_config = {
            "model": f"{provider}/{model}",
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

        self._install_tools(workdir)

        # Deploy codex auth proxy plugin if OpenAI OAuth is configured
        opencode_dir = workdir / ".opencode"
        plugin_source = Path("/app/sandbox/codex-auth-plugin.ts")
        if plugin_source.exists() and os.environ.get("OPENAI_OAUTH_REFRESH_TOKEN"):
            plugin_dir = opencode_dir / "plugins"
            plugin_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy(plugin_source, plugin_dir / "codex-auth-plugin.ts")
            self.log.info("openai_oauth.plugin_deployed")

        env = {
            **os.environ,
            "OPENCODE_CONFIG_CONTENT": json.dumps(opencode_config),
            # Disable OpenCode's question tool in headless mode. The tool blocks
            # on a Promise waiting for user input via the HTTP API, but the bridge
            # has no channel to relay questions to the web client and back. Without
            # this, the session hangs until the SSE inactivity timeout (120s).
            # See: https://github.com/anomalyco/opencode/blob/19b1222cd/packages/opencode/src/tool/registry.ts#L100
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

        # Get session_id from config (required for WebSocket connection)
        session_id = self.session_config.get("session_id", "")
        if not session_id:
            self.log.info("bridge.skip", reason="no_session_id")
            return

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

    def _hook_env(self) -> dict[str, str]:
        """Build environment for startup hooks."""
        env = os.environ.copy()
        env["OPENINSPECT_BOOT_MODE"] = self.boot_mode
        return env

    async def _run_hook(
        self,
        *,
        hook_name: str,
        relative_script_path: str,
        timeout_env_var: str,
        default_timeout_seconds: int,
    ) -> bool:
        """
        Run a repo hook script if present.

        Returns:
            True if script succeeded or was not present, False on failure/timeout.
        """
        script_path = self.repo_path / relative_script_path
        start_time = time.time()

        if not script_path.exists():
            self.log.debug(
                f"{hook_name}.skip",
                reason="no_script",
                path=str(script_path),
                boot_mode=self.boot_mode,
            )
            return True

        try:
            timeout_seconds = int(os.environ.get(timeout_env_var, str(default_timeout_seconds)))
        except ValueError:
            timeout_seconds = default_timeout_seconds

        self.log.info(
            f"{hook_name}.start",
            script=str(script_path),
            timeout_seconds=timeout_seconds,
            boot_mode=self.boot_mode,
        )

        try:
            process = await asyncio.create_subprocess_exec(
                "bash",
                str(script_path),
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env=self._hook_env(),
            )

            try:
                stdout, _ = await asyncio.wait_for(process.communicate(), timeout=timeout_seconds)
            except TimeoutError:
                process.kill()
                stdout = await process.stdout.read() if process.stdout else b""
                await process.wait()
                output_tail = "\n".join(stdout.decode(errors="replace").splitlines()[-50:])
                duration_ms = int((time.time() - start_time) * 1000)
                self.log.error(
                    f"{hook_name}.timeout",
                    timeout_seconds=timeout_seconds,
                    output_tail=output_tail,
                    script=str(script_path),
                    duration_ms=duration_ms,
                    boot_mode=self.boot_mode,
                )
                return False

            output_tail = "\n".join(
                (stdout.decode(errors="replace") if stdout else "").splitlines()[-50:]
            )
            duration_ms = int((time.time() - start_time) * 1000)

            if process.returncode == 0:
                # Avoid logging hook stdout at info level to reduce secret exposure risk.
                self.log.info(
                    f"{hook_name}.complete",
                    exit_code=0,
                    script=str(script_path),
                    duration_ms=duration_ms,
                    boot_mode=self.boot_mode,
                )
                return True

            self.log.error(
                f"{hook_name}.failed",
                exit_code=process.returncode,
                output_tail=output_tail,
                script=str(script_path),
                duration_ms=duration_ms,
                boot_mode=self.boot_mode,
            )
            return False

        except Exception as e:
            duration_ms = int((time.time() - start_time) * 1000)
            self.log.error(
                f"{hook_name}.error",
                exc=e,
                script=str(script_path),
                duration_ms=duration_ms,
                boot_mode=self.boot_mode,
            )
            return False

    async def run_setup_script(self) -> bool:
        """
        Run .openinspect/setup.sh if it exists in the cloned repo.

        Fresh-session failures are non-fatal. Build mode callers may treat
        failures as fatal.

        Returns:
            True if script succeeded or was not present, False on failure/timeout.
        """
        return await self._run_hook(
            hook_name="setup",
            relative_script_path=self.SETUP_SCRIPT_PATH,
            timeout_env_var="SETUP_TIMEOUT_SECONDS",
            default_timeout_seconds=self.DEFAULT_SETUP_TIMEOUT_SECONDS,
        )

    async def run_start_script(self) -> bool:
        """
        Run .openinspect/start.sh if it exists in the repository.

        Returns:
            True if script succeeded or was not present, False on failure/timeout.
        """
        return await self._run_hook(
            hook_name="start",
            relative_script_path=self.START_SCRIPT_PATH,
            timeout_env_var="START_TIMEOUT_SECONDS",
            default_timeout_seconds=self.DEFAULT_START_TIMEOUT_SECONDS,
        )

    async def _quick_git_fetch(self) -> None:
        """
        Quick fetch to check if we're behind after snapshot restore.

        When restored from a snapshot, the workspace already has all changes.
        This just checks if the remote has new commits since the snapshot.
        """
        if not self.repo_path.exists():
            self.log.info("git.quick_fetch_skip", reason="no_repo_path")
            return

        try:
            # Configure remote URL with auth token if available
            if self.vcs_clone_token:
                await asyncio.create_subprocess_exec(
                    "git",
                    "remote",
                    "set-url",
                    "origin",
                    self._build_repo_url(),
                    cwd=self.repo_path,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )

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
            _stdout, stderr = await result.communicate()

            if result.returncode != 0:
                self.log.warn(
                    "git.quick_fetch_error",
                    stderr=stderr.decode(),
                    exit_code=result.returncode,
                )
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
                self.log.info(
                    "git.snapshot_status",
                    commits_behind=commits_behind,
                    current_branch=current_branch,
                )
            else:
                self.log.debug("git.snapshot_status_unknown", reason="no_upstream")

        except Exception as e:
            self.log.error("git.quick_fetch_error", exc=e)

    async def _incremental_git_sync(self) -> bool:
        """
        Fast git sync for repo-image starts. Repo already exists from the build,
        just pull the latest commits (up to 30 minutes of drift).
        """
        if not self.repo_path.exists():
            self.log.warn("git.incremental_sync_skip", reason="no_repo_path")
            self.git_sync_complete.set()
            return False

        try:
            # Update remote URL with fresh clone token
            if self.vcs_clone_token:
                set_url = await asyncio.create_subprocess_exec(
                    "git",
                    "remote",
                    "set-url",
                    "origin",
                    self._build_repo_url(),
                    cwd=self.repo_path,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                await set_url.communicate()
                if set_url.returncode != 0:
                    self.log.warn("git.set_url_failed", exit_code=set_url.returncode)

            # Fetch latest for the target branch
            base_branch = self.base_branch
            result = await asyncio.create_subprocess_exec(
                "git",
                "fetch",
                "origin",
                base_branch,
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _stdout, stderr = await result.communicate()

            if result.returncode != 0:
                self.log.error(
                    "git.incremental_fetch_error",
                    stderr=stderr.decode(),
                    exit_code=result.returncode,
                )
                self.git_sync_complete.set()
                return False
            result = await asyncio.create_subprocess_exec(
                "git",
                "reset",
                "--hard",
                f"origin/{base_branch}",
                cwd=self.repo_path,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            _stdout, stderr = await result.communicate()

            if result.returncode != 0:
                self.log.error(
                    "git.incremental_reset_error",
                    stderr=stderr.decode(),
                    exit_code=result.returncode,
                )

            self.log.info("git.incremental_sync_complete")
            self.git_sync_complete.set()
            return True

        except Exception as e:
            self.log.error("git.incremental_sync_error", exc=e)
            self.git_sync_complete.set()
            return False

    async def run(self) -> None:
        """Main supervisor loop."""
        startup_start = time.time()

        self.log.info(
            "supervisor.start",
            repo_owner=self.repo_owner,
            repo_name=self.repo_name,
        )

        # Detect operating mode
        image_build_mode = os.environ.get("IMAGE_BUILD_MODE") == "true"
        restored_from_snapshot = os.environ.get("RESTORED_FROM_SNAPSHOT") == "true"
        from_repo_image = os.environ.get("FROM_REPO_IMAGE") == "true"

        if image_build_mode:
            self.boot_mode = "build"
        elif restored_from_snapshot:
            self.boot_mode = "snapshot_restore"
        elif from_repo_image:
            self.boot_mode = "repo_image"
        else:
            self.boot_mode = "fresh"

        # Expose boot mode to repo hooks and child processes.
        os.environ["OPENINSPECT_BOOT_MODE"] = self.boot_mode

        if image_build_mode:
            self.log.info("supervisor.image_build_mode")
        elif restored_from_snapshot:
            self.log.info("supervisor.restored_from_snapshot")
        elif from_repo_image:
            repo_image_sha = os.environ.get("REPO_IMAGE_SHA", "unknown")
            self.log.info("supervisor.from_repo_image", build_sha=repo_image_sha)

        # Set up signal handlers
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, lambda s=sig: asyncio.create_task(self._handle_signal(s)))

        git_sync_success = False
        opencode_ready = False
        try:
            # Phase 1: Git sync
            if restored_from_snapshot:
                await self._quick_git_fetch()
                self.git_sync_complete.set()
                git_sync_success = True
            elif from_repo_image:
                git_sync_success = await self._incremental_git_sync()
            else:
                git_sync_success = await self.perform_git_sync()

            # Phase 2: Run setup script only for fresh or build boots.
            setup_success: bool | None = None
            if self.boot_mode in ("fresh", "build"):
                setup_success = await self.run_setup_script()
                if image_build_mode and not setup_success:
                    raise RuntimeError("setup hook failed in build mode")

            # Phase 3: Run runtime start hook for all non-build boots.
            start_success: bool | None = None
            if self.boot_mode != "build":
                start_success = await self.run_start_script()
                if not start_success:
                    raise RuntimeError("start hook failed")
            else:
                start_success = None

            # Image build mode: signal completion, then keep sandbox alive for
            # snapshot_filesystem(). The builder streams stdout, detects this
            # event, snapshots the running sandbox, then terminates us.
            if image_build_mode:
                duration_ms = int((time.time() - startup_start) * 1000)
                self.log.info("image_build.complete", duration_ms=duration_ms)
                await self.shutdown_event.wait()
                return

            # Phase 4: Start OpenCode server (in repo directory)
            await self.start_opencode()
            opencode_ready = True

            # Phase 5: Start bridge (after OpenCode is ready)
            await self.start_bridge()

            # Emit sandbox.startup wide event
            duration_ms = int((time.time() - startup_start) * 1000)
            self.log.info(
                "sandbox.startup",
                repo_owner=self.repo_owner,
                repo_name=self.repo_name,
                boot_mode=self.boot_mode,
                restored_from_snapshot=restored_from_snapshot,
                from_repo_image=from_repo_image,
                git_sync_success=git_sync_success,
                setup_success=setup_success,
                start_success=start_success,
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

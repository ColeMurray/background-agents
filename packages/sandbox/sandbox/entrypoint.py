#!/usr/bin/env python3
"""
Sandbox entrypoint for local Docker mode.

Simplified version of the Modal sandbox entrypoint. Runs as PID 1 inside the
Docker container. The git worktree is already mounted at /workspace, so no
cloning is needed.

Responsibilities:
1. Verify workspace is a valid git repo
2. Run repo setup script (if .openinspect/setup.sh exists)
3. Start OpenCode server
4. Start bridge process for control plane communication
5. Monitor processes and restart on crash
6. Handle graceful shutdown
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
    Supervisor process for local sandbox lifecycle.

    The workspace is a git worktree mounted from the host, so git clone/sync
    is not needed. The supervisor just starts OpenCode + bridge and monitors them.
    """

    OPENCODE_PORT = 4096
    HEALTH_CHECK_TIMEOUT = 60.0
    MAX_RESTARTS = 5
    BACKOFF_BASE = 2.0
    BACKOFF_MAX = 60.0
    SETUP_SCRIPT_PATH = ".openinspect/setup.sh"
    DEFAULT_SETUP_TIMEOUT_SECONDS = 300

    def __init__(self):
        self.opencode_process: asyncio.subprocess.Process | None = None
        self.bridge_process: asyncio.subprocess.Process | None = None
        self.shutdown_event = asyncio.Event()
        self.opencode_ready = asyncio.Event()

        # Configuration from environment (set by Docker container env)
        self.sandbox_id = os.environ.get(
            "SANDBOX_ID", os.environ.get("SESSION_ID", "unknown")
        )
        self.session_id = os.environ.get("SESSION_ID", "")
        self.control_plane_ws_url = os.environ.get("CONTROL_PLANE_WS_URL", "")
        self.control_plane_url = os.environ.get("CONTROL_PLANE_URL", "")

        # Workspace is pre-mounted
        self.workspace_path = Path("/workspace")

        self.log = get_logger(
            "supervisor",
            service="sandbox",
            sandbox_id=self.sandbox_id,
            session_id=self.session_id,
        )

    async def verify_workspace(self) -> bool:
        """Verify that /workspace is a valid git working tree."""
        git_dir = self.workspace_path / ".git"
        if not git_dir.exists():
            self.log.error("workspace.not_git", path=str(self.workspace_path))
            return False
        self.log.info("workspace.verified", path=str(self.workspace_path))
        return True

    async def run_setup_script(self) -> bool | None:
        """Run .openinspect/setup.sh if it exists."""
        setup_path = self.workspace_path / self.SETUP_SCRIPT_PATH
        if not setup_path.exists():
            return None

        self.log.info("setup.start", path=self.SETUP_SCRIPT_PATH)
        timeout = int(
            os.environ.get("SETUP_TIMEOUT_SECONDS", self.DEFAULT_SETUP_TIMEOUT_SECONDS)
        )

        try:
            process = await asyncio.create_subprocess_exec(
                "bash",
                str(setup_path),
                cwd=self.workspace_path,
                env=os.environ,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )

            try:
                stdout, _ = await asyncio.wait_for(
                    process.communicate(), timeout=timeout
                )
                if stdout:
                    for line in stdout.decode().splitlines():
                        print(f"[setup] {line}")

                if process.returncode == 0:
                    self.log.info("setup.complete")
                    return True
                else:
                    self.log.warn("setup.failed", exit_code=process.returncode)
                    return False
            except asyncio.TimeoutError:
                process.kill()
                self.log.error("setup.timeout", timeout_seconds=timeout)
                return False

        except Exception as e:
            self.log.error("setup.error", exc=e)
            return False

    def _install_tools(self) -> None:
        """Install custom OpenCode tools (inspect-plugin.js for PR creation)."""
        opencode_dir = self.workspace_path / ".opencode"
        tool_dir = opencode_dir / "tool"
        tool_dir.mkdir(parents=True, exist_ok=True)

        plugin_source = Path("/app/sandbox/inspect-plugin.js")
        if plugin_source.exists():
            dest = tool_dir / "inspect-plugin.js"
            shutil.copy(plugin_source, dest)
            self.log.info("tools.installed", plugin="inspect-plugin.js")

            # Symlink node_modules so the tool can find @opencode-ai/plugin and zod
            node_modules_link = opencode_dir / "node_modules"
            if not node_modules_link.exists():
                global_modules = Path("/usr/lib/node_modules")
                if global_modules.exists():
                    node_modules_link.symlink_to(global_modules)

    async def start_opencode(self) -> None:
        """Start OpenCode server."""
        self.log.info("opencode.start")

        # Build minimal OpenCode config
        opencode_config = {
            "permission": {
                "*": {
                    "*": "allow",
                },
            },
        }

        self._install_tools()

        env = {
            **os.environ,
            "OPENCODE_CONFIG_CONTENT": json.dumps(opencode_config),
            "OPENCODE_CLIENT": "serve",
        }

        self.opencode_process = await asyncio.create_subprocess_exec(
            "opencode",
            "serve",
            "--port",
            str(self.OPENCODE_PORT),
            "--hostname",
            "0.0.0.0",
            "--print-logs",
            cwd=self.workspace_path,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )

        asyncio.create_task(self._forward_logs(self.opencode_process, "opencode"))
        await self._wait_for_health()
        self.opencode_ready.set()
        self.log.info("opencode.ready")

    async def _forward_logs(
        self, process: asyncio.subprocess.Process, name: str
    ) -> None:
        """Forward process stdout to supervisor stdout."""
        if not process or not process.stdout:
            return
        try:
            async for line in process.stdout:
                print(f"[{name}] {line.decode().rstrip()}")
        except Exception as e:
            print(f"[supervisor] {name} log forwarding error: {e}")

    async def _wait_for_health(self) -> None:
        """Poll health endpoint until OpenCode server is ready."""
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

        raise RuntimeError(
            f"OpenCode server failed to become healthy within {self.HEALTH_CHECK_TIMEOUT}s"
        )

    async def start_bridge(self) -> None:
        """Start the bridge process for control plane communication."""
        self.log.info("bridge.start")

        ws_url = self.control_plane_ws_url
        if not ws_url:
            # Build from parts
            cp_url = self.control_plane_url
            if not cp_url or not self.session_id:
                self.log.warn("bridge.skip", reason="no_control_plane_url")
                return
            ws_url = f"{cp_url}/sessions/{self.session_id}/ws?type=sandbox"

        await self.opencode_ready.wait()

        self.bridge_process = await asyncio.create_subprocess_exec(
            "python3",
            "-m",
            "sandbox.bridge",
            "--sandbox-id",
            self.sandbox_id,
            "--session-id",
            self.session_id,
            "--control-plane",
            self.control_plane_url or ws_url.rsplit("/sessions/", 1)[0],
            "--token",
            "",  # No auth needed for local mode
            "--opencode-port",
            str(self.OPENCODE_PORT),
            env=os.environ,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )

        asyncio.create_task(self._forward_logs(self.bridge_process, "bridge"))
        self.log.info("bridge.started")

        # Check for immediate exit
        await asyncio.sleep(0.5)
        if self.bridge_process.returncode is not None:
            exit_code = self.bridge_process.returncode
            self.log.error("bridge.startup_crash", exit_code=exit_code)

    async def monitor_processes(self) -> None:
        """Monitor OpenCode and bridge, restart on crash."""
        opencode_restarts = 0
        bridge_restarts = 0

        while not self.shutdown_event.is_set():
            await asyncio.sleep(1.0)

            # Check OpenCode
            if self.opencode_process and self.opencode_process.returncode is not None:
                opencode_restarts += 1
                if opencode_restarts > self.MAX_RESTARTS:
                    self.log.error("opencode.max_restarts_exceeded")
                    break
                backoff = min(self.BACKOFF_BASE**opencode_restarts, self.BACKOFF_MAX)
                self.log.warn(
                    "opencode.crashed",
                    exit_code=self.opencode_process.returncode,
                    restart_in=backoff,
                )
                await asyncio.sleep(backoff)
                self.opencode_ready.clear()
                await self.start_opencode()

            # Check bridge
            if self.bridge_process and self.bridge_process.returncode is not None:
                bridge_restarts += 1
                if bridge_restarts > self.MAX_RESTARTS:
                    self.log.error("bridge.max_restarts_exceeded")
                    break
                backoff = min(self.BACKOFF_BASE**bridge_restarts, self.BACKOFF_MAX)
                self.log.warn(
                    "bridge.crashed",
                    exit_code=self.bridge_process.returncode,
                    restart_in=backoff,
                )
                await asyncio.sleep(backoff)
                await self.start_bridge()

    async def run(self) -> None:
        """Main supervisor loop."""
        startup_start = time.time()
        self.log.info("supervisor.start", session_id=self.session_id)

        # Set up signal handlers
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(
                sig, lambda s=sig: asyncio.create_task(self._handle_signal(s))
            )

        try:
            # Phase 1: Verify workspace
            if not await self.verify_workspace():
                self.log.error("supervisor.no_workspace")
                return

            # Phase 2: Run setup script (optional)
            await self.run_setup_script()

            # Phase 3: Start OpenCode server
            await self.start_opencode()

            # Phase 4: Start bridge
            await self.start_bridge()

            duration_ms = int((time.time() - startup_start) * 1000)
            self.log.info("sandbox.startup", duration_ms=duration_ms, outcome="success")

            # Phase 5: Monitor processes
            await self.monitor_processes()

        except Exception as e:
            self.log.error("supervisor.error", exc=e)
        finally:
            await self.shutdown()

    async def _handle_signal(self, sig: signal.Signals) -> None:
        """Handle shutdown signal."""
        self.log.info("supervisor.signal", signal_name=sig.name)
        self.shutdown_event.set()

    async def shutdown(self) -> None:
        """Graceful shutdown."""
        self.log.info("supervisor.shutdown_start")

        if self.bridge_process and self.bridge_process.returncode is None:
            self.bridge_process.terminate()
            try:
                await asyncio.wait_for(self.bridge_process.wait(), timeout=5.0)
            except TimeoutError:
                self.bridge_process.kill()

        if self.opencode_process and self.opencode_process.returncode is None:
            self.opencode_process.terminate()
            try:
                await asyncio.wait_for(self.opencode_process.wait(), timeout=10.0)
            except TimeoutError:
                self.opencode_process.kill()

        self.log.info("supervisor.shutdown_complete")


async def main():
    """Entry point."""
    supervisor = SandboxSupervisor()
    await supervisor.run()


if __name__ == "__main__":
    asyncio.run(main())

"""Sandbox lifecycle ordering, restart policy, and coordinated shutdown."""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypeVar
from urllib.parse import quote

import httpx

from .constants import BOOT_WARNINGS_FILE_PATH, IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_VAR
from .repo_image_callback import RepoImageBuildCallback
from .runtime_config import BootMode, RuntimeConfig

if TYPE_CHECKING:
    import signal
    from collections.abc import Awaitable, Callable

    from .agent_bridge_process import AgentBridgeProcess
    from .browser_desktop import BrowserDesktop
    from .code_server import CodeServer
    from .managed_skills import ManagedSkillsMaterializer
    from .opencode_server import OpenCodeServer
    from .repository_boot import RepositoryBoot, RepositoryBootResult
    from .web_terminal import WebTerminal

_ResultT = TypeVar("_ResultT")

FATAL_ERROR_REPORT_MAX_ATTEMPTS = 3
FATAL_ERROR_REPORT_BACKOFF_BASE_SECONDS = 2
FATAL_ERROR_REPORT_TIMEOUT_SECONDS = 5.0
FATAL_ERROR_REPORT_MAX_CHARS = 1000


class ImageBuildExecutionCancelled(Exception):
    """A handled process signal interrupted image-build work."""


class SandboxSupervisor:
    """Apply lifecycle policy to the composed runtime services."""

    MAX_RESTARTS = 5
    BACKOFF_BASE = 2.0
    BACKOFF_MAX = 60.0

    def __init__(
        self,
        config: RuntimeConfig,
        repository_boot: RepositoryBoot,
        opencode_server: OpenCodeServer,
        agent_bridge: AgentBridgeProcess,
        code_server: CodeServer,
        web_terminal: WebTerminal,
        browser_desktop: BrowserDesktop,
        managed_skills: ManagedSkillsMaterializer | None,
        shutdown_event: asyncio.Event,
        log: Any,
    ) -> None:
        self.config = config
        self.repository_boot = repository_boot
        self.opencode_server = opencode_server
        self.agent_bridge = agent_bridge
        self.code_server = code_server
        self.web_terminal = web_terminal
        self.browser_desktop = browser_desktop
        self.managed_skills = managed_skills
        self.shutdown_event = shutdown_event
        self.log = log
        self.boot_mode = BootMode.FRESH
        self._desktop_restart_task: asyncio.Task[bool] | None = None
        self._repository_boot_result: RepositoryBootResult | None = None

    async def _report_fatal_error(self, message: str) -> None:
        self.log.error("supervisor.fatal", error_message=message)
        if not self.config.control_plane_url or not self.config.session_id:
            return
        try:
            session_id = quote(self.config.session_id, safe="")
            reported_message = message[-FATAL_ERROR_REPORT_MAX_CHARS:]
            async with httpx.AsyncClient() as client:
                for attempt in range(1, FATAL_ERROR_REPORT_MAX_ATTEMPTS + 1):
                    try:
                        response = await client.post(
                            f"{self.config.control_plane_url.rstrip('/')}/sessions/{session_id}/sandbox-error",
                            json={"error": reported_message, "fatal": True},
                            headers={
                                "Authorization": f"Bearer {self.config.sandbox_token}",
                                "X-Sandbox-ID": self.config.sandbox_id,
                            },
                            timeout=FATAL_ERROR_REPORT_TIMEOUT_SECONDS,
                        )
                        response.raise_for_status()
                        return
                    except Exception as error:
                        if attempt == FATAL_ERROR_REPORT_MAX_ATTEMPTS:
                            raise
                        delay_seconds = FATAL_ERROR_REPORT_BACKOFF_BASE_SECONDS**attempt
                        self.log.warn(
                            "supervisor.report_error_retry",
                            attempt=attempt,
                            max_attempts=FATAL_ERROR_REPORT_MAX_ATTEMPTS,
                            delay_seconds=delay_seconds,
                            exc=error,
                        )
                        await asyncio.sleep(delay_seconds)
        except Exception as error:
            self.log.error("supervisor.report_error_failed", exc=error)

    async def _start_desktop_with_retries(self) -> bool:
        attempt = 0
        while not self.shutdown_event.is_set():
            try:
                await self.browser_desktop.start()
                return True
            except Exception as error:
                attempt += 1
                self.log.warn("vnc.start_failed", attempt=attempt, exc=error)
                await self.browser_desktop.stop()
                if attempt > self.MAX_RESTARTS:
                    self.log.warn("vnc.max_restarts", restart_count=attempt)
                    return False
                if await self._wait_for_shutdown(min(self.BACKOFF_BASE**attempt, self.BACKOFF_MAX)):
                    return False
        return False

    async def _wait_for_shutdown(self, delay: float) -> bool:
        if self.shutdown_event.is_set():
            return True
        try:
            await asyncio.wait_for(self.shutdown_event.wait(), timeout=delay)
        except TimeoutError:
            return False
        return True

    async def _handle_opencode_exit(self, restart_count: int) -> int:
        exit_code = self.opencode_server.exit_code()
        if exit_code is None:
            return restart_count

        restart_count += 1
        self.log.error(
            "opencode.crash",
            exit_code=exit_code,
            restart_count=restart_count,
        )
        if restart_count > self.MAX_RESTARTS:
            self.log.error("opencode.max_restarts", restart_count=restart_count)
            await self._report_fatal_error(f"OpenCode crashed {restart_count} times, giving up")
            self.shutdown_event.set()
            return restart_count

        delay = min(self.BACKOFF_BASE**restart_count, self.BACKOFF_MAX)
        self.log.info(
            "opencode.restart",
            delay_s=round(delay, 1),
            restart_count=restart_count,
        )
        if await self._wait_for_shutdown(delay):
            return restart_count
        if self._repository_boot_result is None:
            raise RuntimeError("OpenCode restart requested before repository boot")
        await self.opencode_server.start(
            self._repository_boot_result.repositories,
            self._repository_boot_result.workdir,
        )
        return restart_count

    async def _handle_bridge_exit(self, restart_count: int) -> int:
        exit_code = self.agent_bridge.exit_code()
        if exit_code is None:
            return restart_count
        if exit_code == 0:
            self.log.info("bridge.graceful_exit", exit_code=exit_code)
            self.shutdown_event.set()
            return restart_count

        restart_count += 1
        self.log.error(
            "bridge.crash",
            exit_code=exit_code,
            restart_count=restart_count,
        )
        if restart_count > self.MAX_RESTARTS:
            self.log.error("bridge.max_restarts", restart_count=restart_count)
            await self._report_fatal_error(f"Bridge crashed {restart_count} times, giving up")
            self.shutdown_event.set()
            return restart_count

        delay = min(self.BACKOFF_BASE**restart_count, self.BACKOFF_MAX)
        self.log.info(
            "bridge.restart",
            delay_s=round(delay, 1),
            restart_count=restart_count,
        )
        if await self._wait_for_shutdown(delay):
            return restart_count
        await self.agent_bridge.start()
        return restart_count

    async def _handle_code_server_exit(self, restart_count: int) -> int:
        exit_code = self.code_server.exit_code()
        if exit_code is None:
            return restart_count

        restart_count += 1
        self.log.warn(
            "code_server.crash",
            exit_code=exit_code,
            restart_count=restart_count,
        )
        if restart_count > self.MAX_RESTARTS:
            self.log.warn("code_server.max_restarts", restart_count=restart_count)
            await self.code_server.stop()
            return restart_count

        if await self._wait_for_shutdown(min(self.BACKOFF_BASE**restart_count, self.BACKOFF_MAX)):
            return restart_count
        try:
            if self._repository_boot_result is None:
                raise RuntimeError("code-server restart requested before repository boot")
            await self.code_server.start(self._repository_boot_result.workdir)
        except Exception as error:
            self.log.warn("code_server.restart_failed", exc=error)
            await self.code_server.stop()
        return restart_count

    async def _handle_terminal_crash(self, restart_count: int) -> int:
        crash = self.web_terminal.crash()
        if not crash:
            return restart_count

        component, exit_code = crash
        restart_count += 1
        self.log.warn(
            "web_terminal.crash",
            component=component,
            exit_code=exit_code,
            restart_count=restart_count,
        )
        await self.web_terminal.stop()
        if restart_count > self.MAX_RESTARTS:
            self.log.warn("web_terminal.max_restarts", restart_count=restart_count)
            return restart_count

        if await self._wait_for_shutdown(min(self.BACKOFF_BASE**restart_count, self.BACKOFF_MAX)):
            return restart_count
        try:
            if self._repository_boot_result is None:
                raise RuntimeError("terminal restart requested before repository boot")
            await self.web_terminal.start(self._repository_boot_result.workdir)
        except Exception as error:
            self.log.warn("web_terminal.restart_failed", exc=error)
            await self.web_terminal.stop()
        return restart_count

    async def _handle_desktop_crash(self, restart_count: int) -> int:
        crash = self.browser_desktop.crash()
        if not crash or (
            self._desktop_restart_task is not None and not self._desktop_restart_task.done()
        ):
            return restart_count

        component, exit_code = crash
        restart_count += 1
        self.log.warn(
            "vnc.crash",
            component=component,
            exit_code=exit_code,
            restart_count=restart_count,
        )
        await self.browser_desktop.stop()
        if restart_count <= self.MAX_RESTARTS:
            self._desktop_restart_task = asyncio.create_task(self._start_desktop_with_retries())
        else:
            self.log.warn("vnc.max_restarts", restart_count=restart_count)
        return restart_count

    async def monitor_processes(self) -> None:
        """Monitor each concrete process owner with its explicit restart policy."""
        opencode_restarts = 0
        bridge_restarts = 0
        code_server_restarts = 0
        terminal_restarts = 0
        desktop_restarts = 0

        while not self.shutdown_event.is_set():
            opencode_restarts = await self._handle_opencode_exit(opencode_restarts)
            if self.shutdown_event.is_set():
                break
            bridge_restarts = await self._handle_bridge_exit(bridge_restarts)
            if self.shutdown_event.is_set():
                break
            code_server_restarts = await self._handle_code_server_exit(code_server_restarts)
            if self.shutdown_event.is_set():
                break
            terminal_restarts = await self._handle_terminal_crash(terminal_restarts)
            if self.shutdown_event.is_set():
                break
            desktop_restarts = await self._handle_desktop_crash(desktop_restarts)
            if await self._wait_for_shutdown(1.0):
                break

    def _image_build_execution_timeout_seconds(self) -> int | None:
        raw_timeout = os.environ.get(IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_VAR)
        if not raw_timeout:
            return None
        try:
            timeout_seconds = int(raw_timeout)
        except ValueError as error:
            raise RuntimeError(
                f"{IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_VAR} must be a positive integer"
            ) from error
        if timeout_seconds <= 0:
            raise RuntimeError(
                f"{IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_VAR} must be a positive integer"
            )
        return timeout_seconds

    async def _run_until_shutdown(
        self, operation_factory: Callable[[], Awaitable[_ResultT]]
    ) -> _ResultT:
        if self.shutdown_event.is_set():
            raise ImageBuildExecutionCancelled
        operation_task = asyncio.ensure_future(operation_factory())
        shutdown_task = asyncio.create_task(self.shutdown_event.wait())
        tasks = {operation_task, shutdown_task}
        try:
            done, _pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            if operation_task in done:
                return operation_task.result()
            raise ImageBuildExecutionCancelled
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _run_image_build_execution(
        self, expected_tunnel_ports: list[int]
    ) -> RepositoryBootResult:
        timeout_seconds = self._image_build_execution_timeout_seconds()
        try:
            async with asyncio.timeout(timeout_seconds):
                return await self._run_until_shutdown(
                    lambda: self.repository_boot.boot(BootMode.BUILD, expected_tunnel_ports)
                )
        except TimeoutError as error:
            raise RuntimeError(
                f"image build exceeded its {timeout_seconds}-second execution timeout"
            ) from error

    async def run(self, repo_image_callback: RepoImageBuildCallback | None = None) -> bool:
        startup_start = time.time()
        self.boot_mode = BootMode.from_env(os.environ)
        os.environ["OPENINSPECT_BOOT_MODE"] = self.boot_mode.value
        self.log.info(
            "supervisor.start",
            repo_owner=self.config.repo_owner,
            repo_name=self.config.repo_name,
        )

        if not self.config.has_repository:
            self.log.info("supervisor.no_repo_configured")
        elif self.boot_mode is BootMode.BUILD:
            self.log.info("supervisor.image_build_mode")
        elif self.boot_mode is BootMode.SNAPSHOT_RESTORE:
            self.log.info("supervisor.restored_from_snapshot")
        elif self.boot_mode is BootMode.REPO_IMAGE:
            self.log.info(
                "supervisor.from_repo_image",
                build_sha=os.environ.get("REPO_IMAGE_SHA", "unknown"),
            )

        if self.boot_mode is BootMode.BUILD and repo_image_callback is None:
            repo_image_callback = RepoImageBuildCallback.from_env(self.log)

        expected_tunnel_ports = self.repository_boot.prepare_tunnel_environment(self.boot_mode)
        Path(BOOT_WARNINGS_FILE_PATH).unlink(missing_ok=True)

        opencode_ready = False
        try:
            if self.boot_mode is BootMode.BUILD:
                boot_result = await self._run_image_build_execution(expected_tunnel_ports)
                if self.shutdown_event.is_set():
                    raise ImageBuildExecutionCancelled
                runtime_version = os.environ.get("SANDBOX_VERSION", "")
                self.log.info(
                    "image_build.complete",
                    duration_ms=int((time.time() - startup_start) * 1000),
                    runtime_version=runtime_version,
                )
                if repo_image_callback:
                    reported = await self._run_until_shutdown(
                        lambda: repo_image_callback.report_success(
                            build_duration_seconds=time.time() - startup_start,
                            repository_shas=boot_result.repository_shas,
                            runtime_version=runtime_version,
                        )
                    )
                    if not reported:
                        raise RuntimeError("repo image build-complete callback failed")
                await self.shutdown_event.wait()
                return True

            try:
                await self.browser_desktop.start()
            except Exception as error:
                self.log.warn("vnc.start_failed", exc=error)
                await self.browser_desktop.stop()

            boot_result = await self.repository_boot.boot(self.boot_mode, expected_tunnel_ports)
            self._repository_boot_result = boot_result

            # Materialization is sandbox-boot work; OpenCode process restarts
            # reuse this tree and must not depend on control-plane availability.
            if self.managed_skills is not None:
                await self.managed_skills.materialize(boot_result.repositories, boot_result.workdir)

            try:
                await self.code_server.start(boot_result.workdir)
            except Exception as error:
                self.log.warn("code_server.start_failed", exc=error)
                await self.code_server.stop()
            try:
                await self.web_terminal.start(boot_result.workdir)
            except Exception as error:
                self.log.warn("web_terminal.start_failed", exc=error)
                await self.web_terminal.stop()

            await self.opencode_server.start(boot_result.repositories, boot_result.workdir)
            opencode_ready = True
            await self.agent_bridge.start()
            self.log.info(
                "sandbox.startup",
                repo_owner=self.config.repo_owner,
                repo_name=self.config.repo_name,
                boot_mode=self.boot_mode.value,
                restored_from_snapshot=self.boot_mode is BootMode.SNAPSHOT_RESTORE,
                from_repo_image=self.boot_mode is BootMode.REPO_IMAGE,
                git_sync_success=boot_result.git_sync_success,
                setup_success=boot_result.setup_success,
                start_success=boot_result.start_success,
                opencode_ready=opencode_ready,
                duration_ms=int((time.time() - startup_start) * 1000),
                outcome="success",
            )
            await self.monitor_processes()
        except ImageBuildExecutionCancelled:
            self.log.info("image_build.cancelled", reason="shutdown_requested")
            return True
        except Exception as error:
            self.log.error("supervisor.error", exc=error)
            if self.boot_mode is BootMode.BUILD and self.shutdown_event.is_set():
                self.log.info("image_build.cancelled", reason="shutdown_requested")
                return True
            if self.boot_mode is BootMode.BUILD and repo_image_callback:
                try:
                    error_message = str(error)
                    await self._run_until_shutdown(
                        lambda: repo_image_callback.report_failure(error_message)
                    )
                except ImageBuildExecutionCancelled:
                    self.log.info("image_build.cancelled", reason="shutdown_requested")
                    return True
            await self._report_fatal_error(str(error))
            return False
        finally:
            await self.shutdown()
        return True

    def request_shutdown(self, sig: signal.Signals) -> None:
        self.log.info("supervisor.signal", signal_name=sig.name)
        self.shutdown_event.set()

    async def shutdown(self) -> None:
        self.log.info("supervisor.shutdown_start")
        if self._desktop_restart_task and not self._desktop_restart_task.done():
            self._desktop_restart_task.cancel()
            await asyncio.gather(self._desktop_restart_task, return_exceptions=True)
        self._desktop_restart_task = None
        await self.agent_bridge.stop()
        await self.web_terminal.stop()
        await self.code_server.stop()
        await self.browser_desktop.stop()
        await self.opencode_server.stop()
        self.log.info("supervisor.shutdown_complete")

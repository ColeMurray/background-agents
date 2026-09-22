"""Foreground-supervised Docker daemon for Docker-enabled sandboxes.

The runtime supervisor owns ``dockerd`` as an ordinary child process: it is
started before repository hooks, watched for the life of the session, stopped
cleanly before an image build reports success, and reaped on shutdown. Nothing
backgrounds or detaches it, and no remote exec ever owns it.

Raw daemon and probe output is deliberately not forwarded into the structured
log: registry errors and container metadata can carry repository secrets. The
daemon writes to a log file inside the sandbox for users; the runtime emits
only fixed lifecycle events.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
from pathlib import Path
from typing import Any

from .process_output import (
    finish_cancellation_cleanup,
    spawn_owned_subprocess,
    terminate_owned_subprocess,
    wait_for_process_exit,
)

DOCKER_SOCKET = "unix:///var/run/docker.sock"
DOCKER_LOG_PATH = "/var/log/dockerd.log"
DOCKER_START_TIMEOUT_SECONDS = 60.0
DOCKER_PROBE_TIMEOUT_SECONDS = 5.0
DOCKER_PROBE_INTERVAL_SECONDS = 0.2
DOCKER_STOP_TIMEOUT_SECONDS = 30.0


class DockerService:
    """Own one ``dockerd`` process from start through clean stop."""

    def __init__(
        self,
        log: Any,
        *,
        start_timeout_seconds: float = DOCKER_START_TIMEOUT_SECONDS,
        stop_timeout_seconds: float = DOCKER_STOP_TIMEOUT_SECONDS,
        log_path: str = DOCKER_LOG_PATH,
    ) -> None:
        self.log = log
        self.start_timeout_seconds = start_timeout_seconds
        self.stop_timeout_seconds = stop_timeout_seconds
        self.log_path = log_path
        self._process: asyncio.subprocess.Process | None = None
        self._stopping = False

    @property
    def stopping(self) -> bool:
        """Whether the last exit was requested, as opposed to an unexpected daemon death."""
        return self._stopping

    async def start(self) -> None:
        """Start the daemon and wait, under a deadline, until ``docker info`` succeeds."""
        if self._process is not None:
            raise RuntimeError("Docker service already started")
        self._stopping = False
        self._process = await self._spawn_daemon()
        try:
            async with asyncio.timeout(self.start_timeout_seconds):
                await self._wait_until_ready()
        except TimeoutError:
            await self.stop()
            raise RuntimeError(
                "Required Docker daemon did not become ready before its startup deadline"
            ) from None
        except BaseException:
            await self.stop()
            raise
        self.log.info("docker.ready")

    async def _spawn_daemon(self) -> asyncio.subprocess.Process:
        # The daemon's own output goes to a file the user can read inside the
        # sandbox; a closed pipe must never be what stops the daemon.
        daemon_log = open(self.log_path, "ab")  # noqa: SIM115 - handed to the child
        try:
            return await spawn_owned_subprocess(
                asyncio.create_subprocess_exec(
                    "dockerd",
                    "--host",
                    DOCKER_SOCKET,
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=daemon_log,
                    stderr=asyncio.subprocess.STDOUT,
                    start_new_session=True,
                )
            )
        finally:
            daemon_log.close()

    async def _wait_until_ready(self) -> None:
        process = self._process
        assert process is not None
        while process.returncode is None:
            if await self._probe() and process.returncode is None:
                return
            await asyncio.sleep(DOCKER_PROBE_INTERVAL_SECONDS)
        raise RuntimeError("Required Docker daemon exited during startup")

    async def _probe(self) -> bool:
        """One bounded ``docker info``; its output is discarded, only the exit code counts."""
        probe = await spawn_owned_subprocess(
            asyncio.create_subprocess_exec(
                "docker",
                "--host",
                DOCKER_SOCKET,
                "info",
                env={
                    "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                    "HOME": "/root",
                },
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                start_new_session=True,
            )
        )
        try:
            async with asyncio.timeout(DOCKER_PROBE_TIMEOUT_SECONDS):
                return await wait_for_process_exit(probe) == 0
        except TimeoutError:
            return False
        finally:
            if probe.returncode is None:
                cleanup = asyncio.create_task(terminate_owned_subprocess(probe))
                await finish_cancellation_cleanup(cleanup)

    async def wait(self) -> int:
        """Block until the daemon exits and return its exit code."""
        process = self._process
        if process is None:
            raise RuntimeError("Docker service is not running")
        return await wait_for_process_exit(process)

    async def prepare_for_snapshot(self) -> None:
        """Stop the daemon cleanly so an image build can be snapshotted.

        Only the daemon leader is signalled: Docker must order container and
        containerd shutdown itself before its own clean exit, so the whole
        group is not killed. A non-zero exit, a timeout, or a daemon that was
        already gone is a failed preparation, never a successful build.
        """
        process = self._process
        if process is None or process.returncode is not None:
            raise RuntimeError("Required Docker daemon exited before build preparation")
        self._stopping = True
        process.send_signal(signal.SIGTERM)
        try:
            async with asyncio.timeout(self.stop_timeout_seconds):
                if await wait_for_process_exit(process) != 0:
                    raise RuntimeError("Docker build preparation did not stop cleanly")
        except TimeoutError:
            await self.stop()
            raise RuntimeError(
                "Docker build preparation exceeded its clean shutdown deadline"
            ) from None
        # A clean daemon exit means it already stopped containerd and BuildKit;
        # anything still alive in the group is a straggler, not a dependency.
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        self._process = None
        # A reusable image must never include secret-bearing daemon diagnostics.
        Path(self.log_path).write_bytes(b"")
        self.log.info("docker.prepared")

    async def stop(self) -> None:
        """Bounded graceful termination, then reap every owned process."""
        process = self._process
        self._process = None
        self._stopping = True
        if process is None:
            return

        async def terminate() -> None:
            if process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    process.send_signal(signal.SIGTERM)
                with contextlib.suppress(TimeoutError):
                    async with asyncio.timeout(self.stop_timeout_seconds):
                        await wait_for_process_exit(process)
            await terminate_owned_subprocess(process)

        cleanup = asyncio.create_task(terminate())
        await finish_cancellation_cleanup(cleanup)
        self.log.info("docker.stopped")

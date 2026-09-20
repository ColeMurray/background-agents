"""One foreground Docker daemon owned by the sandbox supervisor.

Raw daemon/probe output is deliberately not forwarded: container metadata and
registry errors can contain repository secrets. Emit only fixed lifecycle events.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
from typing import Any

from .process_output import (
    finish_cancellation_cleanup,
    spawn_owned_subprocess,
    terminate_owned_subprocess,
    wait_for_process_exit,
)

DOCKER_SOCKET = "unix:///var/run/docker.sock"
DOCKER_CONFIG_PATH = "/opt/openinspect/docker/daemon.json"
DOCKER_START_TIMEOUT_SECONDS = 60.0
DOCKER_PROBE_TIMEOUT_SECONDS = 5.0
DOCKER_STOP_TIMEOUT_SECONDS = 30.0


class DockerService:
    def __init__(
        self,
        log: Any,
        *,
        start_timeout_seconds: float = DOCKER_START_TIMEOUT_SECONDS,
        stop_timeout_seconds: float = DOCKER_STOP_TIMEOUT_SECONDS,
    ) -> None:
        self.log = log
        self.start_timeout_seconds = start_timeout_seconds
        self.stop_timeout_seconds = stop_timeout_seconds
        self._process: asyncio.subprocess.Process | None = None
        self._stopping = False

    @property
    def stopping(self) -> bool:
        return self._stopping

    async def _probe(self) -> bool:
        process = await spawn_owned_subprocess(
            asyncio.create_subprocess_exec(
                "docker",
                "--host",
                DOCKER_SOCKET,
                "info",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                start_new_session=True,
            )
        )
        try:
            async with asyncio.timeout(DOCKER_PROBE_TIMEOUT_SECONDS):
                return await wait_for_process_exit(process) == 0
        finally:
            cleanup = asyncio.create_task(terminate_owned_subprocess(process))
            await finish_cancellation_cleanup(cleanup)

    async def start(self) -> None:
        if self._process is not None:
            raise RuntimeError("Docker service already started")
        self._stopping = False
        try:
            async with asyncio.timeout(self.start_timeout_seconds):
                self._process = await spawn_owned_subprocess(
                    asyncio.create_subprocess_exec(
                        "dockerd",
                        "--config-file",
                        DOCKER_CONFIG_PATH,
                        "--host",
                        DOCKER_SOCKET,
                        "--live-restore=false",
                        stdout=asyncio.subprocess.DEVNULL,
                        stderr=asyncio.subprocess.DEVNULL,
                        start_new_session=True,
                    )
                )
                while self._process.returncode is None:
                    try:
                        ready = await self._probe()
                    except TimeoutError:
                        ready = False
                    if ready and self._process.returncode is None:
                        self.log.info("docker.ready")
                        return
                    await asyncio.sleep(0.2)
                raise RuntimeError("Required Docker daemon exited during startup")
        except TimeoutError as error:
            await self.stop()
            raise RuntimeError(
                "Required Docker daemon did not become ready before its startup deadline"
            ) from error
        except BaseException:
            await self.stop()
            raise

    async def wait(self) -> int:
        if self._process is None:
            raise RuntimeError("Docker service is not running")
        return await wait_for_process_exit(self._process)

    async def prepare_for_snapshot(self) -> None:
        """Verified graceful stop, never a forced kill counted as build success."""
        process = self._process
        if process is None or process.returncode is not None:
            raise RuntimeError("Required Docker daemon exited before build preparation")
        self._stopping = True
        try:
            # Signal the daemon leader, not the whole group: Docker must order
            # container/containerd shutdown itself before its own clean exit.
            process.send_signal(signal.SIGTERM)
            async with asyncio.timeout(self.stop_timeout_seconds):
                if await wait_for_process_exit(process) != 0:
                    raise RuntimeError("Docker build preparation did not stop cleanly")
                # Containerd/BuildKit children must leave the owned group too.
                while True:
                    try:
                        os.killpg(process.pid, 0)
                    except ProcessLookupError:
                        break
                    await asyncio.sleep(0.01)
            self._process = None
            self.log.info("docker.prepared")
        except TimeoutError as error:
            await self.stop()
            raise RuntimeError(
                "Docker build preparation exceeded its clean shutdown deadline"
            ) from error
        except BaseException:
            await self.stop()
            raise

    async def stop(self) -> None:
        self._stopping = True
        process, self._process = self._process, None
        if process is None:
            return

        async def cleanup() -> None:
            if process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    process.send_signal(signal.SIGTERM)
                with contextlib.suppress(TimeoutError):
                    async with asyncio.timeout(self.stop_timeout_seconds):
                        await wait_for_process_exit(process)
            await terminate_owned_subprocess(process)

        await finish_cancellation_cleanup(asyncio.create_task(cleanup()))
        self.log.info("docker.stopped")

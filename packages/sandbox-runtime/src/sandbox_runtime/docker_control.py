"""Local Docker snapshot preparation owned by the runtime supervisor.

Only acknowledged preparation permits capture. Failed preparation restores Docker
in an interactive VM so a later capture can be retried.
"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path
from typing import TYPE_CHECKING

from .docker_service import DOCKER_START_TIMEOUT_SECONDS, DOCKER_STOP_TIMEOUT_SECONDS

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from .docker_service import DockerService

SOCKET_PATH = "/tmp/openinspect-docker-control.sock"
PREPARATION_TIMEOUT_SECONDS = 2 * DOCKER_STOP_TIMEOUT_SECONDS + 5
CONTROL_TIMEOUT_SECONDS = (
    PREPARATION_TIMEOUT_SECONDS + DOCKER_STOP_TIMEOUT_SECONDS + DOCKER_START_TIMEOUT_SECONDS + 10
)


class DockerControl:
    def __init__(
        self,
        service: DockerService,
        path: str = SOCKET_PATH,
        recover: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self.service = service
        self.path = path
        self.recover = recover
        self.prepared = False
        self.stopping = False
        self._lock = asyncio.Lock()
        self._server: asyncio.Server | None = None
        self._handlers: set[asyncio.Task[None]] = set()

    async def start(self) -> None:
        if (
            self.service.stop_timeout_seconds > DOCKER_STOP_TIMEOUT_SECONDS
            or self.service.start_timeout_seconds > DOCKER_START_TIMEOUT_SECONDS
        ):
            raise ValueError("Docker control deadline cannot cover configured daemon timeouts")
        Path(self.path).unlink(missing_ok=True)
        self._server = await asyncio.start_unix_server(self._handle, path=self.path)
        Path(self.path).chmod(0o600)

    async def stop(self) -> None:
        self.stopping = True
        if self._server:
            self._server.close()
        handlers = tuple(self._handlers)
        for task in handlers:
            task.cancel()
        await asyncio.gather(*handlers, return_exceptions=True)
        # No supervisor teardown may stop Docker until an active prepare or
        # recovery has left the same lock used to serialize control requests.
        async with self._lock:
            pass
        if self._server:
            await self._server.wait_closed()
            self._server = None
        Path(self.path).unlink(missing_ok=True)

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        assert task is not None
        self._handlers.add(task)
        started = time.monotonic()
        phase = "read_command"
        try:
            if self.stopping:
                return
            async with asyncio.timeout(CONTROL_TIMEOUT_SECONDS):
                command = await reader.readline()
                phase = "wait_lock"
                async with self._lock:
                    if command == b"prepare\n" and not self.prepared and not self.stopping:
                        phase = "prepare"
                        self.service.log.info("docker.prepare_started")
                        try:
                            async with asyncio.timeout(PREPARATION_TIMEOUT_SECONDS):
                                await self.service.prepare_for_snapshot()
                        except (Exception, asyncio.CancelledError) as error:
                            fields = {
                                "error_type": type(error).__name__,
                                "duration_ms": int((time.monotonic() - started) * 1000),
                                "acknowledgement": "not_confirmed",
                            }
                            if isinstance(error, asyncio.CancelledError):
                                self.service.log.debug("docker.prepare_cancelled", **fields)
                            else:
                                self.service.log.error("docker.prepare_failed", **fields)
                            if self.recover is not None and not self.stopping:
                                phase = "recover"
                                self.service.log.info("docker.recovery_started")
                                try:
                                    await self.recover()
                                except (Exception, asyncio.CancelledError) as recovery_error:
                                    fields = {"error_type": type(recovery_error).__name__}
                                    if isinstance(recovery_error, asyncio.CancelledError):
                                        self.service.log.debug(
                                            "docker.recovery_cancelled", **fields
                                        )
                                    else:
                                        self.service.log.error("docker.recovery_failed", **fields)
                                    raise
                                self.service.log.info("docker.recovery_completed")
                                self.prepared = False
                        else:
                            self.prepared = True
                            self.service.log.info(
                                "docker.prepare_completed",
                                duration_ms=int((time.monotonic() - started) * 1000),
                            )
                    result = (
                        b"prepared\n"
                        if self.prepared
                        and not self.stopping
                        and command in (b"prepare\n", b"status\n")
                        else b"not_prepared\n"
                    )
                phase = "respond"
                writer.write(result)
                await writer.drain()
                if command == b"prepare\n":
                    self.service.log.info(
                        "docker.prepare_acknowledgement",
                        acknowledgement="confirmed" if result == b"prepared\n" else "not_confirmed",
                        duration_ms=int((time.monotonic() - started) * 1000),
                    )
        except (Exception, asyncio.CancelledError) as error:
            # No acknowledgement is a failure, never permission to capture.
            fields = {
                "phase": phase,
                "error_type": type(error).__name__,
                "duration_ms": int((time.monotonic() - started) * 1000),
                "acknowledgement": "not_confirmed",
            }
            if isinstance(error, asyncio.CancelledError):
                self.service.log.debug("docker.control_cancelled", **fields)
            else:
                self.service.log.warn("docker.control_failed", **fields)
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            finally:
                self._handlers.discard(task)


async def request(command: str, path: str = SOCKET_PATH) -> None:
    async with asyncio.timeout(CONTROL_TIMEOUT_SECONDS):
        reader, writer = await asyncio.open_unix_connection(path)
        try:
            writer.write((command + "\n").encode())
            await writer.drain()
            if await reader.readline() != b"prepared\n":
                raise RuntimeError("Docker snapshot requires confirmed shutdown preparation")
        finally:
            writer.close()
            await writer.wait_closed()


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("status", "prepare"):
        raise SystemExit(2)
    asyncio.run(request(sys.argv[1]))

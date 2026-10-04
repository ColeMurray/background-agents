"""Local Docker snapshot preparation owned by the runtime supervisor.

Only acknowledged preparation permits capture. Failed preparation restores Docker
in an interactive VM so a later capture can be retried.
"""

from __future__ import annotations

import asyncio
import sys
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
        try:
            if self.stopping:
                return
            async with asyncio.timeout(CONTROL_TIMEOUT_SECONDS):
                command = await reader.readline()
                async with self._lock:
                    if command == b"prepare\n" and not self.prepared and not self.stopping:
                        try:
                            async with asyncio.timeout(PREPARATION_TIMEOUT_SECONDS):
                                await self.service.prepare_for_snapshot()
                        except (Exception, asyncio.CancelledError) as error:
                            if self.recover is not None and not self.stopping:
                                self.service.log.error("docker.prepare_failed", exc=error)
                                await self.recover()
                                self.prepared = False
                        else:
                            self.prepared = True
                    result = (
                        b"prepared\n"
                        if self.prepared
                        and not self.stopping
                        and command in (b"prepare\n", b"status\n")
                        else b"not_prepared\n"
                    )
                writer.write(result)
                await writer.drain()
        except (Exception, asyncio.CancelledError):
            # No acknowledgement is a failure, never permission to capture.
            pass
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

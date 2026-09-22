"""Local, terminal Docker preparation owned by the runtime supervisor.

VM snapshots are terminal: only acknowledged preparation permits capture.
The provider retires the VM after capture; there is no implicit container restart.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .docker_service import DockerService

SOCKET_PATH = "/tmp/openinspect-docker-control.sock"
CONTROL_TIMEOUT_SECONDS = 45


class DockerControl:
    def __init__(self, service: DockerService, path: str = SOCKET_PATH) -> None:
        self.service = service
        self.path = path
        self.prepared = False
        self._lock = asyncio.Lock()
        self._server: asyncio.Server | None = None

    async def start(self) -> None:
        Path(self.path).unlink(missing_ok=True)
        self._server = await asyncio.start_unix_server(self._handle, path=self.path)
        Path(self.path).chmod(0o600)

    async def stop(self) -> None:
        if self._server:
            self._server.close()
            await self._server.wait_closed()
        Path(self.path).unlink(missing_ok=True)

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            async with asyncio.timeout(CONTROL_TIMEOUT_SECONDS):
                command = await reader.readline()
                async with self._lock:
                    if command == b"prepare\n" and not self.prepared:
                        await self.service.prepare_for_snapshot()
                        self.prepared = True
                    result = (
                        b"prepared\n"
                        if self.prepared and command in (b"prepare\n", b"status\n")
                        else b"not_prepared\n"
                    )
                writer.write(result)
                await writer.drain()
        except (Exception, asyncio.CancelledError):
            # No acknowledgement is a failure, never permission to capture.
            pass
        finally:
            writer.close()
            await writer.wait_closed()


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

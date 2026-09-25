"""Closed supervisor control transport for stopping/starting the owned harness only."""

from __future__ import annotations

import asyncio
import hmac
import json
from pathlib import Path
from typing import Any

CONTROL_SOCKET = "/tmp/open-inspect-harness-control.sock"


class HarnessSwitchControl:
    def __init__(self, owner: Any, token: str) -> None:
        self.owner = owner
        self.token = token
        self.lock = asyncio.Lock()
        self.operation: str | None = None
        self.identity: dict[str, Any] | None = None
        self.applied = False
        self.stopped = False
        self.server: asyncio.Server | None = None

    async def start(self) -> None:
        Path(CONTROL_SOCKET).unlink(missing_ok=True)
        self.server = await asyncio.start_unix_server(self.handle, CONTROL_SOCKET, limit=16384)
        Path(CONTROL_SOCKET).chmod(0o600)

    async def close(self) -> None:
        if self.server:
            self.server.close()
            await self.server.wait_closed()
            Path(CONTROL_SOCKET).unlink(missing_ok=True)

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            async with asyncio.timeout(45):
                request = json.loads(await reader.readline())
                if not isinstance(request.get("token"), str) or not hmac.compare_digest(
                    request["token"], self.token
                ):
                    raise ValueError("unauthorized")
                operation = request.get("operationId")
                if not isinstance(operation, str) or not 1 <= len(operation) <= 128:
                    raise ValueError("invalid operation")
                identity = {
                    key: request.get(key)
                    for key in (
                        "operationId",
                        "provider",
                        "bindingRevision",
                        "generation",
                        "conversationId",
                    )
                }
                async with self.lock:
                    if request.get("action") == "stop":
                        old_generation = self.identity.get("generation") if self.identity else None
                        new_generation = identity.get("generation")
                        advanced = (
                            isinstance(old_generation, dict)
                            and isinstance(new_generation, dict)
                            and old_generation.get("sandboxId") == new_generation.get("sandboxId")
                            and isinstance(new_generation.get("createdAt"), int)
                            and new_generation["createdAt"] > old_generation.get("createdAt", 0)
                        )
                        if old_generation and new_generation != old_generation and not advanced:
                            raise ValueError("stale generation")
                        if self.operation and (
                            self.operation != operation or self.identity != identity
                        ):
                            if not self.applied and not advanced:
                                raise ValueError("operation conflict")
                        if self.operation != operation or self.applied or advanced:
                            self.operation, self.identity, self.applied, self.stopped = (
                                operation,
                                identity,
                                False,
                                False,
                            )
                        if not self.stopped:
                            await self.owner.stop()
                            self.stopped = True
                    elif request.get("action") == "start":
                        if (
                            self.operation != operation
                            or self.identity != identity
                            or not self.stopped
                        ):
                            raise ValueError("operation conflict")
                        if not self.applied:
                            await self.owner.restart_for_provider(identity)
                            self.applied = True
                    else:
                        raise ValueError("unsupported operation")
                writer.write(b'{"ok":true}\n')
                await writer.drain()
        except Exception:
            writer.write(b'{"ok":false}\n')
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()


async def harness_control(action: str, identity: dict[str, Any], token: str) -> None:
    async with asyncio.timeout(45):
        reader, writer = await asyncio.open_unix_connection(CONTROL_SOCKET)
        try:
            writer.write(
                json.dumps({**identity, "action": action, "token": token}).encode() + b"\n"
            )
            await writer.drain()
            if json.loads(await reader.readline()).get("ok") is not True:
                raise RuntimeError("harness switch control failed")
        finally:
            writer.close()
            await writer.wait_closed()

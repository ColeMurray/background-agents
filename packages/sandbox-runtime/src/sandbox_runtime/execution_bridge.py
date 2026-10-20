"""WebSocket bridge for provider-neutral command execution without an agent harness."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
from pathlib import Path
from typing import Any

import websockets
from websockets import ClientConnection, State
from websockets.exceptions import InvalidStatus

from .boot_attach import RECONNECT_BACKOFF_BASE, RECONNECT_MAX_DELAY_SECONDS
from .command_runner import CommandRunner
from .event_forwarder import BufferedEventForwarder
from .log_config import get_logger


class ExecutionBridge:
    """Carries only authorized command envelopes and lifecycle control messages."""

    HEARTBEAT_INTERVAL_SECONDS = 30.0

    def __init__(
        self,
        sandbox_id: str,
        session_id: str,
        control_plane_url: str,
        auth_token: str,
        *,
        workspace_path: Path = Path("/workspace"),
        runner: Any | None = None,
        bridge_instance_id: str = "standalone",
        bridge_restarted: bool = False,
    ) -> None:
        self.sandbox_id = sandbox_id
        self.session_id = session_id
        self.control_plane_url = control_plane_url
        self.auth_token = auth_token
        self.bridge_instance_id = bridge_instance_id
        self.bridge_restarted = bridge_restarted
        self.log = get_logger(
            "execution-bridge",
            service="sandbox",
            sandbox_id=sandbox_id,
            session_id=session_id,
        )
        self.ws: ClientConnection | None = None
        self.shutdown_event = asyncio.Event()
        self._fenced = False
        self.event_forwarder = BufferedEventForwarder(sandbox_id=sandbox_id, log=self.log)
        self.runner = runner or CommandRunner(
            workspace_path,
            self._send_event,
            self.log,
            process_group_registry_path=Path(
                f"/run/open-inspect/execution-process-groups-{sandbox_id}.json"
            ),
        )

    @property
    def ws_url(self) -> str:
        url = self.control_plane_url.replace("https://", "wss://").replace("http://", "ws://")
        return f"{url}/sessions/{self.session_id}/ws?type=sandbox"

    def _ready_event(self) -> dict[str, Any]:
        runtime_version = os.environ.get("SANDBOX_VERSION", "")
        return {
            "type": "ready",
            "runtimeMode": "execution",
            "bridgeInstanceId": self.bridge_instance_id,
            "bridgeRestarted": self.bridge_restarted,
            "opencodeSessionId": None,
            "preservationProtocolVersion": 1,
            **({"runtimeVersion": runtime_version} if runtime_version else {}),
            "repositories": [],
        }

    async def run(self) -> None:
        reconnect_attempts = 0
        try:
            while not self.shutdown_event.is_set():
                try:
                    await self._connect_and_run()
                    reconnect_attempts = 0
                except InvalidStatus as error:
                    status = getattr(getattr(error, "response", None), "status_code", None)
                    if status in (401, 403, 404, 410):
                        self.shutdown_event.set()
                        break
                    self.log.warn("execution_bridge.connect_error", status=status)
                except websockets.ConnectionClosed:
                    pass
                except Exception as error:
                    self.log.warn("execution_bridge.connect_error", exc=error)
                if self.shutdown_event.is_set():
                    break
                reconnect_attempts += 1
                delay_seconds = min(
                    RECONNECT_BACKOFF_BASE**reconnect_attempts,
                    RECONNECT_MAX_DELAY_SECONDS,
                )
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self.shutdown_event.wait(), timeout=delay_seconds)
        finally:
            await self.runner.shutdown()

    async def _connect_and_run(self) -> None:
        headers = {
            "Authorization": f"Bearer {self.auth_token}",
            "X-Sandbox-ID": self.sandbox_id,
        }
        async with websockets.connect(
            self.ws_url,
            additional_headers=headers,
            ping_interval=20,
            ping_timeout=10,
        ) as ws:
            self.ws = ws
            heartbeat = asyncio.create_task(self._heartbeat_loop())
            try:
                await self.event_forwarder.bind(ws)
                await self._send_event(self._ready_event())
                async for message in ws:
                    if self.shutdown_event.is_set():
                        break
                    try:
                        command = json.loads(message)
                    except json.JSONDecodeError:
                        self.log.warn("execution_bridge.invalid_message")
                        continue
                    if isinstance(command, dict):
                        await self._handle_command(command)
            finally:
                heartbeat.cancel()
                await asyncio.gather(heartbeat, return_exceptions=True)
                self.ws = None
                self.event_forwarder.unbind()

    async def _heartbeat_loop(self) -> None:
        while not self.shutdown_event.is_set():
            await asyncio.sleep(self.HEARTBEAT_INTERVAL_SECONDS)
            if self.ws is not None and self.ws.state is State.OPEN:
                await self._send_event({"type": "heartbeat", "status": "ready"})

    async def _handle_command(self, command: dict[str, Any]) -> None:
        command_type = command.get("type")
        if self._fenced and isinstance(command_type, str) and command_type.startswith("command_"):
            return
        if command_type == "command_execute":
            command_id = command.get("commandId")
            if isinstance(command_id, str):
                await self._send_event({"type": "command_accepted", "commandId": command_id})
                existing = self.runner.has_command(command_id)
            else:
                existing = False
            self.runner.start(command)
            if existing:
                await self.runner.replay(command_id, after_sequence=-1)
        elif command_type == "command_cancel":
            command_id = command.get("commandId")
            if isinstance(command_id, str):
                await self.runner.cancel(command_id)
        elif command_type == "command_replay":
            command_id = command.get("commandId")
            after_sequence = command.get("afterSequence")
            if isinstance(command_id, str) and isinstance(after_sequence, int):
                await self.runner.replay(command_id, after_sequence=after_sequence)
        elif command_type == "ack":
            ack_id = command.get("ackId")
            if isinstance(ack_id, str):
                self.event_forwarder.acknowledge(ack_id)
        elif command_type == "sandbox_generation":
            generation = command.get("generation")
            if isinstance(generation, dict):
                await self._send_event(
                    {"type": "sandbox_generation_ready", "generation": generation}
                )
        elif command_type == "prepare_preservation":
            self._fenced = True
            await self.runner.shutdown()
            generation = command.get("generation")
            operation_id = command.get("operationId")
            if isinstance(generation, dict) and isinstance(operation_id, str):
                await self._send_event(
                    {
                        "type": "preservation_prepared",
                        "operationId": operation_id,
                        "generation": generation,
                        "executionStopped": True,
                    }
                )
        elif command_type == "snapshot":
            await self._send_event({"type": "snapshot_ready", "opencodeSessionId": None})
        elif command_type == "shutdown":
            self._fenced = True
            self.shutdown_event.set()
            await self.runner.shutdown()
            if self.ws is not None:
                with contextlib.suppress(Exception):
                    await self.ws.close()
        else:
            self.log.debug("execution_bridge.unknown_command", command_type=command_type)

    async def _send_event(self, event: dict[str, Any]) -> bool:
        return await self.event_forwarder.send(event)

    async def stop(self) -> None:
        self.shutdown_event.set()
        await self.runner.shutdown()
        if self.ws is not None:
            with contextlib.suppress(Exception):
                await self.ws.close()


class ExecutionBridgeOwner:
    """Supervisor-owned in-process bridge; its credential never enters argv or child env."""

    def __init__(self, bridge: ExecutionBridge) -> None:
        self.bridge = bridge
        self._task: asyncio.Task[None] | None = None
        self._exit_code: int | None = None

    async def start(self, _early_connect: bool | None = None) -> None:
        if self._task is not None:
            return

        async def run() -> None:
            try:
                await self.bridge.run()
                self._exit_code = 0
            except Exception:
                self._exit_code = 1
                raise

        self._task = asyncio.create_task(run())

    async def stop(self) -> None:
        await self.bridge.stop()
        if self._task is not None:
            await asyncio.gather(self._task, return_exceptions=True)

    async def wait(self) -> int | None:
        if self._task is None:
            return None
        await self._task
        return self._exit_code

    def exit_code(self) -> int | None:
        return self._exit_code

    def started(self) -> bool:
        return self._task is not None

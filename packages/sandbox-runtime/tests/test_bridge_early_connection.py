import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest
from websockets import State

from sandbox_runtime.bridge import AgentBridge


def _bridge() -> AgentBridge:
    bridge = AgentBridge(
        sandbox_id="sandbox-1",
        session_id="session-1",
        control_plane_url="https://control.example",
        auth_token="token",
    )
    bridge.log = MagicMock()
    return bridge


async def test_execution_initialization_waits_for_health_before_session_and_signing():
    bridge = _bridge()
    first_health_check = asyncio.Event()
    allow_health = asyncio.Event()

    async def is_healthy() -> bool:
        first_health_check.set()
        await allow_health.wait()
        return True

    bridge.opencode_client.is_healthy = is_healthy
    bridge._load_session_id = AsyncMock()
    bridge.git_signing.initialize = AsyncMock()
    bridge._build_ready_event = MagicMock(return_value={"type": "ready"})

    task = asyncio.create_task(bridge._initialize_execution())
    await first_health_check.wait()

    bridge._load_session_id.assert_not_awaited()
    bridge.git_signing.initialize.assert_not_awaited()
    bridge._build_ready_event.assert_not_called()

    allow_health.set()
    await task

    bridge._load_session_id.assert_awaited_once()
    bridge.git_signing.initialize.assert_awaited_once_with(None)
    assert bridge._ready_event_payload == {"type": "ready"}


async def test_heartbeat_reports_booting_until_ready_is_announced(monkeypatch):
    bridge = _bridge()
    bridge.ws = MagicMock(state=State.OPEN)
    sent: list[dict] = []
    bridge._send_event = AsyncMock(side_effect=lambda event: sent.append(event.copy()))

    async def one_iteration(_delay: float) -> None:
        if sent:
            bridge.shutdown_event.set()

    monkeypatch.setattr("sandbox_runtime.bridge.asyncio.sleep", one_iteration)
    await bridge._heartbeat_loop()

    assert sent[0]["status"] == "booting"

    bridge.shutdown_event.clear()
    bridge._connection_ready_event.set()
    sent.clear()
    await bridge._heartbeat_loop()

    assert sent[0]["status"] == "ready"


class _FakeWs:
    close_code = 1000

    def __init__(self, messages: list[dict] | None = None, *, idle: bool = False) -> None:
        self.state = State.OPEN
        self.sent: list[str] = []
        self.messages = [json.dumps(message) for message in messages or []]
        self.idle = idle
        self.closed = asyncio.Event()

    async def send(self, data: str) -> None:
        self.sent.append(data)

    async def close(self) -> None:
        self.state = State.CLOSED
        self.closed.set()

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self.messages:
            return self.messages.pop(0)
        if self.idle and not self.closed.is_set():
            await self.closed.wait()
        await asyncio.sleep(0)
        raise StopAsyncIteration


class _Connection:
    def __init__(self, ws: _FakeWs) -> None:
        self.ws = ws

    async def __aenter__(self) -> _FakeWs:
        return self.ws

    async def __aexit__(self, *_args) -> bool:
        return False


async def test_late_mode_initializes_before_connecting(monkeypatch):
    bridge = _bridge()
    order: list[str] = []

    async def initialize() -> None:
        order.append("initialize")
        bridge._ready_event_payload = {"type": "ready"}

    async def connect(*_args) -> None:
        order.append("connect")
        bridge.shutdown_event.set()

    bridge._initialize_execution = initialize
    bridge._connect_and_run = connect
    monkeypatch.delenv("EARLY_SANDBOX_CONNECTION", raising=False)

    await bridge.run()

    assert order == ["initialize", "connect"]


async def test_late_mode_sends_ready_before_immediate_execution_command(monkeypatch):
    bridge = _bridge()
    ws = _FakeWs([{"type": "refresh_diff"}, {"type": "shutdown"}], idle=True)
    bridge.diff_refresh.request = MagicMock()
    bridge._drain_boot_warnings = AsyncMock()

    async def initialize() -> None:
        bridge._ready_event_payload = {"type": "ready", "sandboxId": bridge.sandbox_id}

    bridge._initialize_execution = initialize
    monkeypatch.delenv("EARLY_SANDBOX_CONNECTION", raising=False)
    monkeypatch.setattr(
        "sandbox_runtime.bridge.websockets.connect",
        lambda *_args, **_kwargs: _Connection(ws),
    )

    await bridge.run()

    assert json.loads(ws.sent[0])["type"] == "ready"
    bridge.diff_refresh.request.assert_called_once_with(None)


@pytest.mark.parametrize("early", [False, True])
async def test_execution_initialization_failure_exits_nonzero(monkeypatch, early: bool):
    bridge = _bridge()
    ws = _FakeWs(idle=True)
    bridge._initialize_execution = AsyncMock(side_effect=RuntimeError("init failed"))
    monkeypatch.setenv("EARLY_SANDBOX_CONNECTION", "1" if early else "0")
    monkeypatch.setattr(
        "sandbox_runtime.bridge.websockets.connect",
        lambda *_args, **_kwargs: _Connection(ws),
    )

    with pytest.raises(RuntimeError, match="init failed"):
        await asyncio.wait_for(bridge.run(), timeout=1)


async def test_shutdown_command_closes_idle_connection(monkeypatch):
    bridge = _bridge()
    bridge._ready_event_payload = {"type": "ready"}
    ws = _FakeWs([{"type": "shutdown"}], idle=True)
    monkeypatch.setattr(
        "sandbox_runtime.bridge.websockets.connect",
        lambda *_args, **_kwargs: _Connection(ws),
    )

    await asyncio.wait_for(bridge._connect_and_run(None), timeout=1)

    assert bridge.shutdown_event.is_set()
    assert ws.closed.is_set()


async def test_initialization_completes_on_same_open_socket(monkeypatch):
    bridge = _bridge()
    allow_initialization = asyncio.Event()
    ws = _FakeWs(idle=True)

    async def initialize() -> None:
        await allow_initialization.wait()
        bridge._ready_event_payload = {"type": "ready", "sandboxId": bridge.sandbox_id}

    initialization_task = asyncio.create_task(initialize())
    monkeypatch.setattr(
        "sandbox_runtime.bridge.websockets.connect",
        lambda *_args, **_kwargs: _Connection(ws),
    )
    connection_task = asyncio.create_task(bridge._connect_and_run(initialization_task))
    await asyncio.sleep(0)

    assert not [event for event in map(json.loads, ws.sent) if event["type"] == "ready"]

    allow_initialization.set()
    for _ in range(10):
        await asyncio.sleep(0)
        if any(event["type"] == "ready" for event in map(json.loads, ws.sent)):
            break

    ready_events = [event for event in map(json.loads, ws.sent) if event["type"] == "ready"]
    assert len(ready_events) == 1
    await ws.close()
    await connection_task


async def test_ready_is_resent_on_reconnect(monkeypatch):
    bridge = _bridge()
    bridge._ready_event_payload = {"type": "ready", "sandboxId": bridge.sandbox_id}
    first = _FakeWs()
    second = _FakeWs()
    sockets = iter([first, second])
    monkeypatch.setattr(
        "sandbox_runtime.bridge.websockets.connect",
        lambda *_args, **_kwargs: _Connection(next(sockets)),
    )

    await bridge._connect_and_run(None)
    await bridge._connect_and_run(None)

    assert [json.loads(event)["type"] for event in first.sent].count("ready") == 1
    assert [json.loads(event)["type"] for event in second.sent].count("ready") == 1


async def test_cancelled_ready_send_keeps_connection_execution_unready():
    bridge = _bridge()
    bridge._ready_event_payload = {"type": "ready"}
    ws = _FakeWs()
    ws.send = AsyncMock(side_effect=asyncio.CancelledError)
    bridge.ws = ws

    with pytest.raises(asyncio.CancelledError):
        await bridge._announce_ready(ws, None)

    assert not bridge._connection_ready_event.is_set()


@pytest.mark.parametrize("command_type", ["prompt", "push", "refresh_diff", "snapshot"])
async def test_execution_commands_are_rejected_before_ready(command_type: str):
    bridge = _bridge()
    bridge._handle_prompt = AsyncMock()
    bridge._handle_push = AsyncMock()
    bridge._handle_snapshot = AsyncMock()
    bridge.diff_refresh.request = MagicMock()
    bridge._send_event = AsyncMock()

    await bridge._handle_command(
        {"type": command_type, "messageId": "message-1", "pushSpec": {"targetBranch": "main"}}
    )

    bridge._handle_prompt.assert_not_awaited()
    bridge._handle_push.assert_not_awaited()
    bridge._handle_snapshot.assert_not_awaited()
    bridge.diff_refresh.request.assert_not_called()
    bridge._send_event.assert_awaited_once()


async def test_control_commands_remain_available_before_ready():
    bridge = _bridge()
    bridge._handle_stop = AsyncMock()
    bridge._handle_shutdown = AsyncMock()
    bridge.event_forwarder.acknowledge = MagicMock(return_value=True)

    await bridge._handle_command({"type": "stop"})
    await bridge._handle_command({"type": "shutdown"})
    await bridge._handle_command({"type": "ack", "ackId": "ack-1"})

    bridge._handle_stop.assert_awaited_once()
    bridge._handle_shutdown.assert_awaited_once()
    bridge.event_forwarder.acknowledge.assert_called_once_with("ack-1")

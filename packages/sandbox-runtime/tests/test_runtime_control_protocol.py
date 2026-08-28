import asyncio
import json
import re
import socket
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

from websockets import State

from sandbox_runtime.agent_bridge_process import (
    AgentBridgeProcess,
    ExecutionInitializationError,
    LocalControlDeliveryError,
)
from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.runtime_config import BridgeProcessConfig, SandboxControlProtocol
from sandbox_runtime.types import BootFailureCode, BootPhase, RuntimeState


def _bridge(protocol=SandboxControlProtocol.V2):
    return AgentBridge(
        sandbox_id="sandbox-1",
        session_id="session/1",
        control_plane_url="https://control.example.com",
        auth_token="token",
        protocol=protocol,
    )


def test_python_protocol_enum_values_match_shared_contract_representatives():
    assert {state.value for state in RuntimeState} == {"booting", "ready"}
    assert BootPhase.REPOSITORY_SYNC.value == "repository_sync"
    assert BootPhase.OPENCODE_RESTART.value == "opencode_restart"
    assert BootFailureCode.PRIMARY_START_FAILED.value == "primary_start_failed"
    assert BootFailureCode.INTERNAL_BOOT_ERROR.value == "internal_boot_error"


def test_python_boot_enums_match_shared_contract():
    shared_source = (Path(__file__).parents[2] / "shared/src/types/sandbox-events.ts").read_text()

    def shared_values(name):
        declaration = re.search(
            rf"export const {name} = \[(.*?)\] as const;", shared_source, re.DOTALL
        )
        assert declaration is not None
        return set(re.findall(r'"([a-z_]+)"', declaration.group(1)))

    assert {phase.value for phase in BootPhase} == shared_values("BOOT_PHASES")
    assert {code.value for code in BootFailureCode} == shared_values("BOOT_FAILURE_CODES")


def test_v2_uses_dedicated_encoded_runtime_control_url():
    assert _bridge().ws_url == "wss://control.example.com/sessions/session%2F1/runtime-control"
    assert (
        _bridge(SandboxControlProtocol.LEGACY).ws_url
        == "wss://control.example.com/sessions/session/1/ws?type=sandbox"
    )


async def test_v2_refuses_execution_commands_until_ready():
    bridge = _bridge()
    bridge._handle_prompt = AsyncMock()

    await bridge._handle_command({"type": "prompt", "messageId": "message-1"})

    bridge._handle_prompt.assert_not_awaited()
    assert bridge._current_prompt_task is None


async def test_execution_initialization_waits_for_supervisor_signal():
    bridge = _bridge()
    bridge._load_session_id = AsyncMock()
    bridge.git_signing.initialize = AsyncMock()
    bridge.ws = MagicMock(state=State.OPEN, send=AsyncMock())

    await bridge._handle_local_control(
        {"type": "boot_phase", "phase": BootPhase.REPOSITORY_SYNC.value}
    )
    bridge._load_session_id.assert_not_awaited()
    bridge.git_signing.initialize.assert_not_awaited()

    bridge._send_local_result = AsyncMock()
    await bridge._handle_local_control(
        {"type": "execution_dependencies_ready", "requestId": "ready-1"}
    )
    await bridge._execution_initialization_task

    bridge._load_session_id.assert_awaited_once()
    bridge.git_signing.initialize.assert_awaited_once_with(None)
    assert bridge.execution_ready is True
    assert json.loads(bridge.ws.send.await_args.args[0])["type"] == "ready"
    assert all(event["type"] != "ready" for event in bridge.event_forwarder._event_buffer)
    bridge._send_local_result.assert_awaited_once_with(
        {"type": "execution_ready", "requestId": "ready-1"}
    )


async def test_execution_ready_ack_precedes_external_ready_delivery():
    bridge = _bridge()
    bridge._load_session_id = AsyncMock()
    bridge.git_signing.initialize = AsyncMock()
    release_send = asyncio.Event()
    send_started = asyncio.Event()

    async def blocked_send(_payload):
        send_started.set()
        await release_send.wait()

    bridge.ws = MagicMock(state=State.OPEN, send=AsyncMock(side_effect=blocked_send))
    bridge._send_local_result = AsyncMock()

    await bridge._handle_local_control(
        {"type": "execution_dependencies_ready", "requestId": "ready-order"}
    )
    await send_started.wait()

    bridge._send_local_result.assert_awaited_once_with(
        {"type": "execution_ready", "requestId": "ready-order"}
    )
    release_send.set()
    await bridge._execution_initialization_task


async def test_execution_initialization_failure_reports_boot_failure_and_stops():
    bridge = _bridge()
    bridge._load_session_id = AsyncMock(side_effect=RuntimeError("session unavailable"))
    bridge._report_boot_failure = AsyncMock()
    bridge._send_local_result = AsyncMock()
    bridge.ws = MagicMock(state=State.OPEN)

    await bridge._handle_local_control(
        {"type": "execution_dependencies_ready", "requestId": "ready-2"}
    )
    await bridge._execution_initialization_task

    bridge._report_boot_failure.assert_awaited_once_with(
        BootFailureCode.RESTORED_SESSION_VALIDATION_FAILED
    )
    assert bridge.shutdown_event.is_set()
    bridge._send_local_result.assert_awaited_once_with(
        {
            "type": "execution_initialization_failed",
            "requestId": "ready-2",
            "code": BootFailureCode.RESTORED_SESSION_VALIDATION_FAILED.value,
        }
    )


async def test_unavailable_cancels_initialization_without_buffering_stale_ready():
    bridge = _bridge()
    initialization_started = asyncio.Event()
    release_initialization = asyncio.Event()
    bridge._load_session_id = AsyncMock()

    async def initialize_signing(_user):
        initialization_started.set()
        await release_initialization.wait()

    bridge.git_signing.initialize = AsyncMock(side_effect=initialize_signing)
    first_ws = MagicMock(state=State.OPEN, send=AsyncMock(), close=AsyncMock())
    bridge.ws = first_ws

    bridge._send_local_result = AsyncMock()
    await bridge._handle_local_control(
        {"type": "execution_dependencies_ready", "requestId": "ready-3"}
    )
    await initialization_started.wait()
    await bridge._handle_local_control(
        {
            "type": "execution_dependencies_unavailable",
            "phase": BootPhase.OPENCODE_RESTART.value,
        }
    )
    release_initialization.set()
    await asyncio.gather(bridge._execution_initialization_task, return_exceptions=True)

    replacement_ws = MagicMock(state=State.OPEN, send=AsyncMock())
    await bridge.event_forwarder.bind(replacement_ws)

    assert all(json.loads(call.args[0])["type"] != "ready" for call in first_ws.send.call_args_list)
    replacement_ws.send.assert_not_awaited()


async def test_unavailable_revokes_gate_and_closes_connection():
    bridge = _bridge()
    bridge.execution_ready = True
    ws = MagicMock()
    ws.close = AsyncMock()
    bridge.ws = ws

    await bridge._handle_local_control(
        {
            "type": "execution_dependencies_unavailable",
            "phase": BootPhase.OPENCODE_RESTART.value,
        }
    )

    assert bridge.execution_ready is False
    ws.close.assert_awaited_once()


async def test_v2_heartbeat_replays_boot_state_and_phase():
    bridge = _bridge()
    bridge.boot_phase = BootPhase.REPOSITORY_SYNC
    bridge.ws = MagicMock(state=State.OPEN, send=AsyncMock())

    await bridge._send_heartbeat()

    event = json.loads(bridge.ws.send.await_args.args[0])
    assert event | {"timestamp": 0} == {
        "type": "heartbeat",
        "sandboxId": "sandbox-1",
        "status": "booting",
        "phase": "repository_sync",
        "timestamp": 0,
    }


async def test_heartbeat_starts_before_recovery_and_continues_during_initialization(monkeypatch):
    bridge = _bridge()
    bridge.execution_dependencies_ready = True
    initialization_started = asyncio.Event()
    release_initialization = asyncio.Event()
    connection_done = asyncio.Event()
    order = []

    class FakeWebSocket:
        state = State.OPEN
        close_code = 1000

        async def send(self, payload):
            order.append(json.loads(payload)["type"])

        def __aiter__(self):
            return self

        async def __anext__(self):
            await connection_done.wait()
            raise StopAsyncIteration

    class ConnectionContext:
        async def __aenter__(self):
            return websocket

        async def __aexit__(self, *_args):
            return False

    async def bind(_ws):
        order.append("recover")

    async def initialize(*_args):
        initialization_started.set()
        await release_initialization.wait()

    websocket = FakeWebSocket()
    bridge.event_forwarder.bind = AsyncMock(side_effect=bind)
    bridge._initialize_execution = AsyncMock(side_effect=initialize)
    bridge.HEARTBEAT_INTERVAL = 0.01
    monkeypatch.setattr(
        "sandbox_runtime.bridge.websockets.connect", lambda *_args, **_kwargs: ConnectionContext()
    )

    connection_task = asyncio.create_task(bridge._connect_and_run())
    await initialization_started.wait()
    await asyncio.sleep(0.03)

    assert order[0:2] == ["heartbeat", "recover"]
    assert order.count("heartbeat") >= 2

    release_initialization.set()
    connection_done.set()
    await connection_task


async def test_boot_failure_ack_timeout_closes_owner_and_ack_completes(monkeypatch):
    bridge = _bridge()
    bridge._send_local_result = AsyncMock()
    ws = MagicMock(state=State.OPEN)
    ws.send = AsyncMock()
    ws.close = AsyncMock()
    bridge.ws = ws
    await bridge.event_forwarder.bind(ws)
    monkeypatch.setattr("sandbox_runtime.bridge.BOOT_FAILURE_ACK_TIMEOUT_SECONDS", 0.01)

    report = asyncio.create_task(
        bridge._report_boot_failure(BootFailureCode.PRIMARY_START_FAILED, request_id="failure-1")
    )
    await asyncio.wait_for(_wait_until(lambda: ws.close.await_count > 0), timeout=1)
    event = json.loads(ws.send.await_args.args[0])

    await bridge._handle_command({"type": "ack", "ackId": event["ackId"]})
    await asyncio.wait_for(report, timeout=1)

    assert any(
        call.kwargs == {"code": 1012, "reason": "boot failure ACK timeout"}
        for call in ws.close.await_args_list
    )
    assert bridge.shutdown_event.is_set()
    bridge._send_local_result.assert_awaited_once_with(
        {"type": "boot_failure_reported", "requestId": "failure-1"}
    )
    assert bridge.event_forwarder.acknowledge(event["ackId"]) is False


async def _wait_until(predicate):
    while not predicate():
        await asyncio.sleep(0)


async def test_bridge_process_passes_socket_and_replays_current_state(monkeypatch):
    config = BridgeProcessConfig(
        sandbox_id="sandbox-1",
        control_plane_url="https://control.example.com",
        sandbox_token="token",
        session_id="session-1",
        sandbox_control_protocol=SandboxControlProtocol.V2,
    )
    process = AgentBridgeProcess(config, MagicMock())
    await process.set_boot_phase(BootPhase.MANAGED_SKILLS)
    captured = {}

    async def create_subprocess(*args, **kwargs):
        captured["args"] = args
        captured["pass_fds"] = kwargs["pass_fds"]
        captured["socket"] = socket.fromfd(
            kwargs["pass_fds"][0], socket.AF_UNIX, socket.SOCK_STREAM
        )
        child = MagicMock(returncode=None, stdout=None)
        return child

    monkeypatch.setattr(asyncio, "create_subprocess_exec", create_subprocess)
    monkeypatch.setattr(asyncio, "sleep", AsyncMock())

    await process.start()
    replay = await asyncio.wait_for(
        asyncio.get_running_loop().sock_recv(captured["socket"], 4096), timeout=1
    )

    assert "--control-fd" in captured["args"]
    assert len(captured["pass_fds"]) == 1
    assert json.loads(replay)["phase"] == BootPhase.MANAGED_SKILLS.value
    captured["socket"].close()


async def test_bridge_process_start_raises_on_immediate_exit(monkeypatch):
    config = BridgeProcessConfig(
        sandbox_id="sandbox-1",
        control_plane_url="https://control.example.com",
        sandbox_token="token",
        session_id="session-1",
        sandbox_control_protocol=SandboxControlProtocol.V2,
    )
    process = AgentBridgeProcess(config, MagicMock())
    child = MagicMock(returncode=17, stdout=None)
    child.communicate = AsyncMock(return_value=(b"startup failed", b""))
    monkeypatch.setattr(asyncio, "create_subprocess_exec", AsyncMock(return_value=child))
    monkeypatch.setattr(asyncio, "sleep", AsyncMock())

    try:
        await process.start()
    except RuntimeError as error:
        assert "17" in str(error)
    else:
        raise AssertionError("immediate bridge exit did not fail startup")


async def test_local_control_send_is_bounded(monkeypatch):
    config = BridgeProcessConfig(
        sandbox_id="sandbox-1",
        control_plane_url="https://control.example.com",
        sandbox_token="token",
        session_id="session-1",
        sandbox_control_protocol=SandboxControlProtocol.V2,
    )
    process = AgentBridgeProcess(config, MagicMock())
    process._control_socket = MagicMock()
    send_started = asyncio.Event()

    async def blocked_send(*_args):
        send_started.set()
        await asyncio.Event().wait()

    loop = asyncio.get_running_loop()
    monkeypatch.setattr(loop, "sock_sendall", blocked_send)
    monkeypatch.setattr(
        "sandbox_runtime.agent_bridge_process.LOCAL_CONTROL_SEND_TIMEOUT_SECONDS", 0.01
    )

    try:
        await asyncio.wait_for(process.set_boot_phase(BootPhase.REPOSITORY_SYNC), timeout=1)
    except LocalControlDeliveryError as error:
        assert error.reason == "timeout"
    else:
        raise AssertionError("timed out local delivery did not raise")

    assert send_started.is_set()


async def test_ready_waits_for_correlated_bridge_result():
    process, child_socket = _process_with_local_socket()
    try:
        ready_task = asyncio.create_task(process.execution_dependencies_ready())
        request = await _recv_json(child_socket)
        await asyncio.get_running_loop().sock_sendall(
            child_socket,
            json.dumps({"type": "execution_ready", "requestId": request["requestId"]}).encode()
            + b"\n",
        )

        assert await ready_task is True
    finally:
        await process._stop_local_reader()
        child_socket.close()


async def test_ready_surfaces_correlated_initialization_failure():
    process, child_socket = _process_with_local_socket()
    try:
        ready_task = asyncio.create_task(process.execution_dependencies_ready())
        request = await _recv_json(child_socket)
        await asyncio.get_running_loop().sock_sendall(
            child_socket,
            json.dumps(
                {
                    "type": "execution_initialization_failed",
                    "requestId": request["requestId"],
                    "code": BootFailureCode.GIT_SIGNING_FAILED.value,
                }
            ).encode()
            + b"\n",
        )

        try:
            await ready_task
        except ExecutionInitializationError as error:
            assert error.code == BootFailureCode.GIT_SIGNING_FAILED.value
        else:
            raise AssertionError("initialization failure was not surfaced")
    finally:
        await process._stop_local_reader()
        child_socket.close()


async def test_ready_result_timeout_is_delivery_failure(monkeypatch):
    process, child_socket = _process_with_local_socket()
    monkeypatch.setattr(
        "sandbox_runtime.agent_bridge_process.EXECUTION_READY_RESULT_TIMEOUT_SECONDS", 0.01
    )
    try:
        try:
            await process.execution_dependencies_ready()
        except LocalControlDeliveryError as error:
            assert error.reason == "result_timeout"
        else:
            raise AssertionError("missing ready result did not fail")
        assert process._desired_state["type"] == "execution_dependencies_ready"
    finally:
        await process._stop_local_reader()
        child_socket.close()


async def test_ready_result_eof_is_delivery_failure():
    process, child_socket = _process_with_local_socket()
    ready_task = asyncio.create_task(process.execution_dependencies_ready())
    await _recv_json(child_socket)
    child_socket.close()

    try:
        await ready_task
    except LocalControlDeliveryError as error:
        assert error.reason == "eof"
    else:
        raise AssertionError("local result EOF did not fail readiness")
    await process._stop_local_reader()


async def test_boot_failure_uses_correlated_parent_reader():
    process, child_socket = _process_with_local_socket()
    try:
        report_task = asyncio.create_task(process.boot_failed(BootFailureCode.PRIMARY_START_FAILED))
        request = await _recv_json(child_socket)
        await asyncio.get_running_loop().sock_sendall(
            child_socket,
            json.dumps(
                {"type": "boot_failure_reported", "requestId": request["requestId"]}
            ).encode()
            + b"\n",
        )

        await report_task
    finally:
        await process._stop_local_reader()
        child_socket.close()


async def test_local_reader_is_replaced_cleanly_on_bridge_restart(monkeypatch):
    config = BridgeProcessConfig(
        sandbox_id="sandbox-1",
        control_plane_url="https://control.example.com",
        sandbox_token="token",
        session_id="session-1",
        sandbox_control_protocol=SandboxControlProtocol.V2,
    )
    process = AgentBridgeProcess(config, MagicMock())
    children = []

    async def create_subprocess(*_args, **kwargs):
        children.append(socket.fromfd(kwargs["pass_fds"][0], socket.AF_UNIX, socket.SOCK_STREAM))
        return MagicMock(returncode=None, stdout=None)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", create_subprocess)
    monkeypatch.setattr(asyncio, "sleep", AsyncMock())

    await process.start()
    first_reader = process._local_reader_task
    await process.start()

    assert first_reader.done()
    assert process._local_reader_task is not first_reader
    assert not process._local_reader_task.done()

    await process._stop_local_reader()
    for child in children:
        child.close()


async def test_start_waits_for_replayed_ready_confirmation(monkeypatch):
    config = BridgeProcessConfig(
        sandbox_id="sandbox-1",
        control_plane_url="https://control.example.com",
        sandbox_token="token",
        session_id="session-1",
        sandbox_control_protocol=SandboxControlProtocol.V2,
    )
    process = AgentBridgeProcess(config, MagicMock())
    process._desired_state = {
        "type": "execution_dependencies_ready",
        "requestId": "replay-ready-1",
    }
    request_received = asyncio.Event()
    release_ack = asyncio.Event()
    responder_tasks = []
    child_sockets = []

    async def create_subprocess(*_args, **kwargs):
        child = socket.fromfd(kwargs["pass_fds"][0], socket.AF_UNIX, socket.SOCK_STREAM)
        child.setblocking(False)
        child_sockets.append(child)

        async def respond():
            request = await _recv_json(child)
            request_received.set()
            await release_ack.wait()
            await asyncio.get_running_loop().sock_sendall(
                child,
                json.dumps({"type": "execution_ready", "requestId": request["requestId"]}).encode()
                + b"\n",
            )

        responder_tasks.append(asyncio.create_task(respond()))
        return MagicMock(returncode=None, stdout=None)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", create_subprocess)
    monkeypatch.setattr(asyncio, "sleep", AsyncMock())

    start_task = asyncio.create_task(process.start())
    await request_received.wait()
    assert not start_task.done()
    release_ack.set()
    await start_task

    await process._stop_local_reader()
    await asyncio.gather(*responder_tasks)
    for child in child_sockets:
        child.close()


async def test_start_propagates_replayed_ready_initialization_failure(monkeypatch):
    config = BridgeProcessConfig(
        sandbox_id="sandbox-1",
        control_plane_url="https://control.example.com",
        sandbox_token="token",
        session_id="session-1",
        sandbox_control_protocol=SandboxControlProtocol.V2,
    )
    process = AgentBridgeProcess(config, MagicMock())
    process._desired_state = {
        "type": "execution_dependencies_ready",
        "requestId": "replay-ready-2",
    }
    responder_tasks = []
    child_sockets = []

    async def create_subprocess(*_args, **kwargs):
        child = socket.fromfd(kwargs["pass_fds"][0], socket.AF_UNIX, socket.SOCK_STREAM)
        child.setblocking(False)
        child_sockets.append(child)

        async def respond():
            request = await _recv_json(child)
            await asyncio.get_running_loop().sock_sendall(
                child,
                json.dumps(
                    {
                        "type": "execution_initialization_failed",
                        "requestId": request["requestId"],
                        "code": BootFailureCode.GIT_SIGNING_FAILED.value,
                    }
                ).encode()
                + b"\n",
            )

        responder_tasks.append(asyncio.create_task(respond()))
        return MagicMock(returncode=None, stdout=None)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", create_subprocess)
    monkeypatch.setattr(asyncio, "sleep", AsyncMock())

    try:
        await process.start()
    except ExecutionInitializationError as error:
        assert error.code == BootFailureCode.GIT_SIGNING_FAILED.value
    else:
        raise AssertionError("replayed initialization failure did not propagate")

    await process._stop_local_reader()
    await asyncio.gather(*responder_tasks)
    for child in child_sockets:
        child.close()


def _process_with_local_socket():
    config = BridgeProcessConfig(
        sandbox_id="sandbox-1",
        control_plane_url="https://control.example.com",
        sandbox_token="token",
        session_id="session-1",
        sandbox_control_protocol=SandboxControlProtocol.V2,
    )
    process = AgentBridgeProcess(config, MagicMock())
    parent_socket, child_socket = socket.socketpair()
    parent_socket.setblocking(False)
    child_socket.setblocking(False)
    process._control_socket = parent_socket
    process._process = MagicMock(returncode=None)
    process._start_local_reader()
    return process, child_socket


async def _recv_json(sock):
    payload = await asyncio.wait_for(asyncio.get_running_loop().sock_recv(sock, 4096), timeout=1)
    return json.loads(payload)

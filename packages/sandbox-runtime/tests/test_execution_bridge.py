from unittest.mock import AsyncMock, MagicMock

from sandbox_runtime.execution_bridge import ExecutionBridge, ExecutionBridgeOwner


class FakeRunner:
    def __init__(self):
        self.start = MagicMock()
        self.cancel = AsyncMock(return_value=True)
        self.replay = AsyncMock()
        self.shutdown = AsyncMock()


def bridge(runner):
    return ExecutionBridge(
        sandbox_id="sandbox-1",
        session_id="session-1",
        control_plane_url="https://control.example",
        auth_token="token",
        runner=runner,
        bridge_instance_id="bridge-1",
        bridge_restarted=True,
    )


async def test_execution_bridge_routes_only_the_command_protocol():
    runner = FakeRunner()
    execution_bridge = bridge(runner)
    command = {
        "type": "command_execute",
        "effect": "sandbox_execution",
        "commandId": "cmd-1",
        "purpose": "test",
        "argv": ["npm", "test"],
    }

    await execution_bridge._handle_command(command)
    await execution_bridge._handle_command(
        {"type": "command_replay", "commandId": "cmd-1", "afterSequence": 3}
    )
    await execution_bridge._handle_command({"type": "command_cancel", "commandId": "cmd-1"})
    await execution_bridge._handle_command({"type": "prompt", "content": "do not run"})

    runner.start.assert_called_once_with(command)
    runner.replay.assert_awaited_once_with("cmd-1", after_sequence=3)
    runner.cancel.assert_awaited_once_with("cmd-1")


async def test_execution_bridge_shutdown_cancels_processes_and_socket():
    runner = FakeRunner()
    execution_bridge = bridge(runner)
    execution_bridge.ws = MagicMock(close=AsyncMock())

    await execution_bridge._handle_command({"type": "shutdown"})

    assert execution_bridge.shutdown_event.is_set()
    runner.shutdown.assert_awaited_once()
    execution_bridge.ws.close.assert_awaited_once()


def test_execution_bridge_ready_event_has_no_agent_harness():
    execution_bridge = bridge(FakeRunner())

    assert execution_bridge._ready_event() == {
        "type": "ready",
        "runtimeMode": "execution",
        "bridgeInstanceId": "bridge-1",
        "bridgeRestarted": True,
        "opencodeSessionId": None,
        "preservationProtocolVersion": 1,
        "repositories": [],
    }


def test_execution_bridge_ready_event_reports_runtime_version(monkeypatch):
    monkeypatch.setenv("SANDBOX_VERSION", "v78-execution-isolation-boundary")

    assert (
        bridge(FakeRunner())._ready_event()["runtimeVersion"] == "v78-execution-isolation-boundary"
    )


async def test_preservation_fences_all_later_command_operations():
    runner = FakeRunner()
    execution_bridge = bridge(runner)
    execution_bridge._send_event = AsyncMock(return_value=True)

    await execution_bridge._handle_command(
        {
            "type": "prepare_preservation",
            "operationId": "save-1",
            "generation": {"sandboxId": "sandbox-1", "createdAt": 1},
        }
    )
    await execution_bridge._handle_command(
        {
            "type": "command_execute",
            "effect": "sandbox_execution",
            "commandId": "cmd-late",
            "purpose": "test",
            "argv": ["true"],
        }
    )
    await execution_bridge._handle_command({"type": "command_cancel", "commandId": "cmd-1"})
    await execution_bridge._handle_command(
        {"type": "command_replay", "commandId": "cmd-1", "afterSequence": -1}
    )

    runner.shutdown.assert_awaited_once()
    runner.start.assert_not_called()
    runner.cancel.assert_not_awaited()
    runner.replay.assert_not_awaited()


async def test_execution_bridge_owner_runs_in_process_without_token_argv(monkeypatch):
    execution_bridge = bridge(FakeRunner())
    execution_bridge.run = AsyncMock(return_value=None)
    owner = ExecutionBridgeOwner(execution_bridge)

    await owner.start()
    assert await owner.wait() == 0
    assert owner.exit_code() == 0
    assert owner.started() is True
    execution_bridge.run.assert_awaited_once()

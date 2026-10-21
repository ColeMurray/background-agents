import asyncio
import signal
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.command_runner import CommandRunner


@pytest.fixture
def events():
    recorded = []

    async def emit(event):
        recorded.append(event)

    return recorded, emit


async def test_runner_streams_output_and_replays_from_sequence(tmp_path: Path, events):
    recorded, emit = events
    runner = CommandRunner(tmp_path, emit, MagicMock())

    await runner.execute(
        {
            "type": "command_execute",
            "effect": "sandbox_execution",
            "commandId": "cmd-1",
            "purpose": "test",
            "argv": [
                sys.executable,
                "-c",
                "import sys; print('out'); print('err', file=sys.stderr)",
            ],
            "cwd": str(tmp_path),
            "timeoutMs": 5_000,
        }
    )

    assert recorded[0] == {"type": "command_started", "commandId": "cmd-1"}
    output = [event for event in recorded if event["type"] == "command_output"]
    assert [event["sequence"] for event in output] == list(range(len(output)))
    assert {event["stream"] for event in output} == {"stdout", "stderr"}
    assert recorded[-1] == {
        "type": "command_completed",
        "commandId": "cmd-1",
        "outcome": "succeeded",
        "exitCode": 0,
        "signal": None,
        "lastSequence": len(output) - 1,
        "outputTruncated": False,
    }

    recorded.clear()
    await runner.replay("cmd-1", after_sequence=0)

    assert all(event.get("sequence", 1) > 0 for event in recorded[:-1])
    assert recorded[-1]["type"] == "command_completed"


async def test_runner_cancels_the_process_group(tmp_path: Path, events):
    recorded, emit = events
    runner = CommandRunner(tmp_path, emit, MagicMock(), terminate_grace_seconds=0.05)
    runner.start(
        {
            "type": "command_execute",
            "effect": "sandbox_execution",
            "commandId": "cmd-cancel",
            "purpose": "shell",
            "argv": [sys.executable, "-c", "import time; time.sleep(60)"],
            "cwd": str(tmp_path),
            "timeoutMs": 60_000,
        }
    )
    await asyncio.wait_for(runner.started("cmd-cancel"), timeout=1)

    assert await runner.cancel("cmd-cancel") is True
    await asyncio.wait_for(runner.wait("cmd-cancel"), timeout=1)

    assert recorded[-1]["type"] == "command_completed"
    assert recorded[-1]["outcome"] == "cancelled"


async def test_runner_cancellation_reaches_child_processes_in_the_group(tmp_path: Path, events):
    _recorded, emit = events
    child_started = tmp_path / "child-started"
    child_killed = tmp_path / "child-killed"
    child_code = (
        "import signal,sys,time; from pathlib import Path; "
        f"Path({str(child_started)!r}).write_text('started'); "
        f"signal.signal(signal.SIGTERM, lambda *_: (Path({str(child_killed)!r}).write_text('killed'), sys.exit(0))); "
        "time.sleep(60)"
    )
    parent_code = (
        "import subprocess,sys,time; "
        f"subprocess.Popen([sys.executable, '-c', {child_code!r}]); time.sleep(60)"
    )
    runner = CommandRunner(tmp_path, emit, MagicMock(), terminate_grace_seconds=0.5)
    runner.start(
        {
            "type": "command_execute",
            "effect": "sandbox_execution",
            "commandId": "cmd-group",
            "purpose": "shell",
            "argv": [sys.executable, "-c", parent_code],
            "cwd": str(tmp_path),
            "timeoutMs": 60_000,
        }
    )
    for _ in range(100):
        if child_started.exists():
            break
        await asyncio.sleep(0.01)
    assert child_started.exists()

    await runner.cancel("cmd-group")
    await asyncio.wait_for(runner.wait("cmd-group"), timeout=1)
    for _ in range(100):
        if child_killed.exists():
            break
        await asyncio.sleep(0.01)

    assert child_killed.read_text() == "killed"


async def test_runner_times_out_and_rejects_workspace_escape(tmp_path: Path, events):
    recorded, emit = events
    runner = CommandRunner(tmp_path, emit, MagicMock(), terminate_grace_seconds=0.05)

    await runner.execute(
        {
            "type": "command_execute",
            "effect": "sandbox_execution",
            "commandId": "cmd-timeout",
            "purpose": "build",
            "argv": [sys.executable, "-c", "import time; time.sleep(60)"],
            "cwd": str(tmp_path),
            "timeoutMs": 10,
        }
    )
    assert recorded[-1]["outcome"] == "timed_out"

    recorded.clear()
    await runner.execute(
        {
            "type": "command_execute",
            "effect": "sandbox_execution",
            "commandId": "cmd-escape",
            "purpose": "shell",
            "argv": ["pwd"],
            "cwd": str(tmp_path.parent),
            "timeoutMs": 1_000,
        }
    )
    assert recorded == [
        {
            "type": "command_completed",
            "commandId": "cmd-escape",
            "outcome": "failed",
            "exitCode": None,
            "signal": None,
            "lastSequence": -1,
            "outputTruncated": False,
            "error": "Command cwd must stay inside the workspace",
        }
    ]


async def test_runner_drops_output_beyond_the_replay_bound_without_advancing_sequence(
    tmp_path: Path, events, monkeypatch
):
    recorded, emit = events
    monkeypatch.setattr("sandbox_runtime.command_runner.MAX_REPLAY_BYTES", 10)
    runner = CommandRunner(tmp_path, emit, MagicMock())

    await runner.execute(
        {
            "type": "command_execute",
            "effect": "sandbox_execution",
            "commandId": "cmd-bounded",
            "purpose": "shell",
            "argv": [sys.executable, "-c", "print('x' * 100)"],
            "cwd": str(tmp_path),
            "timeoutMs": 1_000,
        }
    )

    assert [event["type"] for event in recorded] == ["command_started", "command_completed"]
    assert recorded[-1]["lastSequence"] == -1
    assert recorded[-1]["outputTruncated"] is True


async def test_cancel_intent_wins_before_and_after_process_registration(
    tmp_path: Path, events, monkeypatch
):
    recorded, emit = events
    runner = CommandRunner(tmp_path, emit, MagicMock(), terminate_grace_seconds=0.05)
    real_create = asyncio.create_subprocess_exec
    release_create = asyncio.Event()

    async def delayed_create(*args, **kwargs):
        await release_create.wait()
        return await real_create(*args, **kwargs)

    monkeypatch.setattr(
        "sandbox_runtime.command_runner.asyncio.create_subprocess_exec", delayed_create
    )
    runner.start(
        {
            "type": "command_execute",
            "effect": "sandbox_execution",
            "commandId": "cmd-race",
            "purpose": "shell",
            "argv": [sys.executable, "-c", "import time; time.sleep(60)"],
            "cwd": str(tmp_path),
            "timeoutMs": 60_000,
        }
    )
    await asyncio.sleep(0)

    assert await runner.cancel("cmd-race") is True
    release_create.set()
    await asyncio.wait_for(runner.wait("cmd-race"), timeout=1)

    assert recorded[-1]["outcome"] == "cancelled"


async def test_command_child_receives_only_allowlisted_non_secret_environment(
    tmp_path: Path, events
):
    recorded, emit = events
    runner = CommandRunner(
        tmp_path,
        emit,
        MagicMock(),
        environment={
            "PATH": "/usr/bin:/bin",
            "HOME": str(tmp_path),
            "SANDBOX_AUTH_TOKEN": "sandbox-secret",
            "ANTHROPIC_API_KEY": "provider-secret",
            "VCS_CLONE_TOKEN": "scm-secret",
            "SESSION_CONFIG": '{"mcp_servers":[{"headers":{"Authorization":"secret"}}]}',
        },
    )

    await runner.execute(
        {
            "type": "command_execute",
            "effect": "sandbox_execution",
            "commandId": "cmd-env",
            "purpose": "shell",
            "argv": [sys.executable, "-c", "import os; print(sorted(os.environ))"],
            "cwd": str(tmp_path),
            "timeoutMs": 1_000,
        }
    )

    output = "".join(event["data"] for event in recorded if event["type"] == "command_output")
    assert "PATH" in output
    assert "HOME" in output
    assert "SANDBOX_AUTH_TOKEN" not in output
    assert "ANTHROPIC_API_KEY" not in output
    assert "VCS_CLONE_TOKEN" not in output
    assert "SESSION_CONFIG" not in output


async def test_new_runner_kills_process_groups_left_by_replaced_bridge(tmp_path: Path, monkeypatch):
    registry = tmp_path / "groups.json"
    registry.write_text('{"cmd-old":4321}')
    killpg = MagicMock()
    monkeypatch.setattr("sandbox_runtime.command_runner.os.killpg", killpg)

    CommandRunner(tmp_path, AsyncMock(), MagicMock(), process_group_registry_path=registry)

    killpg.assert_called_once_with(4321, signal.SIGKILL)
    assert not registry.exists()


async def test_replay_of_unknown_command_reports_an_explicit_gap(tmp_path: Path, events):
    recorded, emit = events
    runner = CommandRunner(tmp_path, emit, MagicMock())

    await runner.replay("cmd-missing", after_sequence=4)

    assert recorded == [
        {
            "type": "command_replay_gap",
            "commandId": "cmd-missing",
            "requestedAfterSequence": 4,
            "firstAvailableSequence": None,
            "lastSequence": -1,
            "reason": "unknown_command",
        }
    ]

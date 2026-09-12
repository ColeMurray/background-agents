"""Runtime deadline and reuse boundaries using actual subprocess execution."""

from __future__ import annotations

import asyncio
import os
import signal
import sys
import time
from dataclasses import replace
from unittest.mock import AsyncMock, Mock

import pytest

from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.execution_coordinator import ExecutionPhase
from sandbox_runtime.harness import TurnOutcome
from tests.conftest import ScriptedHarness


def command(message_id: str = "m1", **fields: object) -> dict:
    return {
        "type": "prompt",
        "messageId": message_id,
        "sandboxId": "sandbox-1",
        "content": "run",
        "author": {"gitIdentity": {"mode": "agent-only"}},
        **fields,
    }


def bridge_for(harness: ScriptedHarness) -> AgentBridge:
    bridge = AgentBridge(
        sandbox_id="sandbox-1",
        session_id="session-1",
        control_plane_url="https://control.invalid",
        auth_token="test",
        harness=harness,
    )
    bridge.log = Mock()
    bridge.diff_refresh = Mock()
    bridge._configure_git_identity = AsyncMock()
    bridge._send_event = AsyncMock()
    bridge.prompt_limits = replace(
        bridge.prompt_limits,
        prompt_max_duration_seconds=5.0,
        prompt_cleanup_timeout_seconds=0.2,
    )
    return bridge


class ProcessHarness(ScriptedHarness):
    """One owned tool with a contract that can actually attest to its exit."""

    def __init__(self, *, reject_stop: bool = False) -> None:
        super().__init__()
        self.reject_stop = reject_stop
        self.started = asyncio.Event()
        self.process: asyncio.subprocess.Process | None = None
        self.stop_calls = 0

    async def run_prompt(self, prompt, emit):
        self.prompts.append(prompt)
        self.process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-c",
            "import time; time.sleep(60)",
            start_new_session=True,
        )
        self.started.set()
        await self.process.wait()
        return TurnOutcome.ok()

    async def stop(self, deadline_monotonic: float) -> bool:
        self.stop_calls += 1
        if self.reject_stop:
            return False
        assert self.process is not None
        self.process.terminate()
        async with asyncio.timeout_at(deadline_monotonic):
            await self.process.wait()
        return self.process.returncode is not None

    async def cleanup(self) -> None:
        if self.process is not None and self.process.returncode is None:
            os.killpg(self.process.pid, signal.SIGKILL)
            await self.process.wait()


def terminal_events(bridge: AgentBridge) -> list[dict]:
    return [
        call.args[0]
        for call in bridge._send_event.await_args_list
        if call.args[0]["type"] == "execution_complete"
    ]


@pytest.mark.asyncio
async def test_confirmed_tool_exit_releases_runtime_and_duplicate_stop_is_idempotent():
    harness = ProcessHarness()
    bridge = bridge_for(harness)
    try:
        await bridge._handle_command(command())
        task = bridge.execution.prompt_task
        assert bridge.execution.phase == ExecutionPhase.PREPARING
        await harness.started.wait()
        assert bridge.execution.phase == ExecutionPhase.RUNNING
        await bridge._handle_command({"type": "stop", "messageId": "m1", "sandboxId": "sandbox-1"})
        assert bridge.execution.phase == ExecutionPhase.STOPPING
        await bridge._handle_command({"type": "stop", "messageId": "m1", "sandboxId": "sandbox-1"})
        await task
        await asyncio.sleep(0)
        assert harness.process.returncode is not None
        assert harness.stop_calls == 1
        assert terminal_events(bridge)[0]["executionStopped"] is True
        assert not bridge.execution.quarantined
        assert bridge.execution.phase == ExecutionPhase.IDLE

        # Dispatch replay does not start a second process or reset its budget.
        await bridge._handle_command(command())
        assert len(harness.prompts) == 1

        harness.started.clear()
        await bridge._handle_command(command("m2"))
        task = bridge.execution.prompt_task
        await harness.started.wait()
        await bridge._handle_command({"type": "stop", "messageId": "m1", "sandboxId": "sandbox-1"})
        await bridge._handle_command(
            {"type": "stop", "messageId": "m2", "sandboxId": "old-sandbox"}
        )
        assert not task.done()
        assert harness.stop_calls == 1
        await bridge._handle_stop({"messageId": "m2", "sandboxId": "sandbox-1"})
        await task
        assert harness.stop_calls == 2
    finally:
        await harness.cleanup()


@pytest.mark.asyncio
async def test_rejected_interrupt_leaves_execution_uncertain_and_blocks_reuse_and_snapshot():
    harness = ProcessHarness(reject_stop=True)
    bridge = bridge_for(harness)
    try:
        await bridge._handle_command(command())
        task = bridge.execution.prompt_task
        await harness.started.wait()
        await bridge._handle_stop({"messageId": "m1"})
        await task
        await asyncio.sleep(0)
        assert harness.process.returncode is None
        assert terminal_events(bridge)[0]["executionStopped"] is False
        assert bridge.execution.quarantined
        assert bridge.execution.phase == ExecutionPhase.QUARANTINED
        await bridge._handle_command(command("m2"))
        await bridge._handle_snapshot({"requestId": "snap"})
        assert len(harness.prompts) == 1
        assert not any(
            call.args[0]["type"] == "snapshot_ready" for call in bridge._send_event.await_args_list
        )
        bridge.diff_refresh.prompt_finished.assert_not_called()
    finally:
        await harness.cleanup()


@pytest.mark.asyncio
async def test_graceful_stop_keeps_reader_until_tool_exit_without_escalating():
    class GracefulHarness(ProcessHarness):
        async def abort(self):
            self.abort_calls += 1
            self.process.terminate()
            return True  # The reader still has to observe actual exit.

    harness = GracefulHarness()
    bridge = bridge_for(harness)
    unrelated_service = await asyncio.create_subprocess_exec(
        sys.executable, "-c", "import time; time.sleep(60)", start_new_session=True
    )
    try:
        await bridge._handle_command(command())
        task = bridge.execution.prompt_task
        await harness.started.wait()
        await bridge._handle_stop({"messageId": "m1"})
        await task
        assert harness.process.returncode is not None
        assert harness.abort_calls == 1
        assert harness.stop_calls == 0
        assert unrelated_service.returncode is None
        assert terminal_events(bridge)[0]["executionStopped"] is True
        assert terminal_events(bridge)[0]["success"] is False
    finally:
        await harness.cleanup()
        unrelated_service.kill()
        await unrelated_service.wait()


@pytest.mark.asyncio
async def test_old_interrupt_request_must_settle_before_runtime_is_reused():
    class DelayedInterruptHarness(ScriptedHarness):
        def __init__(self):
            super().__init__()
            self.started = asyncio.Event()
            self.finish = asyncio.Event()
            self.interrupt_started = asyncio.Event()
            self.interrupt_acknowledged = asyncio.Event()

        async def run_prompt(self, prompt, emit):
            self.prompts.append(prompt)
            self.started.set()
            await self.finish.wait()
            await emit({"type": "token", "messageId": prompt.message_id, "content": "done"})
            return TurnOutcome.ok()

        async def abort(self):
            self.interrupt_started.set()
            await self.interrupt_acknowledged.wait()
            return True

    harness = DelayedInterruptHarness()
    bridge = bridge_for(harness)
    await bridge._handle_command(command())
    task = bridge.execution.prompt_task
    await harness.started.wait()
    await bridge._handle_stop({"messageId": "m1"})
    await harness.interrupt_started.wait()
    harness.finish.set()
    await asyncio.sleep(0)
    await bridge._handle_command(command("m2"))
    assert len(harness.prompts) == 1
    assert not terminal_events(bridge)
    harness.interrupt_acknowledged.set()
    await task
    await asyncio.sleep(0)
    assert terminal_events(bridge)[0]["executionStopped"] is True
    await bridge._handle_command(command("m2"))
    await bridge.execution.prompt_task
    assert len(harness.prompts) == 2


@pytest.mark.asyncio
async def test_unacknowledged_old_interrupt_cannot_be_released_by_a_late_result():
    class LostInterruptHarness(ScriptedHarness):
        started = asyncio.Event()
        finish = asyncio.Event()

        async def run_prompt(self, prompt, emit):
            self.started.set()
            await self.finish.wait()
            return TurnOutcome.ok()

        async def abort(self):
            self.finish.set()
            await asyncio.Event().wait()

    harness = LostInterruptHarness()
    bridge = bridge_for(harness)
    bridge.prompt_limits = replace(bridge.prompt_limits, prompt_cleanup_timeout_seconds=0.06)
    await bridge._handle_command(command())
    task = bridge.execution.prompt_task
    await harness.started.wait()
    await bridge._handle_stop({"messageId": "m1"})
    await asyncio.wait_for(task, timeout=0.3)
    assert terminal_events(bridge)[0]["executionStopped"] is False
    assert bridge.execution.quarantined


@pytest.mark.asyncio
async def test_expired_dispatch_does_not_start_preparation_or_harness():
    harness = ScriptedHarness()
    bridge = bridge_for(harness)
    await bridge._handle_command(command(executionDeadlineMs=(time.time() - 1) * 1000))
    await bridge.execution.prompt_task
    bridge._configure_git_identity.assert_not_awaited()
    assert not harness.prompts
    assert terminal_events(bridge)[0]["executionStopped"] is True
    assert "Execution deadline reached" in terminal_events(bridge)[0]["error"]


@pytest.mark.asyncio
async def test_preparation_consumes_dispatched_deadline_and_cannot_claim_harness_stop_evidence():
    harness = ScriptedHarness()
    bridge = bridge_for(harness)
    preparation_cancelled = asyncio.Event()

    async def prepare(_author):
        try:
            await asyncio.Event().wait()
        finally:
            preparation_cancelled.set()

    bridge._configure_git_identity = prepare
    # The wire deadline includes the one-second ordinary-clock-skew allowance.
    await bridge._handle_command(command(executionDeadlineMs=(time.time() + 1.2) * 1000))
    await asyncio.wait_for(bridge.execution.prompt_task, timeout=0.5)
    assert preparation_cancelled.is_set()
    assert not harness.prompts
    assert harness.abort_calls == 0
    assert terminal_events(bridge)[0]["executionStopped"] is False
    assert bridge.execution.quarantined


@pytest.mark.asyncio
async def test_cleanup_and_slow_delivery_share_one_budget_without_blocking_shutdown():
    class HungCleanupHarness(ScriptedHarness):
        started = asyncio.Event()
        stopping = asyncio.Event()

        async def run_prompt(self, prompt, emit):
            self.started.set()
            await emit(
                {"type": "step_finish", "messageId": prompt.message_id, "messageCostUsd": 0.4}
            )
            await asyncio.Event().wait()

        async def stop(self, deadline_monotonic):
            self.abort_calls += 1
            self.stopping.set()
            # Interrupt and disconnect phases consume the same allowance.
            await asyncio.sleep(0.03)
            await asyncio.Event().wait()

    harness = HungCleanupHarness()
    bridge = bridge_for(harness)
    bridge.prompt_limits = replace(bridge.prompt_limits, prompt_cleanup_timeout_seconds=0.06)
    events = []

    async def send(event):
        events.append(event)
        if event["type"] == "execution_complete":
            await asyncio.Event().wait()

    bridge._send_event = send
    await bridge._handle_command(command())
    task = bridge.execution.prompt_task
    await harness.started.wait()
    started = asyncio.get_running_loop().time()
    await bridge._handle_command({"type": "stop", "messageId": "m1"})
    await harness.stopping.wait()
    await asyncio.wait_for(bridge._handle_command({"type": "shutdown"}), timeout=0.02)
    assert bridge.shutdown_event.is_set()
    await asyncio.wait_for(task, timeout=0.3)
    assert asyncio.get_running_loop().time() - started < 0.25
    assert harness.abort_calls == 2  # One request, one bounded containment attempt.
    complete = [event for event in events if event["type"] == "execution_complete"]
    assert len(complete) == 1
    assert complete[0]["executionStopped"] is False
    assert complete[0]["messageCostUsd"] == 0.4
    # The CP receives the already-spent bound, not a new reserve on receipt.
    assert complete[0]["cleanupDeadlineMs"] <= time.time() * 1000


@pytest.mark.asyncio
async def test_snapshot_ack_requires_successful_correlated_log_exclusion(monkeypatch):
    bridge = bridge_for(ScriptedHarness())
    clean = AsyncMock()
    monkeypatch.setattr("sandbox_runtime.bridge.prepare_hook_logs_for_snapshot", clean)
    await bridge._handle_snapshot({"requestId": "request-1"})
    clean.assert_awaited_once()
    assert bridge._send_event.await_args.args[0]["requestId"] == "request-1"

    bridge._send_event.reset_mock()
    clean.side_effect = OSError("unsafe log path")
    await bridge._handle_snapshot({"requestId": "request-2"})
    bridge._send_event.assert_not_awaited()

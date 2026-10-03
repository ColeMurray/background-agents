"""Delivery diagnostics report settled transport state and the delivered terminal event."""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.event_forwarder import EVICTION_WARNING_INTERVAL_SECONDS
from sandbox_runtime.harness import TurnOutcome
from tests.event_forwarder_fakes import make_forwarder, open_ws


@pytest.mark.asyncio
async def test_eviction_warnings_rate_limit_only_noncritical_events(monkeypatch):
    now = 0.0
    monkeypatch.setattr("sandbox_runtime.event_forwarder.time.monotonic", lambda: now)
    forwarder = make_forwarder(max_buffer_size=1)
    for message_id in ("token-0", "token-1", "token-2"):
        await forwarder.send({"type": "token", "messageId": message_id})
    for message_id in ("critical-a", "critical-b"):
        await forwarder.send({"type": "execution_complete", "messageId": message_id})
    now += EVICTION_WARNING_INTERVAL_SECONDS
    # Evicting critical-b warns at the same instant; it must not restart the
    # noncritical window that token-3's eviction is measured against.
    for message_id in ("token-3", "token-4"):
        await forwarder.send({"type": "token", "messageId": message_id})

    warnings = [call.kwargs for call in forwarder._log.warn.call_args_list]
    assert [w["message_id"] for w in warnings] == ["token-0", "critical-a", "critical-b", "token-3"]
    assert [w["critical"] for w in warnings] == [False, True, True, False]
    assert warnings[1]["ack_id"] == "execution_complete:critical-a"
    assert warnings[-1]["suppressed_eviction_warnings"] == 2
    assert forwarder.health_snapshot() == {
        "buffer_size": 1,
        "pending_acks": 0,
        "in_flight_acks": 0,
        "evicted_events": 6,
        "evicted_critical_events": 2,
        "suppressed_eviction_warnings": 0,
    }


@pytest.mark.asyncio
async def test_failure_warnings_report_the_settled_state():
    forwarder = make_forwarder()
    await forwarder.send({"type": "execution_complete", "messageId": "msg-1"})
    ws = open_ws()
    ws.send = AsyncMock(side_effect=OSError("socket reset"))
    await forwarder.bind(ws)
    await forwarder.send({"type": "execution_complete", "messageId": "msg-2"})

    settled = {
        call.args[0]: (
            call.kwargs["ack_id"],
            call.kwargs["buffer_size"],
            call.kwargs["pending_acks"],
            call.kwargs["in_flight_acks"],
        )
        for call in forwarder._log.warn.call_args_list
    }
    assert settled == {
        "bridge.flush_send_error": ("execution_complete:msg-1", 1, 0, 0),
        "bridge.send_error": ("execution_complete:msg-2", 2, 0, 0),
    }


@pytest.fixture
def bridge():
    bridge = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )
    bridge.log = bridge.activity._log = MagicMock()
    bridge.diff_refresh = MagicMock()
    bridge._send_event = AsyncMock(return_value=True)
    bridge._persist_rotated_session_id = AsyncMock()
    bridge._prepare_turn = AsyncMock(return_value=(bridge.harness, None))
    return bridge


async def _run_supervised(bridge, *, cancel_before_start=False):
    """Run a prompt through the supervisor that owns its terminal event."""
    bridge.activity.start_prompt("msg-1", lambda: bridge._handle_prompt({"messageId": "msg-1"}))
    task = bridge.activity.current_prompt_task
    if cancel_before_start:
        task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    # Let the done callback select the terminal event and deliver it.
    for _ in range(3):
        await asyncio.sleep(0)
    (summary,) = [
        call.kwargs for call in bridge.log.info.call_args_list if call.args == ("prompt.run",)
    ]
    (completion,) = [
        call.args[0]
        for call in bridge._send_event.await_args_list
        if call.args[0]["type"] == "execution_complete"
    ]
    return summary, completion


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "result,emits,expected",
    [
        (TurnOutcome.ok(), True, ("success", "output_checks", None)),
        (TurnOutcome.ok(), False, ("error", "output_checks", "no_output")),
        (TurnOutcome.failed("rejected"), True, ("error", "output_checks", "harness_failure")),
        (
            TurnOutcome(success=False, error="stopped", cancelled=True),
            True,
            ("cancelled", "output_checks", "cancelled"),
        ),
        (ValueError("boom"), True, ("error", "harness", "exception")),
    ],
)
async def test_prompt_summary_records_where_and_why_the_turn_ended(bridge, result, emits, expected):
    async def run_prompt(_prompt, emit):
        if emits:
            await emit({"type": "token", "content": "partial"})
        if isinstance(result, Exception):
            raise result
        return result

    bridge.harness.run_prompt = run_prompt
    summary, completion = await _run_supervised(bridge)
    assert (summary["outcome"], summary["phase"], summary["error_category"]) == expected
    assert summary["error_detail"] == completion.get("error")
    assert summary["emitted_event_count"] == int(emits)


@pytest.mark.asyncio
async def test_prompt_summary_reports_the_supervisor_selected_terminal_event(bridge):
    async def run_prompt(_prompt, emit):
        await emit({"type": "token", "content": "done"})
        bridge.activity.set_prompt_interruption("sandbox_lifetime_expiring")
        return TurnOutcome.ok()

    bridge.harness.run_prompt = run_prompt
    summary, completion = await _run_supervised(bridge)
    assert completion["error"] == summary["error_detail"] == "sandbox_lifetime_expiring"
    assert summary["source_outcome"] == "success"
    assert (summary["outcome"], summary["error_category"]) == ("error", "interrupted")


@pytest.mark.asyncio
async def test_prompt_cancelled_before_start_still_has_a_summary(bridge):
    summary, completion = await _run_supervised(bridge, cancel_before_start=True)
    bridge._prepare_turn.assert_not_awaited()
    assert completion["error"] == summary["error_detail"] == "Task was cancelled"
    assert summary["phase"] == "not_started"
    assert (summary["outcome"], summary["error_category"]) == ("cancelled", "cancelled")


@pytest.mark.asyncio
async def test_heartbeat_separates_scheduling_delay_from_send_time(bridge, monkeypatch):
    now = 0.0
    bridge.ws = open_ws()
    monkeypatch.setattr("sandbox_runtime.bridge.time.monotonic", lambda: now)

    async def sleep(seconds):
        nonlocal now
        now += seconds + 6.0
        bridge.shutdown_event.set()

    async def send(_event):
        nonlocal now
        now += 7.0
        return True

    monkeypatch.setattr("sandbox_runtime.bridge.asyncio.sleep", sleep)
    bridge._send_event = AsyncMock(side_effect=send)
    await bridge._heartbeat_loop()

    warnings = [call.args[0] for call in bridge.log.warn.call_args_list]
    assert warnings == ["bridge.heartbeat_delayed", "bridge.heartbeat_send_slow"]
    assert bridge._last_heartbeat == {
        "scheduling_delay_seconds": 6.0,
        "send_duration_seconds": 7.0,
        "heartbeat_delivered": True,
    }


@pytest.mark.asyncio
async def test_health_is_reported_across_a_sustained_outage(bridge, monkeypatch):
    monkeypatch.setattr("sandbox_runtime.bridge.HEALTH_LOG_INTERVAL_SECONDS", 0.01)
    bridge.git_signing.initialize = AsyncMock()
    bridge._load_session_id = AsyncMock()
    bridge.RECONNECT_MAX_DELAY_SECONDS = 0.002
    await bridge.event_forwarder.send({"type": "execution_complete", "messageId": "queued"})

    def health_logs():
        return [
            call.kwargs
            for call in bridge.log.info.call_args_list
            if call.args == ("bridge.health",)
        ]

    async def connect_and_run():
        # The heartbeat loop never starts: every connection attempt fails.
        if len(health_logs()) >= 2:
            bridge.shutdown_event.set()
            return
        raise RuntimeError("control plane unreachable")

    bridge._connect_and_run = connect_and_run
    await asyncio.wait_for(bridge.run(), timeout=5)

    first, *_, last = health_logs()
    assert not first["connected"] and not last["connected"]
    assert first["buffer_size"] == last["buffer_size"] == 1
    assert last["reconnect_attempt_count"] > first["reconnect_attempt_count"]

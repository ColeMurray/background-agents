"""Delivery diagnostics preserve existing buffering and prompt outcomes."""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.event_forwarder import EVICTION_WARNING_INTERVAL_SECONDS
from sandbox_runtime.harness import TurnOutcome
from tests.event_forwarder_fakes import make_forwarder, open_ws, sent_events


@pytest.mark.asyncio
async def test_eviction_warning_is_rate_limited_but_counts_every_eviction(monkeypatch):
    now = 0.0
    monkeypatch.setattr("sandbox_runtime.event_forwarder.time.monotonic", lambda: now)
    forwarder = make_forwarder(max_buffer_size=1)
    for index in range(4):
        await forwarder.send({"type": "token", "messageId": f"msg-{index}", "content": "private"})

    assert forwarder._log.warn.call_count == 1
    first = forwarder._log.warn.call_args.kwargs
    assert first["message_id"] == "msg-0"
    assert first["critical"] is False
    assert first["evicted_events"] == 1
    assert "content" not in first
    assert forwarder.health_snapshot()["evicted_events"] == 3
    assert forwarder.health_snapshot()["suppressed_eviction_warnings"] == 2

    now += EVICTION_WARNING_INTERVAL_SECONDS
    await forwarder.send({"type": "token", "messageId": "msg-4"})
    assert forwarder._log.warn.call_count == 2
    assert forwarder._log.warn.call_args.kwargs["evicted_events"] == 4
    assert forwarder._log.warn.call_args.kwargs["suppressed_eviction_warnings"] == 2
    assert forwarder.health_snapshot()["suppressed_eviction_warnings"] == 0
    ws = open_ws()
    await forwarder.bind(ws)
    assert [event["messageId"] for event in sent_events(ws)] == ["msg-4"]


@pytest.mark.asyncio
async def test_critical_evictions_do_not_suppress_noncritical_warnings(monkeypatch):
    now = 0.0
    monkeypatch.setattr("sandbox_runtime.event_forwarder.time.monotonic", lambda: now)
    forwarder = make_forwarder(max_buffer_size=1)
    await forwarder.send({"type": "token", "messageId": "token-0"})
    await forwarder.send({"type": "token", "messageId": "token-1"})
    assert forwarder._log.warn.call_args.kwargs["message_id"] == "token-0"

    now += EVICTION_WARNING_INTERVAL_SECONDS
    # token-1 is evicted (warned), then the critical event is evicted (warned)
    # just before the next noncritical eviction.
    await forwarder.send({"type": "execution_complete", "messageId": "critical"})
    now += EVICTION_WARNING_INTERVAL_SECONDS - 1
    await forwarder.send({"type": "token", "messageId": "token-2"})
    await forwarder.send({"type": "token", "messageId": "token-3"})
    now += 1
    await forwarder.send({"type": "token", "messageId": "token-4"})

    warned = [call.kwargs["message_id"] for call in forwarder._log.warn.call_args_list]
    assert warned == ["token-0", "token-1", "critical", "token-3"]
    assert forwarder._log.warn.call_args.kwargs["suppressed_eviction_warnings"] == 1


@pytest.mark.asyncio
async def test_send_failure_warning_reports_the_settled_state():
    forwarder = make_forwarder()
    ws = open_ws()
    ws.send = AsyncMock(side_effect=OSError("socket reset"))
    await forwarder.bind(ws)
    assert await forwarder.send({"type": "execution_complete", "messageId": "msg-1"}) is False

    warning = next(
        call.kwargs
        for call in forwarder._log.warn.call_args_list
        if call.args == ("bridge.send_error",)
    )
    assert warning["ack_id"] == "execution_complete:msg-1"
    assert (warning["buffer_size"], warning["pending_acks"], warning["in_flight_acks"]) == (1, 0, 0)
    assert forwarder.health_snapshot()["buffer_size"] == 1


@pytest.mark.asyncio
async def test_flush_failure_warning_reports_the_settled_state():
    forwarder = make_forwarder()
    await forwarder.send({"type": "execution_complete", "messageId": "msg-1"})
    ws = open_ws()
    ws.send = AsyncMock(side_effect=OSError("socket reset"))
    await forwarder.bind(ws)

    warning = next(
        call.kwargs
        for call in forwarder._log.warn.call_args_list
        if call.args == ("bridge.flush_send_error",)
    )
    assert (warning["buffer_size"], warning["pending_acks"], warning["in_flight_acks"]) == (1, 0, 0)


@pytest.mark.asyncio
async def test_critical_eviction_is_always_reported_and_stale_drops_are_not():
    forwarder = make_forwarder(max_buffer_size=1)
    for index in range(3):
        await forwarder.send({"type": "execution_complete", "messageId": f"msg-{index}"})
    assert forwarder._log.warn.call_count == 2
    last = forwarder._log.warn.call_args.kwargs
    assert last["critical"] is True
    assert last["ack_id"] == "execution_complete:msg-1"
    assert last["evicted_critical_events"] == 2
    assert last["buffer_size"] == 1

    before = forwarder.health_snapshot()
    assert await forwarder.send({"type": "boot_progress"}, buffered=False) is False
    assert forwarder.health_snapshot() == before
    assert forwarder._log.warn.call_count == 2
    forwarder._log.debug.assert_any_call("bridge.event_dropped_unbound", event_type="boot_progress")


@pytest.mark.asyncio
async def test_health_snapshot_tracks_ack_pressure_without_exposing_payloads():
    forwarder = make_forwarder()
    await forwarder.send({"type": "execution_complete", "messageId": "msg-1"})
    assert forwarder.health_snapshot()["buffer_size"] == 1
    ws = open_ws()

    async def send(_payload):
        health = forwarder.health_snapshot()
        assert health["pending_acks"] == health["in_flight_acks"] == 1

    ws.send = AsyncMock(side_effect=send)
    await forwarder.bind(ws)
    assert forwarder.health_snapshot()["buffer_size"] == 0
    assert forwarder.health_snapshot()["pending_acks"] == 1
    assert forwarder.health_snapshot()["in_flight_acks"] == 0
    assert forwarder.acknowledge("execution_complete:msg-1") is True
    assert forwarder.health_snapshot()["pending_acks"] == 0


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


async def _run_supervised(bridge, cmd, *, before_start=None):
    """Run a prompt through the supervisor that owns its terminal event."""
    bridge.activity.start_prompt(cmd["messageId"], lambda: bridge._handle_prompt(cmd))
    task = bridge.activity.current_prompt_task
    if before_start is not None:
        before_start(task)
    await asyncio.gather(task, return_exceptions=True)
    # Let the done callback select the terminal event and deliver it.
    for _ in range(3):
        await asyncio.sleep(0)
    summary = next(
        call.kwargs for call in bridge.log.info.call_args_list if call.args == ("prompt.run",)
    )
    completion = next(
        call.args[0]
        for call in bridge._send_event.await_args_list
        if call.args[0].get("type") == "execution_complete"
    )
    return summary, completion


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure", [None, "harness_failure", "no_output", "cancelled", "interrupted", "exception"]
)
async def test_prompt_summary_records_turn_metadata(bridge, failure):
    failure_detail = "provider rejected the request"

    async def run_prompt(_prompt, emit):
        if failure != "no_output":
            await emit({"type": "tool_call", "messageId": "msg-1", "args": {"secret": "private"}})
            await emit({"type": "step_finish", "messageCostUsd": 0.25})
        if failure == "exception":
            raise ValueError(failure_detail)
        if failure == "interrupted":
            raise asyncio.CancelledError
        if failure == "cancelled":
            return TurnOutcome(
                success=False, error="private", cancelled=True, message_cost_usd=0.25
            )
        if failure == "harness_failure":
            return TurnOutcome.failed(failure_detail, message_cost_usd=0.5)
        return TurnOutcome.ok()

    bridge.harness.run_prompt = run_prompt
    summary, completion = await _run_supervised(
        bridge, {"messageId": "msg-1", "content": "private prompt"}
    )
    assert summary["outcome"] == (
        "success"
        if failure is None
        else "cancelled"
        if failure in ("cancelled", "interrupted")
        else "error"
    )
    assert summary["phase"] == (
        "harness" if failure in ("exception", "interrupted") else "output_checks"
    )
    assert summary["error_category"] == ("cancelled" if failure == "interrupted" else failure)
    assert summary["emitted_event_count"] == (0 if failure == "no_output" else 2)
    assert summary["tool_call_event_count"] == (0 if failure == "no_output" else 1)
    assert summary["duration_ms"] >= 0
    assert summary["error_type"] == ("ValueError" if failure == "exception" else None)
    assert "private prompt" not in str(summary)
    assert completion["success"] is (failure is None)
    assert summary["error_detail"] == completion.get("error")
    if failure != "no_output":
        assert summary["message_cost_usd"] == (0.5 if failure == "harness_failure" else 0.25)
        assert completion["messageCostUsd"] == summary["message_cost_usd"]
    else:
        assert "message_cost_usd" not in summary
    if failure == "harness_failure":
        assert completion["error"] == failure_detail
        assert summary["source_outcome"] == "error"


@pytest.mark.asyncio
async def test_preflight_failure_has_a_summary_even_without_a_harness_turn(bridge):
    failure_detail = "setup failed"
    bridge._prepare_turn.side_effect = RuntimeError(failure_detail)
    summary, completion = await _run_supervised(bridge, {"messageId": "msg-1"})
    assert summary["phase"] == "preflight"
    assert summary["source_outcome"] is None
    assert summary["error_category"] == "exception"
    assert summary["error_type"] == "RuntimeError"
    assert summary["emitted_event_count"] == 0
    assert summary["error_detail"] == completion["error"] == failure_detail


@pytest.mark.asyncio
async def test_prompt_summary_reports_the_supervisor_selected_terminal_event(bridge):
    async def run_prompt(_prompt, emit):
        await emit({"type": "token", "content": "done"})
        bridge.activity.set_prompt_interruption("sandbox_lifetime_expiring")
        return TurnOutcome.ok()

    bridge.harness.run_prompt = run_prompt
    summary, completion = await _run_supervised(bridge, {"messageId": "msg-1"})
    assert completion["success"] is False
    assert completion["error"] == "sandbox_lifetime_expiring"
    assert summary["outcome"] == "error"
    assert summary["source_outcome"] == "success"
    assert summary["error_category"] == "interrupted"
    assert summary["error_detail"] == "sandbox_lifetime_expiring"
    assert [call.args for call in bridge.log.info.call_args_list].count(("prompt.run",)) == 1


@pytest.mark.asyncio
async def test_prompt_cancelled_before_start_still_has_a_summary(bridge):
    summary, completion = await _run_supervised(
        bridge, {"messageId": "msg-1"}, before_start=lambda task: task.cancel()
    )
    bridge._prepare_turn.assert_not_awaited()
    assert completion == {
        "type": "execution_complete",
        "messageId": "msg-1",
        "success": False,
        "error": "Task was cancelled",
    }
    assert summary["phase"] == "not_started"
    assert summary["outcome"] == "cancelled"
    assert summary["error_category"] == "cancelled"
    assert summary["duration_ms"] >= 0


@pytest.mark.asyncio
@pytest.mark.parametrize("delay_seconds,send_seconds", [(0.0, 0.0), (6.0, 0.0), (0.0, 6.0)])
async def test_heartbeat_separates_scheduling_delay_from_send_time(
    bridge, monkeypatch, delay_seconds, send_seconds
):
    now = 0.0
    sleeps = []
    bridge.ws = open_ws()
    monkeypatch.setattr("sandbox_runtime.bridge.time.monotonic", lambda: now)

    async def sleep(seconds):
        nonlocal now
        sleeps.append(seconds)
        now += seconds + delay_seconds
        if len(sleeps) == 2:
            bridge.shutdown_event.set()

    async def send(event):
        nonlocal now
        assert event["type"] == "heartbeat"
        now += send_seconds
        return True

    monkeypatch.setattr("sandbox_runtime.bridge.asyncio.sleep", sleep)
    bridge._send_event = AsyncMock(side_effect=send)
    await bridge._heartbeat_loop()

    assert sleeps == [bridge.HEARTBEAT_INTERVAL] * 2
    assert bridge._send_event.await_count == 2
    warnings = [call.args[0] for call in bridge.log.warn.call_args_list]
    assert warnings.count("bridge.heartbeat_delayed") == (2 if delay_seconds else 0)
    assert warnings.count("bridge.heartbeat_send_slow") == (2 if send_seconds else 0)
    assert bridge._last_heartbeat == {
        "scheduling_delay_seconds": delay_seconds,
        "send_duration_seconds": send_seconds,
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

    summaries = health_logs()
    assert len(summaries) >= 2
    assert all(summary["connected"] is False for summary in summaries)
    assert all(summary["buffer_size"] == 1 for summary in summaries)
    assert summaries[-1]["reconnect_attempt_count"] > summaries[0]["reconnect_attempt_count"]
    assert summaries[-1]["heartbeat_delivered"] is None

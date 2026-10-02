"""Delivery diagnostics preserve existing buffering and prompt outcomes."""

import asyncio
import json
import logging
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
    bridge.log = MagicMock()
    bridge._send_event = AsyncMock(return_value=True)
    bridge._persist_rotated_session_id = AsyncMock()
    bridge._prepare_turn = AsyncMock(return_value=(bridge.harness, None))
    return bridge


def _format_summary(summary):
    # Exercise the production formatter, not a second test-only sanitizer.
    from sandbox_runtime.log_config import JSONFormatter

    record = logging.makeLogRecord(
        {
            "name": "bridge",
            "levelname": "INFO",
            "levelno": logging.INFO,
            "msg": "prompt.run",
            **summary,
        }
    )
    return JSONFormatter().format(record)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure", [None, "harness_failure", "no_output", "cancelled", "interrupted", "exception"]
)
async def test_prompt_summary_records_metadata_with_redacted_error(bridge, failure, monkeypatch):
    credential = "oi-test-known-credential-value"
    monkeypatch.setenv("ANTHROPIC_API_KEY", credential)
    failure_detail = f"provider rejected {credential}"

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
    completion = await bridge._handle_prompt({"messageId": "msg-1", "content": "private prompt"})
    summary = next(
        call.kwargs for call in bridge.log.info.call_args_list if call.args == ("prompt.run",)
    )
    assert summary["error_category"] == ("cancelled" if failure == "interrupted" else failure)
    assert summary["emitted_event_count"] == (0 if failure == "no_output" else 2)
    assert summary["tool_call_event_count"] == (0 if failure == "no_output" else 1)
    assert summary["duration_ms"] >= 0
    assert summary["error_type"] == ("ValueError" if failure == "exception" else None)
    rendered = _format_summary(summary)
    assert credential not in rendered
    assert "private prompt" not in rendered
    assert completion["success"] is (failure is None)
    if failure != "no_output":
        assert summary["message_cost_usd"] == (0.5 if failure == "harness_failure" else 0.25)
        assert completion["messageCostUsd"] == summary["message_cost_usd"]
    else:
        assert "message_cost_usd" not in summary
    if failure == "harness_failure":
        assert completion["error"] == failure_detail
        assert summary["source_outcome"] == "error"
    if failure in ("harness_failure", "exception"):
        assert "[redacted]" in json.loads(rendered)["error_detail"]


@pytest.mark.asyncio
async def test_preflight_failure_has_a_summary_even_without_a_harness_turn(bridge, monkeypatch):
    credential = "oi-test-known-setup-credential"
    monkeypatch.setenv("MODAL_API_SECRET", credential)
    failure_detail = f"setup failed with {credential}"
    bridge._prepare_turn.side_effect = RuntimeError(failure_detail)
    completion = await bridge._handle_prompt({"messageId": "msg-1"})
    summary = next(
        call.kwargs for call in bridge.log.info.call_args_list if call.args == ("prompt.run",)
    )
    assert summary["phase"] == "preflight"
    assert summary["source_outcome"] is None
    assert summary["error_category"] == "exception"
    assert summary["error_type"] == "RuntimeError"
    assert summary["emitted_event_count"] == 0
    rendered = _format_summary(summary)
    assert credential not in rendered
    assert "[redacted]" in json.loads(rendered)["error_detail"]
    assert completion["error"] == failure_detail


@pytest.mark.asyncio
async def test_formatted_prompt_failure_is_bounded_without_changing_terminal_error(
    bridge, monkeypatch
):
    from sandbox_runtime.log_config import MAX_LOG_JSON_BYTES
    from sandbox_runtime.log_safety import MAX_LOG_TEXT_CHARS

    credential = "oi-test-long-error-credential"
    monkeypatch.setenv("ANTHROPIC_API_KEY", credential)
    failure_detail = f"provider rejected {credential}: " + "x" * (MAX_LOG_TEXT_CHARS * 10)

    async def run_prompt(_prompt, _emit):
        return TurnOutcome.failed(failure_detail)

    bridge.harness.run_prompt = run_prompt
    completion = await bridge._handle_prompt({"messageId": "msg-1"})
    summary = next(
        call.kwargs for call in bridge.log.info.call_args_list if call.args == ("prompt.run",)
    )
    rendered = _format_summary(summary)
    detail = json.loads(rendered)["error_detail"]
    assert credential not in rendered
    assert "[redacted]" in detail
    assert "[truncated]" in detail
    assert len(detail) <= MAX_LOG_TEXT_CHARS
    assert len(rendered.encode("utf-8")) <= MAX_LOG_JSON_BYTES
    assert completion["error"] == failure_detail


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
    health_logs = [
        call.kwargs for call in bridge.log.info.call_args_list if call.args == ("bridge.health",)
    ]
    assert len(health_logs) == 1
    assert health_logs[0]["scheduling_delay_seconds"] == delay_seconds
    assert health_logs[0]["send_duration_seconds"] == send_seconds
    assert health_logs[0]["heartbeat_delivered"] is True
    assert health_logs[0]["connected"] is True


@pytest.mark.asyncio
async def test_disconnected_heartbeat_health_does_not_change_buffering(bridge, monkeypatch):
    now = 0.0
    sleeps = 0
    monkeypatch.setattr("sandbox_runtime.bridge.time.monotonic", lambda: now)

    async def sleep(seconds):
        nonlocal now, sleeps
        now += seconds
        sleeps += 1
        if sleeps == 2:
            bridge.shutdown_event.set()

    monkeypatch.setattr("sandbox_runtime.bridge.asyncio.sleep", sleep)
    await bridge._heartbeat_loop()
    bridge._send_event.assert_not_awaited()
    summary = next(
        call.kwargs for call in bridge.log.info.call_args_list if call.args == ("bridge.health",)
    )
    assert summary["connected"] is False
    assert summary["heartbeat_delivered"] is None
    assert summary["send_duration_seconds"] is None
    assert summary["buffer_size"] == 0

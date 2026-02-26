"""
Unit tests for the bridge ACK mechanism.

Tests that critical events get ackId attached, are tracked in _pending_acks,
cleared on ACK command, and re-sent on reconnect via _flush_pending_acks.
"""

import json
from unittest.mock import AsyncMock, MagicMock

import pytest
from websockets import State

from src.sandbox.bridge import AgentBridge


@pytest.fixture
def bridge() -> AgentBridge:
    """Create a bridge instance for testing."""
    b = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )
    b.opencode_session_id = "oc-session-123"
    return b


def _open_ws() -> MagicMock:
    """Create a mock WebSocket in OPEN state."""
    ws = MagicMock()
    ws.state = State.OPEN
    ws.send = AsyncMock()
    return ws


class TestAckIdGeneration:
    """Tests for _make_ack_id deterministic ID generation."""

    def test_deterministic_ack_id_with_message_id(self):
        event = {"type": "execution_complete", "messageId": "msg-1"}
        ack_id = AgentBridge._make_ack_id(event)
        assert ack_id == "execution_complete:msg-1"

    def test_random_ack_id_without_message_id(self):
        event = {"type": "snapshot_ready"}
        ack_id = AgentBridge._make_ack_id(event)
        assert ack_id.startswith("snapshot_ready:")
        # Random suffix should be 16 hex chars
        suffix = ack_id.split(":", 1)[1]
        assert len(suffix) == 16
        int(suffix, 16)  # Should not raise

    def test_random_ack_ids_are_unique(self):
        event = {"type": "snapshot_ready"}
        ids = {AgentBridge._make_ack_id(event) for _ in range(10)}
        assert len(ids) == 10


class TestSendCriticalEvent:
    """Tests that _send_event attaches ackId and tracks critical events."""

    @pytest.mark.asyncio
    async def test_send_critical_event_attaches_ack_id(self, bridge: AgentBridge):
        ws = _open_ws()
        bridge.ws = ws

        await bridge._send_event(
            {"type": "execution_complete", "messageId": "msg-1", "success": True}
        )

        sent_data = json.loads(ws.send.call_args[0][0])
        assert "ackId" in sent_data
        assert sent_data["ackId"] == "execution_complete:msg-1"

    @pytest.mark.asyncio
    async def test_send_critical_event_tracked_in_pending_acks(self, bridge: AgentBridge):
        ws = _open_ws()
        bridge.ws = ws

        await bridge._send_event(
            {"type": "execution_complete", "messageId": "msg-1", "success": True}
        )

        assert "execution_complete:msg-1" in bridge._pending_acks
        assert bridge._pending_acks["execution_complete:msg-1"]["type"] == "execution_complete"

    @pytest.mark.asyncio
    async def test_send_non_critical_event_no_ack_id(self, bridge: AgentBridge):
        ws = _open_ws()
        bridge.ws = ws

        await bridge._send_event({"type": "token", "content": "hello", "messageId": "msg-1"})

        sent_data = json.loads(ws.send.call_args[0][0])
        assert "ackId" not in sent_data
        assert len(bridge._pending_acks) == 0

    @pytest.mark.asyncio
    async def test_send_failure_buffers_not_pending(self, bridge: AgentBridge):
        ws = _open_ws()
        ws.send = AsyncMock(side_effect=ConnectionError("broken pipe"))
        bridge.ws = ws

        await bridge._send_event(
            {"type": "execution_complete", "messageId": "msg-1", "success": True}
        )

        # Should be in buffer, NOT in pending_acks
        assert len(bridge._event_buffer) == 1
        assert len(bridge._pending_acks) == 0

    @pytest.mark.asyncio
    async def test_existing_ack_id_not_overwritten(self, bridge: AgentBridge):
        ws = _open_ws()
        bridge.ws = ws

        await bridge._send_event(
            {
                "type": "execution_complete",
                "messageId": "msg-1",
                "success": True,
                "ackId": "custom:id",
            }
        )

        sent_data = json.loads(ws.send.call_args[0][0])
        assert sent_data["ackId"] == "custom:id"


class TestAckCommand:
    """Tests for handling ACK commands from control plane."""

    @pytest.mark.asyncio
    async def test_ack_command_clears_pending(self, bridge: AgentBridge):
        bridge._pending_acks["execution_complete:msg-1"] = {
            "type": "execution_complete",
            "messageId": "msg-1",
            "ackId": "execution_complete:msg-1",
        }

        await bridge._handle_command({"type": "ack", "ackId": "execution_complete:msg-1"})

        assert "execution_complete:msg-1" not in bridge._pending_acks

    @pytest.mark.asyncio
    async def test_ack_command_unknown_id_ignored(self, bridge: AgentBridge):
        bridge._pending_acks["execution_complete:msg-1"] = {
            "type": "execution_complete",
            "ackId": "execution_complete:msg-1",
        }

        # ACK for a different ID should not affect existing entries
        await bridge._handle_command({"type": "ack", "ackId": "execution_complete:msg-999"})

        assert "execution_complete:msg-1" in bridge._pending_acks

    @pytest.mark.asyncio
    async def test_ack_command_missing_ack_id_ignored(self, bridge: AgentBridge):
        bridge._pending_acks["execution_complete:msg-1"] = {
            "type": "execution_complete",
            "ackId": "execution_complete:msg-1",
        }

        await bridge._handle_command({"type": "ack"})

        assert len(bridge._pending_acks) == 1


class TestFlushPendingAcks:
    """Tests for _flush_pending_acks re-sending on new WS."""

    @pytest.mark.asyncio
    async def test_flush_pending_acks_resends(self, bridge: AgentBridge):
        bridge._pending_acks = {
            "execution_complete:msg-1": {
                "type": "execution_complete",
                "messageId": "msg-1",
                "ackId": "execution_complete:msg-1",
            },
            "error:msg-2": {
                "type": "error",
                "messageId": "msg-2",
                "ackId": "error:msg-2",
            },
        }

        ws = _open_ws()
        bridge.ws = ws

        await bridge._flush_pending_acks()

        assert ws.send.call_count == 2
        # Events should still be in _pending_acks (not removed until ACK arrives)
        assert len(bridge._pending_acks) == 2

    @pytest.mark.asyncio
    async def test_flush_pending_acks_noop_when_empty(self, bridge: AgentBridge):
        ws = _open_ws()
        bridge.ws = ws

        await bridge._flush_pending_acks()

        ws.send.assert_not_called()

    @pytest.mark.asyncio
    async def test_flush_pending_acks_stops_on_ws_failure(self, bridge: AgentBridge):
        call_count = 0

        async def fail_on_second(data):
            nonlocal call_count
            call_count += 1
            if call_count >= 2:
                raise ConnectionError("broken")

        bridge._pending_acks = {
            "a:1": {"type": "execution_complete", "ackId": "a:1"},
            "b:2": {"type": "error", "ackId": "b:2"},
        }

        ws = _open_ws()
        ws.send = fail_on_second
        bridge.ws = ws

        await bridge._flush_pending_acks()

        # Both should still be in pending (first sent OK, second failed, but
        # neither removed — removal only happens on ACK command)
        assert len(bridge._pending_acks) == 2


class TestBufferFlushAddsToPending:
    """Tests that flushing buffer events adds critical ones to _pending_acks."""

    @pytest.mark.asyncio
    async def test_buffer_flush_adds_critical_to_pending_acks(self, bridge: AgentBridge):
        bridge._event_buffer = [
            {
                "type": "execution_complete",
                "messageId": "msg-1",
                "ackId": "execution_complete:msg-1",
            },
            {"type": "token", "content": "hello"},
        ]

        ws = _open_ws()
        bridge.ws = ws

        just_added = await bridge._flush_event_buffer()

        assert len(bridge._event_buffer) == 0
        # Only the critical event should be in pending_acks
        assert "execution_complete:msg-1" in bridge._pending_acks
        assert len(bridge._pending_acks) == 1
        # Return value should contain the ackId just added
        assert just_added == {"execution_complete:msg-1"}

    @pytest.mark.asyncio
    async def test_buffer_flush_returns_empty_set_for_non_critical(self, bridge: AgentBridge):
        bridge._event_buffer = [{"type": "token", "content": "hello"}]

        ws = _open_ws()
        bridge.ws = ws

        just_added = await bridge._flush_event_buffer()

        assert just_added == set()
        assert len(bridge._pending_acks) == 0


class TestFlushPendingAcksSkip:
    """Tests that _flush_pending_acks skips ackIds from buffer flush."""

    @pytest.mark.asyncio
    async def test_skip_ack_ids_prevents_double_send(self, bridge: AgentBridge):
        """Events just flushed from buffer should not be re-sent by pending ack flush."""
        bridge._pending_acks = {
            "execution_complete:msg-1": {
                "type": "execution_complete",
                "ackId": "execution_complete:msg-1",
            },
            "error:msg-2": {
                "type": "error",
                "ackId": "error:msg-2",
            },
        }

        ws = _open_ws()
        bridge.ws = ws

        # Simulate: msg-1 was just flushed from buffer, msg-2 was from a prior send
        await bridge._flush_pending_acks(skip_ack_ids={"execution_complete:msg-1"})

        # Only msg-2 should have been sent
        assert ws.send.call_count == 1
        sent_data = json.loads(ws.send.call_args[0][0])
        assert sent_data["ackId"] == "error:msg-2"
        # Both should still be in _pending_acks
        assert len(bridge._pending_acks) == 2


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

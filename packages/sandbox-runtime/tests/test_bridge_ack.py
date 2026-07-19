"""
Bridge boundary tests for event sending and the ACK command.

Forwarder-level mechanics (ackId generation, pending tracking, bind-time
backlog recovery) are covered in test_event_forwarder.py; these tests cover
only the bridge's wiring into BufferedEventForwarder: `_send_event`
delegation and the `ack` command routing into `acknowledge`.
"""

import json
from unittest.mock import AsyncMock, MagicMock

import pytest
from websockets import State

from sandbox_runtime.bridge import AgentBridge


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


async def _send_critical(bridge: AgentBridge, message_id: str) -> MagicMock:
    """Send a critical event through the bridge so its ACK is pending."""
    ws = _open_ws()
    await bridge.event_forwarder.bind(ws)
    await bridge._send_event(
        {"type": "execution_complete", "messageId": message_id, "success": True}
    )
    return ws


class TestSendEventDelegation:
    """_send_event routes through the forwarder, which stamps identity."""

    @pytest.mark.asyncio
    async def test_send_event_delegates_to_forwarder(self, bridge: AgentBridge):
        ws = await _send_critical(bridge, "msg-1")

        sent_data = json.loads(ws.send.call_args[0][0])
        assert sent_data["sandboxId"] == "test-sandbox"
        assert sent_data["ackId"] == "execution_complete:msg-1"


class TestAckCommand:
    """The `ack` command from the control plane clears the pending event."""

    @pytest.mark.asyncio
    async def test_ack_command_clears_pending(self, bridge: AgentBridge):
        await _send_critical(bridge, "msg-1")

        await bridge._handle_command({"type": "ack", "ackId": "execution_complete:msg-1"})

        # Already cleared: a second acknowledge reports not-found
        assert bridge.event_forwarder.acknowledge("execution_complete:msg-1") is False

    @pytest.mark.asyncio
    async def test_ack_command_unknown_id_ignored(self, bridge: AgentBridge):
        await _send_critical(bridge, "msg-1")

        # ACK for a different ID should not affect existing entries
        await bridge._handle_command({"type": "ack", "ackId": "execution_complete:msg-999"})

        assert bridge.event_forwarder.acknowledge("execution_complete:msg-1") is True

    @pytest.mark.asyncio
    async def test_ack_command_missing_ack_id_ignored(self, bridge: AgentBridge):
        await _send_critical(bridge, "msg-1")

        await bridge._handle_command({"type": "ack"})

        assert bridge.event_forwarder.acknowledge("execution_complete:msg-1") is True


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

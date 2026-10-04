"""Bridge ACK routing through the real forwarder, including while booting."""

import pytest

from sandbox_runtime.bridge import AgentBridge
from tests.conftest import ScriptedHarness
from tests.event_forwarder_fakes import open_ws, sent_events


@pytest.fixture(params=[False, True], ids=["attached", "booting"])
def bridge(request: pytest.FixtureRequest) -> AgentBridge:
    return AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
        early_connect=request.param,
        harness_factory=ScriptedHarness,
    )


@pytest.fixture
async def pending_ack(bridge: AgentBridge) -> str:
    ws = open_ws()
    await bridge.event_forwarder.bind(ws)
    assert await bridge._send_event(
        {"type": "execution_complete", "messageId": "msg-1", "success": True}
    )
    [event] = sent_events(ws)
    ack_id = event["ackId"]
    assert ack_id in bridge.event_forwarder._pending_acks
    return ack_id


async def test_ack_command_clears_pending(bridge: AgentBridge, pending_ack: str) -> None:
    await bridge._handle_command({"type": "ack", "ackId": pending_ack})

    assert bridge.event_forwarder.acknowledge(pending_ack) is False


@pytest.mark.parametrize(
    "command",
    [{"type": "ack", "ackId": "execution_complete:unknown"}, {"type": "ack"}],
    ids=["unknown-id", "missing-id"],
)
async def test_unmatched_ack_keeps_pending(
    bridge: AgentBridge, pending_ack: str, command: dict
) -> None:
    await bridge._handle_command(command)

    assert bridge.event_forwarder.acknowledge(pending_ack) is True

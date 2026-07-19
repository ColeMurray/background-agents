"""
Bridge boundary tests for the event-forwarder connection lifecycle and
prompt task decoupling.

Forwarder-level buffering/flush/eviction mechanics are covered in
test_event_forwarder.py; here we test only what the bridge owns: binding and
unbinding the forwarder around a connection, delivery of events produced
while disconnected, and prompt tasks surviving WS disconnects.
"""

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from websockets import State

from sandbox_runtime.bridge import AgentBridge
from tests.conftest import MockResponse, wire_opencode_transport


class MockHttpClient:
    """Mock HTTP client for bridge lifecycle tests."""

    def __init__(self):
        self.post_responses: list[Any] = []
        self.get_responses: list[Any] = []
        self.post_urls: list[str] = []

    async def post(self, url: str, json: dict | None = None, timeout: float = 30.0) -> Any:
        self.post_urls.append(url)
        if self.post_responses:
            return self.post_responses.pop(0)
        return MockResponse(204)

    async def get(self, url: str, timeout: float = 10.0) -> Any:
        if self.get_responses:
            return self.get_responses.pop(0)
        return MockResponse(200, [])

    async def aclose(self):
        pass


class FakeWs:
    """Fake websocket connection: records sends, yields no inbound messages."""

    def __init__(self):
        self.state = State.OPEN
        self.sent: list[str] = []
        self.close_code = 1000

    async def send(self, data: str) -> None:
        self.sent.append(data)

    def __aiter__(self):
        return self

    async def __anext__(self):
        raise StopAsyncIteration


class ConnectionContext:
    """Async context manager standing in for websockets.connect()."""

    def __init__(self, ws: FakeWs):
        self.ws = ws

    async def __aenter__(self) -> FakeWs:
        return self.ws

    async def __aexit__(self, *_args) -> bool:
        return False


@pytest.fixture
def bridge() -> AgentBridge:
    """Create a bridge instance for testing."""
    bridge = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )
    bridge.opencode_session_id = "oc-session-123"
    wire_opencode_transport(bridge, MockHttpClient())
    return bridge


class TestConnectionLifecycle:
    """_connect_and_run binds the forwarder for the connection's lifetime."""

    @pytest.mark.asyncio
    async def test_connect_binds_recovers_backlog_and_unbinds(
        self, bridge: AgentBridge, monkeypatch
    ):
        ws = FakeWs()
        monkeypatch.setattr(
            "sandbox_runtime.bridge.websockets.connect",
            lambda *_args, **_kwargs: ConnectionContext(ws),
        )

        # An event produced while disconnected waits in the forwarder
        await bridge._send_event({"type": "execution_complete", "messageId": "msg-1"})

        await bridge._connect_and_run()

        types = [json.loads(data)["type"] for data in ws.sent]
        # bind() delivered the disconnected-era backlog, then the ready event
        assert types[0] == "execution_complete"
        assert "ready" in types

        # The connection closed, so the forwarder is unbound again: new
        # events buffer instead of going to the dead socket.
        sent_before = len(ws.sent)
        await bridge._send_event({"type": "token", "content": "after close"})
        assert len(ws.sent) == sent_before


class TestPromptTaskDecoupling:
    """Tests that prompt tasks survive WS disconnects."""

    @pytest.mark.asyncio
    async def test_prompt_task_survives_ws_disconnect(self, bridge: AgentBridge):
        """Prompt task should NOT be cancelled when WS disconnects."""
        prompt_started = asyncio.Event()
        prompt_can_finish = asyncio.Event()

        async def slow_prompt(cmd):
            prompt_started.set()
            await prompt_can_finish.wait()

        bridge._handle_prompt = slow_prompt

        # Start a prompt
        await bridge._handle_command({"type": "prompt", "messageId": "msg-1", "content": "test"})
        task = bridge._current_prompt_task
        assert task is not None

        await prompt_started.wait()

        # Simulate what _connect_and_run's finally block does:
        # cancel heartbeat + background_tasks, set ws = None.
        # The prompt task should NOT be in background_tasks anymore.
        bridge.ws = None
        bridge.event_forwarder.unbind()

        # The task should still be running
        assert not task.done()

        # Let it finish
        prompt_can_finish.set()
        await task
        await asyncio.sleep(0)

    @pytest.mark.asyncio
    async def test_prompt_task_cancelled_on_run_exit(self, bridge: AgentBridge):
        """run() finally block should cancel the prompt task before closing http_client."""
        prompt_started = asyncio.Event()

        async def slow_prompt(cmd):
            prompt_started.set()
            await asyncio.sleep(3600)

        bridge._handle_prompt = slow_prompt

        await bridge._handle_command({"type": "prompt", "messageId": "msg-1", "content": "test"})
        task = bridge._current_prompt_task
        assert task is not None

        await prompt_started.wait()

        # Simulate run() exit: shutdown_event causes loop break, then finally block
        bridge.shutdown_event.set()

        # run()'s finally block cancels _current_prompt_task
        await bridge.run()

        assert task.done()

    @pytest.mark.asyncio
    async def test_execution_complete_while_disconnected_delivered_on_bind(
        self, bridge: AgentBridge
    ):
        """execution_complete sent while WS is down must arrive on reconnect."""
        await bridge._send_event(
            {
                "type": "execution_complete",
                "messageId": "msg-1",
                "success": True,
            }
        )

        mock_ws = MagicMock()
        mock_ws.state = State.OPEN
        sent_data: list[str] = []
        mock_ws.send = AsyncMock(side_effect=lambda data: sent_data.append(data))
        await bridge.event_forwarder.bind(mock_ws)

        assert len(sent_data) == 1
        parsed = json.loads(sent_data[0])
        assert parsed["type"] == "execution_complete"
        assert parsed["messageId"] == "msg-1"
        assert parsed["success"] is True


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

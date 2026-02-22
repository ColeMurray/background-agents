"""
Unit tests for bridge event buffer and prompt task decoupling.

Tests that events are buffered when WS is unavailable, flushed on reconnect,
and that prompt tasks survive WS disconnects.
"""

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from websockets import State

from src.sandbox.bridge import AgentBridge
from tests.conftest import MockResponse


class MockHttpClient:
    """Mock HTTP client for event buffer tests."""

    def __init__(self):
        self.post_responses: list[Any] = []
        self.get_responses: list[Any] = []
        self.sse_events: list[str] = []
        self._post_call_count = 0
        self.post_urls: list[str] = []

    async def post(self, url: str, json: dict | None = None, timeout: float = 30.0) -> Any:
        self._post_call_count += 1
        self.post_urls.append(url)
        if self.post_responses:
            return self.post_responses.pop(0)
        return MockResponse(204)

    async def get(self, url: str, timeout: float = 10.0) -> Any:
        if self.get_responses:
            return self.get_responses.pop(0)
        return MockResponse(200, [])

    def stream(self, method: str, url: str, timeout: Any = None):
        return MockSSEResponse(self.sse_events)

    async def aclose(self):
        pass


class MockSSEResponse:
    """Mock SSE streaming response."""

    def __init__(self, events: list[str], status_code: int = 200):
        self.status_code = status_code
        self._events = events

    async def aiter_text(self):
        for event in self._events:
            yield event
            await asyncio.sleep(0)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


def create_sse_event(event_type: str, properties: dict) -> str:
    """Create an SSE event string."""
    data = {"type": event_type, "properties": properties}
    return f"data: {json.dumps(data)}\n\n"


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
    bridge.http_client = MockHttpClient()
    return bridge


class TestEventBuffering:
    """Tests for event buffering when WS is unavailable."""

    @pytest.mark.asyncio
    async def test_send_event_buffers_when_ws_none(self, bridge: AgentBridge):
        """Events should be buffered, not dropped, when WS is None."""
        bridge.ws = None

        await bridge._send_event({"type": "token", "content": "hello"})

        assert len(bridge._event_buffer) == 1
        assert bridge._event_buffer[0]["type"] == "token"
        assert bridge._event_buffer[0]["content"] == "hello"
        # sandboxId and timestamp should be stamped
        assert bridge._event_buffer[0]["sandboxId"] == "test-sandbox"
        assert "timestamp" in bridge._event_buffer[0]

    @pytest.mark.asyncio
    async def test_send_event_buffers_when_ws_not_open(self, bridge: AgentBridge):
        """Events should be buffered when WS exists but is not OPEN."""
        mock_ws = MagicMock()
        mock_ws.state = State.CLOSED
        bridge.ws = mock_ws

        await bridge._send_event({"type": "execution_complete", "messageId": "msg-1"})

        assert len(bridge._event_buffer) == 1
        assert bridge._event_buffer[0]["type"] == "execution_complete"

    @pytest.mark.asyncio
    async def test_send_event_buffers_on_send_exception(self, bridge: AgentBridge):
        """Events should be buffered when ws.send() throws."""
        mock_ws = MagicMock()
        mock_ws.state = State.OPEN
        mock_ws.send = AsyncMock(side_effect=ConnectionError("broken pipe"))
        bridge.ws = mock_ws

        await bridge._send_event({"type": "token", "content": "data"})

        assert len(bridge._event_buffer) == 1
        assert bridge._event_buffer[0]["type"] == "token"

    def test_buffer_overflow_evicts_non_critical_first(self, bridge: AgentBridge):
        """When buffer is full, non-critical events should be evicted before critical ones."""
        # Fill buffer with a mix of critical and non-critical events
        bridge._event_buffer = [
            {"type": "execution_complete", "messageId": "msg-1"},  # critical
            {"type": "token", "content": "a"},  # non-critical
            {"type": "error", "messageId": "msg-2"},  # critical
        ]
        bridge.MAX_EVENT_BUFFER_SIZE = 3

        bridge._buffer_event({"type": "snapshot_ready"})

        # Buffer should still be size 3 (one evicted, one added)
        assert len(bridge._event_buffer) == 3
        # The non-critical "token" event should have been evicted
        types = [e["type"] for e in bridge._event_buffer]
        assert "token" not in types
        assert "execution_complete" in types
        assert "error" in types
        assert "snapshot_ready" in types

    def test_buffer_overflow_evicts_oldest_critical_if_all_critical(self, bridge: AgentBridge):
        """When all events are critical, oldest gets evicted."""
        bridge._event_buffer = [
            {"type": "execution_complete", "messageId": "msg-1"},
            {"type": "error", "messageId": "msg-2"},
        ]
        bridge.MAX_EVENT_BUFFER_SIZE = 2

        bridge._buffer_event({"type": "push_complete"})

        assert len(bridge._event_buffer) == 2
        # Oldest critical (execution_complete) should be evicted
        types = [e["type"] for e in bridge._event_buffer]
        assert "execution_complete" not in types
        assert "error" in types
        assert "push_complete" in types


class TestEventFlush:
    """Tests for flushing buffered events on reconnect."""

    @pytest.mark.asyncio
    async def test_flush_sends_all_and_clears_buffer(self, bridge: AgentBridge):
        """Flushing should send all buffered events and clear the buffer."""
        mock_ws = MagicMock()
        mock_ws.state = State.OPEN
        sent_data: list[str] = []
        mock_ws.send = AsyncMock(side_effect=lambda data: sent_data.append(data))
        bridge.ws = mock_ws

        bridge._event_buffer = [
            {"type": "token", "content": "a"},
            {"type": "execution_complete", "messageId": "msg-1"},
        ]

        await bridge._flush_event_buffer()

        assert len(bridge._event_buffer) == 0
        assert len(sent_data) == 2
        assert json.loads(sent_data[0])["type"] == "token"
        assert json.loads(sent_data[1])["type"] == "execution_complete"

    @pytest.mark.asyncio
    async def test_flush_stops_on_send_failure(self, bridge: AgentBridge):
        """Flushing should stop when a send fails, keeping remaining events buffered."""
        mock_ws = MagicMock()
        mock_ws.state = State.OPEN
        call_count = 0

        async def flaky_send(data):
            nonlocal call_count
            call_count += 1
            if call_count >= 2:
                raise ConnectionError("broken")

        mock_ws.send = flaky_send
        bridge.ws = mock_ws

        bridge._event_buffer = [
            {"type": "token", "content": "a"},
            {"type": "token", "content": "b"},
            {"type": "execution_complete", "messageId": "msg-1"},
        ]

        await bridge._flush_event_buffer()

        # First event sent successfully, second failed
        assert len(bridge._event_buffer) == 2
        assert bridge._event_buffer[0]["content"] == "b"
        assert bridge._event_buffer[1]["type"] == "execution_complete"

    @pytest.mark.asyncio
    async def test_flush_noop_when_buffer_empty(self, bridge: AgentBridge):
        """Flushing an empty buffer should be a no-op."""
        assert len(bridge._event_buffer) == 0
        await bridge._flush_event_buffer()
        assert len(bridge._event_buffer) == 0


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
    async def test_execution_complete_buffered_and_flushed(self, bridge: AgentBridge):
        """execution_complete should be buffered when WS is down and flushed on reconnect."""
        bridge.ws = None

        # Simulate _handle_prompt completing and sending execution_complete
        await bridge._send_event(
            {
                "type": "execution_complete",
                "messageId": "msg-1",
                "success": True,
            }
        )

        assert len(bridge._event_buffer) == 1
        assert bridge._event_buffer[0]["type"] == "execution_complete"

        # Simulate reconnect
        mock_ws = MagicMock()
        mock_ws.state = State.OPEN
        sent_data: list[str] = []
        mock_ws.send = AsyncMock(side_effect=lambda data: sent_data.append(data))
        bridge.ws = mock_ws

        await bridge._flush_event_buffer()

        assert len(bridge._event_buffer) == 0
        assert len(sent_data) == 1
        parsed = json.loads(sent_data[0])
        assert parsed["type"] == "execution_complete"
        assert parsed["messageId"] == "msg-1"
        assert parsed["success"] is True

    @pytest.mark.asyncio
    async def test_inflight_message_id_set_on_prompt(self, bridge: AgentBridge):
        """_handle_prompt should set _inflight_message_id."""
        http_client = bridge.http_client
        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]

        await bridge._handle_command({"type": "prompt", "messageId": "msg-42", "content": "test"})
        task = bridge._current_prompt_task
        assert task is not None

        # Let the task run so _handle_prompt sets _inflight_message_id
        await task
        await asyncio.sleep(0)

        assert bridge._inflight_message_id == "msg-42"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

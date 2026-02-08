"""
Unit tests for bridge stop behavior.

Tests that _handle_stop cancels the current prompt task and that
the task lifecycle correctly manages _current_prompt_task.
"""

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.sandbox.bridge import AgentBridge
from tests.conftest import MockResponse


class MockHttpClient:
    """Mock HTTP client for stop tests."""

    def __init__(self):
        self.post_responses: list[Any] = []
        self.get_responses: list[Any] = []
        self.sse_events: list[str] = []
        self._post_call_count = 0
        self._get_call_count = 0
        self.post_urls: list[str] = []

    async def post(self, url: str, json: dict | None = None, timeout: float = 30.0) -> Any:
        self._post_call_count += 1
        self.post_urls.append(url)
        if self.post_responses:
            return self.post_responses.pop(0)
        return MockResponse(204)

    async def get(self, url: str, timeout: float = 10.0) -> Any:
        self._get_call_count += 1
        if self.get_responses:
            return self.get_responses.pop(0)
        return MockResponse(200, [])

    def stream(self, method: str, url: str, timeout: Any = None):
        return MockSSEResponse(self.sse_events)


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


class TestHandleStop:
    """Tests for _handle_stop and _current_prompt_task management."""

    @pytest.mark.asyncio
    async def test_handle_stop_cancels_current_prompt_task(self, bridge: AgentBridge):
        """When a prompt task is running, _handle_stop should cancel it."""
        mock_task = MagicMock(spec=asyncio.Task)
        mock_task.done.return_value = False
        bridge._current_prompt_task = mock_task

        await bridge._handle_stop()

        mock_task.cancel.assert_called_once()

    @pytest.mark.asyncio
    async def test_handle_stop_with_no_running_task(self, bridge: AgentBridge):
        """When no prompt task exists, _handle_stop should not error."""
        assert bridge._current_prompt_task is None

        # Should not raise
        await bridge._handle_stop()

        # Still calls opencode stop (best-effort)
        http_client = bridge.http_client
        assert any(url.endswith("/stop") for url in http_client.post_urls)

    @pytest.mark.asyncio
    async def test_handle_stop_with_completed_task(self, bridge: AgentBridge):
        """When prompt task is already done, cancel() should NOT be called."""
        mock_task = MagicMock(spec=asyncio.Task)
        mock_task.done.return_value = True
        bridge._current_prompt_task = mock_task

        await bridge._handle_stop()

        mock_task.cancel.assert_not_called()

    @pytest.mark.asyncio
    async def test_prompt_task_cleared_on_completion(self, bridge: AgentBridge):
        """After a prompt completes normally, _current_prompt_task should be None."""
        http_client = bridge.http_client

        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]

        # Run a prompt command
        task = await bridge._handle_command({
            "type": "prompt",
            "messageId": "msg-1",
            "content": "hello",
        })

        # Wait for task to complete
        assert task is not None
        await task

        # Give the done callback a chance to fire
        await asyncio.sleep(0)

        assert bridge._current_prompt_task is None

    @pytest.mark.asyncio
    async def test_prompt_task_set_when_created(self, bridge: AgentBridge):
        """_handle_command('prompt') should set _current_prompt_task immediately."""
        http_client = bridge.http_client

        # SSE events that complete immediately
        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]

        task = await bridge._handle_command({
            "type": "prompt",
            "messageId": "msg-1",
            "content": "hello",
        })

        # Task should be set before completion
        assert bridge._current_prompt_task is task
        assert task is not None

        # Clean up
        await task
        await asyncio.sleep(0)

    @pytest.mark.asyncio
    async def test_cancelled_task_sends_execution_complete(self, bridge: AgentBridge):
        """Cancelling the prompt task should trigger execution_complete with success=False."""
        sent_events: list[dict] = []
        original_send = bridge._send_event

        async def capture_send(event: dict) -> None:
            sent_events.append(event)

        bridge._send_event = capture_send

        http_client = bridge.http_client

        # Use SSE that hangs forever so we can cancel it
        class HangingSSEResponse:
            status_code = 200

            async def aiter_text(self):
                yield create_sse_event("server.connected", {})
                await asyncio.sleep(3600)

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

        http_client.stream = lambda *a, **kw: HangingSSEResponse()

        task = await bridge._handle_command({
            "type": "prompt",
            "messageId": "msg-cancel-test",
            "content": "will be cancelled",
        })

        assert task is not None

        # Let the task start
        await asyncio.sleep(0.05)

        # Cancel it
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

        # Give the done callback a chance to fire and the
        # inner asyncio.create_task to run
        await asyncio.sleep(0.1)

        # Verify execution_complete was sent with success=False
        exec_complete = [e for e in sent_events if e.get("type") == "execution_complete"]
        assert len(exec_complete) == 1
        assert exec_complete[0]["messageId"] == "msg-cancel-test"
        assert exec_complete[0]["success"] is False


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

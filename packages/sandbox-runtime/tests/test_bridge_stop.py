"""
Unit tests for bridge stop behavior.

Tests that _handle_stop cancels the current prompt task and that
the task lifecycle correctly manages _current_prompt_task.
"""

import asyncio
import contextlib
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from websockets import State

from sandbox_runtime.bridge import AgentBridge
from tests.conftest import MockResponse, wire_opencode_transport


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
    bridge.harness.session_id = "oc-session-123"
    wire_opencode_transport(bridge, MockHttpClient())
    return bridge


class TestHandleStop:
    """Tests for _handle_stop and _current_prompt_task management."""

    @pytest.mark.asyncio
    async def test_handle_stop_cancels_current_prompt_task(self, bridge: AgentBridge):
        """When a prompt task is running, _handle_stop should cancel it."""
        task = asyncio.create_task(asyncio.Event().wait())
        bridge.activity.track_prompt("msg-1", task)

        await bridge._handle_stop()

        with pytest.raises(asyncio.CancelledError):
            await task

    @pytest.mark.asyncio
    async def test_handle_stop_with_no_running_task(self, bridge: AgentBridge):
        """When no prompt task exists, _handle_stop should not error."""
        assert bridge.activity.current_prompt_task is None

        # Should not raise
        await bridge._handle_stop()

        # Still calls opencode abort (best-effort)
        http_client = bridge.http_client
        assert any(url.endswith("/abort") for url in http_client.post_urls)

    @pytest.mark.asyncio
    async def test_handle_stop_with_completed_task(self, bridge: AgentBridge):
        """When prompt task is already done, cancel() should NOT be called."""
        task = asyncio.create_task(
            asyncio.sleep(
                0,
                result={
                    "type": "execution_complete",
                    "messageId": "msg-1",
                    "success": True,
                },
            )
        )
        await task
        bridge.activity.track_prompt("msg-1", task)

        await bridge._handle_stop()

        assert not task.cancelled()

    @pytest.mark.asyncio
    async def test_prompt_task_cleared_on_completion(self, bridge: AgentBridge):
        """After a prompt completes normally, _current_prompt_task should be None."""
        http_client = bridge.http_client

        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]

        # _handle_command returns None for prompts (decoupled from WS lifecycle)
        result = await bridge._handle_command(
            {
                "type": "prompt",
                "messageId": "msg-1",
                "content": "hello",
            }
        )
        assert result is None

        # But _current_prompt_task should be set
        task = bridge.activity.current_prompt_task
        assert task is not None

        # Wait for task to complete
        await task

        # Give the done callback a chance to fire
        await asyncio.sleep(0)

        assert bridge.activity.current_prompt_task is None

    @pytest.mark.asyncio
    async def test_prompt_task_set_when_created(self, bridge: AgentBridge):
        """_handle_command('prompt') should set _current_prompt_task immediately."""
        http_client = bridge.http_client

        # SSE events that complete immediately
        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]

        result = await bridge._handle_command(
            {
                "type": "prompt",
                "messageId": "msg-1",
                "content": "hello",
            }
        )

        # _handle_command returns None for prompts (not added to background_tasks)
        assert result is None

        # But _current_prompt_task should be set
        task = bridge.activity.current_prompt_task
        assert task is not None

        # Clean up
        await task
        await asyncio.sleep(0)

    @pytest.mark.asyncio
    async def test_older_prompt_completion_does_not_clear_newer_task(self, bridge: AgentBridge):
        """Completing an older prompt must not clear a newer _current_prompt_task."""
        old_can_finish = asyncio.Event()
        new_can_finish = asyncio.Event()

        async def fake_handle_prompt(cmd: dict[str, Any]) -> dict[str, Any]:
            message_id = cmd.get("messageId")
            if message_id == "msg-old":
                await old_can_finish.wait()
            elif message_id == "msg-new":
                await new_can_finish.wait()
            else:
                raise AssertionError(f"Unexpected messageId: {message_id}")
            return {"type": "execution_complete", "messageId": message_id, "success": True}

        bridge._handle_prompt = fake_handle_prompt

        await bridge._handle_command(
            {
                "type": "prompt",
                "messageId": "msg-old",
                "content": "old",
            }
        )
        old_task = bridge.activity.current_prompt_task
        assert old_task is not None

        await bridge._handle_command(
            {
                "type": "prompt",
                "messageId": "msg-new",
                "content": "new",
            }
        )
        new_task = bridge.activity.current_prompt_task
        assert new_task is not None
        assert bridge.activity.current_prompt_task is new_task

        old_can_finish.set()
        await old_task
        await asyncio.sleep(0)

        assert bridge.activity.current_prompt_task is new_task

        new_can_finish.set()
        await new_task
        await asyncio.sleep(0)

    @pytest.mark.asyncio
    async def test_cancelled_task_sends_execution_complete(self, bridge: AgentBridge):
        """Cancelling the prompt task should trigger execution_complete with success=False."""
        sent_events: list[dict] = []

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

        await bridge._handle_command(
            {
                "type": "prompt",
                "messageId": "msg-cancel-test",
                "content": "will be cancelled",
            }
        )

        task = bridge.activity.current_prompt_task
        assert task is not None

        # Let the task start
        await asyncio.sleep(0.05)

        # Cancel it
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

        # Give the done callback a chance to fire and the
        # inner asyncio.create_task to run
        await asyncio.sleep(0.1)

        # Verify execution_complete was sent with success=False
        exec_complete = [e for e in sent_events if e.get("type") == "execution_complete"]
        assert len(exec_complete) == 1
        assert exec_complete[0]["messageId"] == "msg-cancel-test"
        assert exec_complete[0]["success"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("sse_disconnect", [False, True], ids=["completed", "sse-loss"])
@pytest.mark.parametrize("stop_disconnected", [False, True], ids=["online-stop", "offline-stop"])
async def test_delayed_targeted_stop_preserves_terminal_and_contains_vendor(
    bridge: AgentBridge, sse_disconnect: bool, stop_disconnected: bool
) -> None:
    """Exercise the real client, translator, harness, owner and ACK forwarder."""

    class VendorHttpClient(MockHttpClient):
        def __init__(self):
            super().__init__()
            self.busy = False
            self.user_message_id = None
            self.idle_checks = 0

        async def post(self, url, json=None, timeout=30.0):
            if url.endswith("/prompt_async"):
                self.busy = True
                self.user_message_id = json["messageID"]
            elif url.endswith("/abort"):
                self.busy = False
            return await super().post(url, json=json, timeout=timeout)

        async def get(self, url, timeout=10.0):
            if url.endswith("/session/status"):
                self.idle_checks += 1
                return MockResponse(
                    200, {"oc-session-123": {"type": "busy" if self.busy else "idle"}}
                )
            assert url.endswith("/message")
            return MockResponse(
                200,
                [
                    {
                        "info": {
                            "id": "assistant-1",
                            "role": "assistant",
                            "parentID": self.user_message_id,
                        },
                        "parts": [{"type": "text", "id": "text-1", "text": "Preserved output"}],
                    }
                ],
            )

        def stream(self, method, url, timeout=None):
            vendor = self

            class Response(MockSSEResponse):
                async def aiter_text(self):
                    yield create_sse_event(
                        "message.updated",
                        {
                            "info": {
                                "id": "assistant-1",
                                "role": "assistant",
                                "parentID": vendor.user_message_id,
                                "sessionID": "oc-session-123",
                            }
                        },
                    )
                    yield create_sse_event(
                        "message.part.updated",
                        {
                            "part": {
                                "id": "step-1",
                                "messageID": "assistant-1",
                                "sessionID": "oc-session-123",
                                "type": "step-finish",
                                "cost": 1.25,
                            }
                        },
                    )
                    if sse_disconnect:
                        raise httpx.RemoteProtocolError("SSE connection lost while vendor busy")
                    vendor.busy = False
                    yield create_sse_event("session.idle", {"sessionID": "oc-session-123"})

            return Response([])

    class WebSocket:
        state = State.OPEN

        def __init__(self):
            self.sent = []

        async def send(self, data):
            event = json.loads(data)
            if event["type"] == "stop_confirmed":
                assert not http_client.busy
                assert http_client.idle_checks > 0
            self.sent.append(event)

    http_client = wire_opencode_transport(bridge, VendorHttpClient())
    bridge._configure_git_identity = AsyncMock()
    bridge._persist_rotated_session_id = AsyncMock()
    bridge.diff_refresh = MagicMock()
    first = WebSocket()
    await bridge.event_forwarder.bind(first)
    try:
        async with asyncio.timeout(1):
            await bridge._handle_command(
                {
                    "type": "prompt",
                    "messageId": "msg-1",
                    "content": "hello",
                    "author": {"gitIdentity": {"mode": "agent-only"}},
                }
            )
            await bridge.activity.current_prompt_task
            await asyncio.sleep(0)
            await bridge.activity._join_deliveries(asyncio.get_running_loop().time() + 1)

        assert bridge.activity.current_prompt_task is None
        assert http_client.busy is sse_disconnect
        assert not any(url.endswith("/abort") for url in http_client.post_urls)
        pending = bridge.event_forwarder._pending_acks
        selected = pending["execution_complete:msg-1"]
        original = dict(selected)
        assert selected["messageCostUsd"] == 1.25
        assert selected["success"] is not sse_disconnect
        if sse_disconnect:
            assert "stream disconnected" in selected["error"]
        assert any(event.get("content") == "Preserved output" for event in first.sent)

        if stop_disconnected:
            bridge.event_forwarder.unbind()
        command = {"type": "stop", "messageId": "msg-1", "commandId": "stop-1"}
        await bridge._handle_command(command)
        await bridge._handle_command(command)
        await bridge.activity._join_deliveries(asyncio.get_running_loop().time() + 1)

        assert sum(url.endswith("/abort") for url in http_client.post_urls) == 1
        assert http_client.idle_checks == 1
        assert not http_client.busy
        assert pending["execution_complete:msg-1"] is selected
        assert selected == original
        assert [event for event in first.sent if event["type"] == "execution_complete"] == [
            original
        ]

        bridge.event_forwarder.unbind()
        second = WebSocket()
        await bridge.event_forwarder.bind(second)
        assert [event for event in second.sent if event["type"] == "execution_complete"] == [
            original
        ]
        confirmations = [event for event in second.sent if event["type"] == "stop_confirmed"]
        assert len(confirmations) == 1
        confirmation = confirmations[0]
        assert confirmation["messageId"] == "msg-1"
        assert confirmation["commandId"] == "stop-1"
        assert confirmation["ackId"] == "stop_confirmed:stop-1"
        assert isinstance(confirmation["timestamp"], float)
        assert "success" not in confirmation
        assert pending[confirmation["ackId"]] == confirmation
        assert bridge.event_forwarder.acknowledge(confirmation["ackId"])
        assert pending["execution_complete:msg-1"] is selected
        assert bridge.event_forwarder.acknowledge(original["ackId"])
    finally:
        await bridge.activity.shutdown()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

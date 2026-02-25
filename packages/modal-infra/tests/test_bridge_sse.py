"""
Unit tests for SSE-based streaming in the bridge.

Tests the Server-Sent Events implementation that replaces the polling approach,
ensuring:
1. SSE events are properly parsed
2. Text parts with deltas accumulate correctly
3. Session completion is properly detected
4. Fallback to polling works when SSE fails
"""

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any
from unittest.mock import AsyncMock

import pytest

from src.sandbox.bridge import AgentBridge, OpenCodeIdentifier
from tests.conftest import MockResponse


class MockSSEResponse:
    """Mock SSE streaming response."""

    def __init__(self, events: list[str], status_code: int = 200):
        self.status_code = status_code
        self._events = events

    async def aiter_text(self) -> AsyncIterator[str]:
        """Yield SSE events as text chunks."""
        for event in self._events:
            yield event
            await asyncio.sleep(0)  # Allow other tasks to run

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


class MockHttpClient:
    """Mock HTTP client that supports both regular requests and SSE streaming."""

    def __init__(self):
        self.post_responses: list[Any] = []
        self.get_responses: list[Any] = []
        self.sse_events: list[str] = []
        self._post_call_count = 0
        self._get_call_count = 0

    async def post(self, url: str, json: dict | None = None, timeout: float = 30.0) -> Any:
        self._post_call_count += 1
        if self.post_responses:
            return self.post_responses.pop(0)
        return MockResponse(204)

    async def get(self, url: str, timeout: float = 10.0) -> Any:
        self._get_call_count += 1
        if self.get_responses:
            return self.get_responses.pop(0)
        return MockResponse(200, [])

    def stream(self, method: str, url: str, timeout: Any = None):
        """Return a context manager for SSE streaming."""
        return MockSSEResponse(self.sse_events)


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


@pytest.fixture
def opencode_message_id(monkeypatch) -> str:
    message_id = "msg_test"
    monkeypatch.setattr(
        OpenCodeIdentifier,
        "ascending",
        classmethod(lambda cls, prefix: message_id),
    )
    return message_id


class TestSSEParser:
    """Tests for _parse_sse_stream method."""

    @pytest.mark.asyncio
    async def test_parse_single_event(self, bridge: AgentBridge):
        """Should correctly parse a single SSE event."""
        events_text = [create_sse_event("server.connected", {})]
        response = MockSSEResponse(events_text)

        events = []
        async for event in bridge._parse_sse_stream(response):
            events.append(event)

        assert len(events) == 1
        assert events[0]["type"] == "server.connected"

    @pytest.mark.asyncio
    async def test_parse_multiple_events(self, bridge: AgentBridge):
        """Should correctly parse multiple SSE events."""
        events_text = [
            create_sse_event("server.connected", {}),
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "text",
                        "id": "part-1",
                        "sessionID": "oc-session-123",
                        "messageID": "oc-msg-1",
                        "text": "Hello",
                    }
                },
            ),
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]
        response = MockSSEResponse(events_text)

        events = []
        async for event in bridge._parse_sse_stream(response):
            events.append(event)

        assert len(events) == 3
        assert events[0]["type"] == "server.connected"
        assert events[1]["type"] == "message.part.updated"
        assert events[2]["type"] == "session.idle"

    @pytest.mark.asyncio
    async def test_parse_event_with_both_formats(self, bridge: AgentBridge):
        """Should handle both 'data: {...}' and 'data:{...}' formats."""
        events_text = [
            'data: {"type": "server.connected", "properties": {}}\n\n',
            'data:{"type": "session.idle", "properties": {"sessionID": "123"}}\n\n',
        ]
        response = MockSSEResponse(events_text)

        events = []
        async for event in bridge._parse_sse_stream(response):
            events.append(event)

        assert len(events) == 2
        assert events[0]["type"] == "server.connected"
        assert events[1]["type"] == "session.idle"


class TestSSEStreaming:
    """Tests for _stream_opencode_response_sse method."""

    @pytest.mark.asyncio
    async def test_text_streaming_with_delta(self, bridge: AgentBridge, opencode_message_id: str):
        """Should accumulate text deltas correctly."""
        http_client = bridge.http_client

        # SSE events with text deltas
        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-1",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": opencode_message_id,
                    }
                },
            ),
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "text",
                        "id": "part-1",
                        "sessionID": "oc-session-123",
                        "messageID": "oc-msg-1",
                        "text": "Hello",
                    },
                    "delta": "Hello",
                },
            ),
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "text",
                        "id": "part-1",
                        "sessionID": "oc-session-123",
                        "messageID": "oc-msg-1",
                        "text": "Hello world",
                    },
                    "delta": " world",
                },
            ),
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]

        events = []
        async for event in bridge._stream_opencode_response_sse("cp-msg-1", "Test prompt"):
            events.append(event)

        # Should have 2 token events with cumulative text
        token_events = [e for e in events if e["type"] == "token"]
        assert len(token_events) == 2
        assert token_events[0]["content"] == "Hello"
        assert token_events[1]["content"] == "Hello world"  # Cumulative

    @pytest.mark.asyncio
    async def test_text_streaming_without_delta(
        self, bridge: AgentBridge, opencode_message_id: str
    ):
        """Should handle full text updates without delta field."""
        http_client = bridge.http_client

        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-1",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": opencode_message_id,
                    }
                },
            ),
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "text",
                        "id": "part-1",
                        "sessionID": "oc-session-123",
                        "messageID": "oc-msg-1",
                        "text": "Full text content",
                    }
                },
            ),
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]

        events = []
        async for event in bridge._stream_opencode_response_sse("cp-msg-1", "Test prompt"):
            events.append(event)

        token_events = [e for e in events if e["type"] == "token"]
        assert len(token_events) == 1
        assert token_events[0]["content"] == "Full text content"

    @pytest.mark.asyncio
    async def test_buffers_parts_until_message_updated(
        self, bridge: AgentBridge, opencode_message_id: str
    ):
        """Should buffer parts until message.updated authorizes them."""
        http_client = bridge.http_client

        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "text",
                        "id": "part-1",
                        "sessionID": "oc-session-123",
                        "messageID": "oc-msg-1",
                        "text": "Hello",
                    }
                },
            ),
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-1",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": opencode_message_id,
                    }
                },
            ),
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]

        events = []
        async for event in bridge._stream_opencode_response_sse("cp-msg-1", "Test prompt"):
            events.append(event)

        token_events = [e for e in events if e["type"] == "token"]
        assert len(token_events) == 1
        assert token_events[0]["content"] == "Hello"

    @pytest.mark.asyncio
    async def test_tool_events(self, bridge: AgentBridge, opencode_message_id: str):
        """Should emit tool events correctly."""
        http_client = bridge.http_client

        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-1",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": opencode_message_id,
                    }
                },
            ),
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "tool",
                        "id": "part-1",
                        "sessionID": "oc-session-123",
                        "messageID": "oc-msg-1",
                        "tool": "Bash",
                        "callID": "call-1",
                        "state": {
                            "status": "running",
                            "input": {"command": "ls -la"},
                            "output": "",
                        },
                    }
                },
            ),
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "tool",
                        "id": "part-1",
                        "sessionID": "oc-session-123",
                        "messageID": "oc-msg-1",
                        "tool": "Bash",
                        "callID": "call-1",
                        "state": {
                            "status": "completed",
                            "input": {"command": "ls -la"},
                            "output": "file1.txt\nfile2.txt",
                        },
                    }
                },
            ),
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]

        events = []
        async for event in bridge._stream_opencode_response_sse("cp-msg-1", "Test prompt"):
            events.append(event)

        tool_events = [e for e in events if e["type"] == "tool_call"]
        assert len(tool_events) == 2
        assert tool_events[0]["status"] == "running"
        assert tool_events[1]["status"] == "completed"

    @pytest.mark.asyncio
    async def test_filters_other_sessions(self, bridge: AgentBridge, opencode_message_id: str):
        """Should filter out events from other sessions."""
        http_client = bridge.http_client

        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-1",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": opencode_message_id,
                    }
                },
            ),
            # Event from our session
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "text",
                        "id": "part-1",
                        "sessionID": "oc-session-123",
                        "messageID": "oc-msg-1",
                        "text": "Our response",
                    }
                },
            ),
            # Event from another session
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "text",
                        "id": "part-2",
                        "sessionID": "other-session-456",
                        "messageID": "msg-2",
                        "text": "Other response",
                    }
                },
            ),
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]

        events = []
        async for event in bridge._stream_opencode_response_sse("cp-msg-1", "Test prompt"):
            events.append(event)

        token_events = [e for e in events if e["type"] == "token"]
        assert len(token_events) == 1
        assert token_events[0]["content"] == "Our response"

    @pytest.mark.asyncio
    async def test_completion_on_session_status_idle(
        self, bridge: AgentBridge, opencode_message_id: str
    ):
        """Should complete on session.status with type=idle."""
        http_client = bridge.http_client

        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-1",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": opencode_message_id,
                    }
                },
            ),
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "text",
                        "id": "part-1",
                        "sessionID": "oc-session-123",
                        "messageID": "oc-msg-1",
                        "text": "Response",
                    }
                },
            ),
            create_sse_event(
                "session.status",
                {"sessionID": "oc-session-123", "status": {"type": "idle"}},
            ),
        ]

        events = []
        async for event in bridge._stream_opencode_response_sse("cp-msg-1", "Test prompt"):
            events.append(event)

        assert len(events) == 1
        assert events[0]["type"] == "token"

    @pytest.mark.asyncio
    async def test_handles_session_error(self, bridge: AgentBridge):
        """Should emit error event on session.error."""
        http_client = bridge.http_client

        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            create_sse_event(
                "session.error",
                {
                    "sessionID": "oc-session-123",
                    "error": {"message": "Something went wrong"},
                },
            ),
        ]

        events = []
        async for event in bridge._stream_opencode_response_sse("cp-msg-1", "Test prompt"):
            events.append(event)

        assert len(events) == 1
        assert events[0]["type"] == "error"
        assert events[0]["error"] == "Something went wrong"

    @pytest.mark.asyncio
    async def test_message_id_comes_from_control_plane(
        self, bridge: AgentBridge, opencode_message_id: str
    ):
        """All events should use control plane's messageId."""
        http_client = bridge.http_client

        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-1",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": opencode_message_id,
                    }
                },
            ),
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "text",
                        "id": "part-1",
                        "sessionID": "oc-session-123",
                        "messageID": "oc-msg-1",
                        "text": "Response",
                    }
                },
            ),
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]

        events = []
        async for event in bridge._stream_opencode_response_sse(
            "cp-message-from-control-plane", "Test prompt"
        ):
            events.append(event)

        # Event should have control plane's messageId
        assert events[0]["messageId"] == "cp-message-from-control-plane"
        assert events[0]["messageId"] != "oc-internal-msg-id"


class TestFetchFinalMessageState:
    """Tests for _fetch_final_message_state method.

    Uses parentID-based correlation: only processes assistant messages
    whose parentID matches the opencode_message_id (the OpenCode-compatible
    ascending ID we generated for the user message).

    The method takes two message IDs:
    - message_id: Control plane ID (used in events sent back)
    - opencode_message_id: OpenCode ascending ID (used for parentID correlation)
    """

    @pytest.fixture
    def bridge_with_mock_client(self) -> AgentBridge:
        """Create a bridge with AsyncMock HTTP client."""
        bridge = AgentBridge(
            sandbox_id="test-sandbox",
            session_id="test-session",
            control_plane_url="http://localhost:8787",
            auth_token="test-token",
        )
        bridge.opencode_session_id = "oc-session-123"
        bridge.http_client = AsyncMock()
        return bridge

    @pytest.mark.asyncio
    async def test_only_fetches_current_prompt_messages(self, bridge_with_mock_client: AgentBridge):
        """Should only emit text from messages whose parentID matches our opencode_message_id."""
        bridge = bridge_with_mock_client

        # API returns messages from two different prompts (different parentIDs)
        # parentIDs are OpenCode-format ascending IDs
        all_messages = [
            {
                "info": {"id": "oc-msg-1", "role": "assistant", "parentID": "msg_0001aaaaaa"},
                "parts": [{"id": "part-1", "type": "text", "text": "First response"}],
            },
            {
                "info": {"id": "oc-msg-2", "role": "assistant", "parentID": "msg_0002bbbbbb"},
                "parts": [{"id": "part-2", "type": "text", "text": "Second response"}],
            },
        ]

        bridge.http_client.get = AsyncMock(return_value=MockResponse(200, all_messages))

        cumulative_text: dict[str, str] = {}

        events = []
        # Pass both control plane ID and OpenCode ID
        async for event in bridge._fetch_final_message_state(
            "cp-msg-2", "msg_0002bbbbbb", cumulative_text
        ):
            events.append(event)

        # Should only have the second message's text (parentID matches msg_0002bbbbbb)
        assert len(events) == 1
        assert events[0]["content"] == "Second response"
        assert events[0]["messageId"] == "cp-msg-2"

    @pytest.mark.asyncio
    async def test_skips_messages_from_previous_prompts(self, bridge_with_mock_client: AgentBridge):
        """Should skip messages whose parentID doesn't match our opencode_message_id."""
        bridge = bridge_with_mock_client

        # API returns old message with different parentID
        all_messages = [
            {
                "info": {"id": "oc-msg-old", "role": "assistant", "parentID": "msg_0001oldold"},
                "parts": [{"id": "part-old", "type": "text", "text": "Old response"}],
            },
        ]

        bridge.http_client.get = AsyncMock(return_value=MockResponse(200, all_messages))

        cumulative_text: dict[str, str] = {}

        events = []
        # Pass both control plane ID and OpenCode ID (new ID doesn't match old parentID)
        async for event in bridge._fetch_final_message_state(
            "cp-msg-new", "msg_0002newnew", cumulative_text
        ):
            events.append(event)

        # Should have no events since parentID doesn't match
        assert len(events) == 0

    @pytest.mark.asyncio
    async def test_skips_text_already_sent(self, bridge_with_mock_client: AgentBridge):
        """Should skip text that's not longer than what was already sent."""
        bridge = bridge_with_mock_client

        all_messages = [
            {
                "info": {"id": "oc-msg-1", "role": "assistant", "parentID": "msg_0001aaaaaa"},
                "parts": [{"id": "part-1", "type": "text", "text": "Same length"}],
            },
        ]

        bridge.http_client.get = AsyncMock(return_value=MockResponse(200, all_messages))

        # Already sent this exact text
        cumulative_text = {"part-1": "Same length"}

        events = []
        async for event in bridge._fetch_final_message_state(
            "cp-msg-1", "msg_0001aaaaaa", cumulative_text
        ):
            events.append(event)

        # Should have no events since text is not longer
        assert len(events) == 0

    @pytest.mark.asyncio
    async def test_emits_longer_text(self, bridge_with_mock_client: AgentBridge):
        """Should emit text that's longer than what was already sent."""
        bridge = bridge_with_mock_client

        all_messages = [
            {
                "info": {"id": "oc-msg-1", "role": "assistant", "parentID": "msg_0001aaaaaa"},
                "parts": [{"id": "part-1", "type": "text", "text": "Hello world!"}],
            },
        ]

        bridge.http_client.get = AsyncMock(return_value=MockResponse(200, all_messages))

        # Previously sent shorter text
        cumulative_text = {"part-1": "Hello"}

        events = []
        async for event in bridge._fetch_final_message_state(
            "cp-msg-1", "msg_0001aaaaaa", cumulative_text
        ):
            events.append(event)

        # Should have one event with full text
        assert len(events) == 1
        assert events[0]["content"] == "Hello world!"

    @pytest.mark.asyncio
    async def test_skips_user_messages(self, bridge_with_mock_client: AgentBridge):
        """Should skip user messages (only process assistant messages)."""
        bridge = bridge_with_mock_client

        all_messages = [
            {
                "info": {"id": "oc-msg-user", "role": "user"},
                "parts": [{"id": "part-user", "type": "text", "text": "User message"}],
            },
            {
                "info": {
                    "id": "oc-msg-assistant",
                    "role": "assistant",
                    "parentID": "msg_0001aaaaaa",
                },
                "parts": [{"id": "part-assistant", "type": "text", "text": "Assistant response"}],
            },
        ]

        bridge.http_client.get = AsyncMock(return_value=MockResponse(200, all_messages))

        cumulative_text: dict[str, str] = {}

        events = []
        async for event in bridge._fetch_final_message_state(
            "cp-msg-1", "msg_0001aaaaaa", cumulative_text
        ):
            events.append(event)

        # Should only have assistant message
        assert len(events) == 1
        assert events[0]["content"] == "Assistant response"


class TestExtractErrorMessage:
    """Tests for _extract_error_message static method."""

    def test_named_error_with_data_message(self):
        """Should extract message from NamedError data.message."""
        error = {"name": "SomeError", "data": {"message": "Something broke"}}
        assert AgentBridge._extract_error_message(error) == "Something broke"

    def test_dict_with_message_key(self):
        """Should fall back to error.message when no data.message."""
        error = {"message": "Direct message"}
        assert AgentBridge._extract_error_message(error) == "Direct message"

    def test_dict_with_name_key_only(self):
        """Should fall back to error.name when no message key."""
        error = {"name": "TimeoutError"}
        assert AgentBridge._extract_error_message(error) == "TimeoutError"

    def test_non_dict_error(self):
        """Should stringify non-dict errors."""
        assert AgentBridge._extract_error_message("raw error string") == "raw error string"

    def test_none_error(self):
        """Should return None for falsy error."""
        assert AgentBridge._extract_error_message(None) is None

    def test_empty_dict(self):
        """Should return None for empty dict (no message or name)."""
        assert AgentBridge._extract_error_message({}) is None


class TestSSEFollowUpMessageBug:
    """Integration tests for the follow-up message bug fix.

    Tests the scenario where:
    1. First prompt gets response "The last commit was 073d4e7..."
    2. Second prompt asks "who was it by?"
    3. Bug: Second prompt would show first prompt's response

    The fix uses parentID-based correlation: we pass an OpenCode-compatible message ID,
    and filter based on assistant messages whose parentID matches that ID.
    """

    @pytest.mark.asyncio
    async def test_second_prompt_shows_correct_response(self, bridge: AgentBridge, monkeypatch):
        """Second prompt should show its own response, not the first prompt's."""
        http_client = bridge.http_client

        monkeypatch.setattr(
            OpenCodeIdentifier,
            "ascending",
            classmethod(lambda cls, prefix: "msg_test_1"),
        )

        # First prompt - SSE events (with message.updated for parentID correlation)
        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            # message.updated provides parentID for correlation
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-1",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": "msg_test_1",
                    }
                },
            ),
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "text",
                        "id": "part-1",
                        "sessionID": "oc-session-123",
                        "messageID": "oc-msg-1",
                        "text": "The last commit was 073d4e7...",
                    }
                },
            ),
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]

        # Final state fetch returns first message with parentID
        http_client.get_responses = [
            MockResponse(
                200,
                [
                    {
                        "info": {
                            "id": "oc-msg-1",
                            "role": "assistant",
                            "parentID": "msg_test_1",
                        },
                        "parts": [
                            {
                                "id": "part-1",
                                "type": "text",
                                "text": "The last commit was 073d4e7...",
                            }
                        ],
                    }
                ],
            )
        ]

        # Process first prompt
        events1 = []
        async for event in bridge._stream_opencode_response_sse(
            "cp-msg-1", "what was last commit?"
        ):
            events1.append(event)

        # Verify first prompt response
        token_events1 = [e for e in events1 if e["type"] == "token"]
        assert len(token_events1) >= 1
        assert "073d4e7" in token_events1[-1]["content"]

        # Now second prompt - SSE events (with message.updated for parentID correlation)
        monkeypatch.setattr(
            OpenCodeIdentifier,
            "ascending",
            classmethod(lambda cls, prefix: "msg_test_2"),
        )
        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            # message.updated provides parentID for correlation
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-2",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": "msg_test_2",
                    }
                },
            ),
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "text",
                        "id": "part-2",
                        "sessionID": "oc-session-123",
                        "messageID": "oc-msg-2",
                        "text": "The commit was by Test User",
                    }
                },
            ),
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]

        # Final state fetch returns BOTH messages (each with their own parentID)
        http_client.get_responses = [
            MockResponse(
                200,
                [
                    {
                        "info": {
                            "id": "oc-msg-1",
                            "role": "assistant",
                            "parentID": "msg_test_1",
                        },
                        "parts": [
                            {
                                "id": "part-1",
                                "type": "text",
                                "text": "The last commit was 073d4e7...",
                            }
                        ],
                    },
                    {
                        "info": {
                            "id": "oc-msg-2",
                            "role": "assistant",
                            "parentID": "msg_test_2",
                        },
                        "parts": [
                            {"id": "part-2", "type": "text", "text": "The commit was by Test User"}
                        ],
                    },
                ],
            )
        ]

        # Process second prompt
        events2 = []
        async for event in bridge._stream_opencode_response_sse("cp-msg-2", "who was it by?"):
            events2.append(event)

        # Verify second prompt response
        token_events2 = [e for e in events2 if e["type"] == "token"]
        assert len(token_events2) >= 1

        # The last token should contain the SECOND prompt's response
        last_token = token_events2[-1]
        assert "Test User" in last_token["content"]
        assert "073d4e7" not in last_token["content"]
        assert last_token["messageId"] == "cp-msg-2"


class DelayedMockSSEResponse:
    """Mock SSE response with configurable delays between chunks."""

    def __init__(self, events_with_delays: list[tuple[str, float]], status_code: int = 200):
        """Each item is (event_text, delay_before_yielding)."""
        self.status_code = status_code
        self._events_with_delays = events_with_delays

    async def aiter_text(self) -> AsyncIterator[str]:
        for event, delay in self._events_with_delays:
            if delay > 0:
                await asyncio.sleep(delay)
            yield event

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


class HangingMockSSEResponse:
    """Mock SSE response that hangs forever after initial events."""

    def __init__(self, initial_events: list[str], status_code: int = 200):
        self.status_code = status_code
        self._initial_events = initial_events

    async def aiter_text(self) -> AsyncIterator[str]:
        for event in self._initial_events:
            yield event
            await asyncio.sleep(0)
        # Hang forever (will be interrupted by timeout)
        await asyncio.sleep(3600)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


class DelayedMockHttpClient:
    """Mock HTTP client that uses delayed/hanging SSE responses."""

    def __init__(self, sse_response):
        self.post_responses: list[Any] = []
        self.get_responses: list[Any] = []
        self._sse_response = sse_response
        self.post_urls: list[str] = []
        self.get_urls: list[str] = []
        self._post_call_count = 0
        self._get_call_count = 0

    async def post(self, url: str, json: dict | None = None, timeout: float = 30.0) -> Any:
        self._post_call_count += 1
        self.post_urls.append(url)
        if self.post_responses:
            return self.post_responses.pop(0)
        return MockResponse(204)

    async def get(self, url: str, timeout: float = 10.0) -> Any:
        self._get_call_count += 1
        self.get_urls.append(url)
        if self.get_responses:
            return self.get_responses.pop(0)
        return MockResponse(200, [])

    def stream(self, method: str, url: str, timeout: Any = None):
        return self._sse_response


class TestInactivityTimeout:
    """Tests for SSE inactivity timeout behavior."""

    @pytest.mark.asyncio
    async def test_timeout_on_no_data(self):
        """Should raise RuntimeError when SSE stream hangs after connection."""
        bridge = AgentBridge(
            sandbox_id="test-sandbox",
            session_id="test-session",
            control_plane_url="http://localhost:8787",
            auth_token="test-token",
        )
        bridge.opencode_session_id = "oc-session-123"
        bridge.sse_inactivity_timeout = 0.2

        # SSE connects but then hangs after server.connected
        sse_response = HangingMockSSEResponse(
            initial_events=[create_sse_event("server.connected", {})]
        )
        bridge.http_client = DelayedMockHttpClient(sse_response)

        with pytest.raises(RuntimeError, match="SSE stream inactive"):
            async for _event in bridge._stream_opencode_response_sse("msg-1", "test"):
                pass

    @pytest.mark.asyncio
    async def test_timeout_resets_on_data(self, opencode_message_id: str):
        """Events spaced under the timeout window should complete successfully."""
        bridge = AgentBridge(
            sandbox_id="test-sandbox",
            session_id="test-session",
            control_plane_url="http://localhost:8787",
            auth_token="test-token",
        )
        bridge.opencode_session_id = "oc-session-123"
        bridge.sse_inactivity_timeout = 0.5

        # Events arrive every 0.1s — well under the 0.5s inactivity limit
        # Total wall-clock time (~0.3s) would NOT matter; only gaps between chunks
        sse_response = DelayedMockSSEResponse(
            [
                (create_sse_event("server.connected", {}), 0),
                (
                    create_sse_event(
                        "message.updated",
                        {
                            "info": {
                                "id": "oc-msg-1",
                                "role": "assistant",
                                "sessionID": "oc-session-123",
                                "parentID": opencode_message_id,
                            }
                        },
                    ),
                    0,
                ),
                (
                    create_sse_event(
                        "message.part.updated",
                        {
                            "part": {
                                "type": "text",
                                "id": "part-1",
                                "sessionID": "oc-session-123",
                                "messageID": "oc-msg-1",
                                "text": "Hello",
                            }
                        },
                    ),
                    0.1,
                ),
                (
                    create_sse_event(
                        "message.part.updated",
                        {
                            "part": {
                                "type": "text",
                                "id": "part-1",
                                "sessionID": "oc-session-123",
                                "messageID": "oc-msg-1",
                                "text": "Hello world",
                            }
                        },
                    ),
                    0.1,
                ),
                (create_sse_event("session.idle", {"sessionID": "oc-session-123"}), 0.1),
            ]
        )
        bridge.http_client = DelayedMockHttpClient(sse_response)

        events = []
        async for event in bridge._stream_opencode_response_sse("msg-1", "test"):
            events.append(event)

        token_events = [e for e in events if e["type"] == "token"]
        assert len(token_events) == 2
        assert token_events[-1]["content"] == "Hello world"

    @pytest.mark.asyncio
    async def test_heartbeat_resets_timeout(self, opencode_message_id: str):
        """server.heartbeat events should keep the session alive."""
        bridge = AgentBridge(
            sandbox_id="test-sandbox",
            session_id="test-session",
            control_plane_url="http://localhost:8787",
            auth_token="test-token",
        )
        bridge.opencode_session_id = "oc-session-123"
        bridge.sse_inactivity_timeout = 0.3

        # Heartbeats arrive every 0.2s — under the 0.3s inactivity limit
        # Without heartbeats, the 0.2s gaps would eventually accumulate beyond
        # a wall-clock limit, but since each chunk resets the deadline, this works
        sse_response = DelayedMockSSEResponse(
            [
                (create_sse_event("server.connected", {}), 0),
                (create_sse_event("server.heartbeat", {}), 0.2),
                (create_sse_event("server.heartbeat", {}), 0.2),
                (
                    create_sse_event(
                        "message.updated",
                        {
                            "info": {
                                "id": "oc-msg-1",
                                "role": "assistant",
                                "sessionID": "oc-session-123",
                                "parentID": opencode_message_id,
                            }
                        },
                    ),
                    0,
                ),
                (
                    create_sse_event(
                        "message.part.updated",
                        {
                            "part": {
                                "type": "text",
                                "id": "part-1",
                                "sessionID": "oc-session-123",
                                "messageID": "oc-msg-1",
                                "text": "Finally!",
                            }
                        },
                    ),
                    0.2,
                ),
                (create_sse_event("session.idle", {"sessionID": "oc-session-123"}), 0),
            ]
        )
        bridge.http_client = DelayedMockHttpClient(sse_response)

        events = []
        async for event in bridge._stream_opencode_response_sse("msg-1", "test"):
            events.append(event)

        token_events = [e for e in events if e["type"] == "token"]
        assert len(token_events) == 1
        assert token_events[0]["content"] == "Finally!"


class TestPromptMaxDuration:
    """Tests for prompt max duration timeout behavior."""

    @pytest.mark.asyncio
    async def test_prompt_max_duration_timeout(self):
        """Prompt should stop when it exceeds max duration."""
        bridge = AgentBridge(
            sandbox_id="test-sandbox",
            session_id="test-session",
            control_plane_url="http://localhost:8787",
            auth_token="test-token",
        )
        bridge.opencode_session_id = "oc-session-123"
        bridge.sse_inactivity_timeout = 2.0
        bridge.PROMPT_MAX_DURATION = 0.25

        sse_response = DelayedMockSSEResponse(
            [
                (create_sse_event("server.connected", {}), 0),
                (create_sse_event("server.heartbeat", {}), 0.2),
                (create_sse_event("server.heartbeat", {}), 0.2),
            ]
        )
        http_client = DelayedMockHttpClient(sse_response)
        http_client.get_responses = [MockResponse(200, [])]
        bridge.http_client = http_client

        with pytest.raises(RuntimeError, match="Prompt exceeded max duration"):
            async for _event in bridge._stream_opencode_response_sse("msg-1", "test"):
                pass

        assert any(url.endswith("/abort") for url in http_client.post_urls)
        assert any(url.endswith("/message") for url in http_client.get_urls)


class TestSubtaskStreaming:
    """Tests for child session (sub-task) event streaming through the bridge."""

    @pytest.mark.asyncio
    async def test_child_session_tool_events_streamed(
        self, bridge: AgentBridge, opencode_message_id: str
    ):
        """Child session tool events should be forwarded with isSubtask=True."""
        http_client = bridge.http_client

        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            # Parent message.updated to authorize parent messages
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-1",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": opencode_message_id,
                    }
                },
            ),
            # Child session created
            create_sse_event(
                "session.created",
                {
                    "info": {
                        "id": "child-1",
                        "parentID": "oc-session-123",
                    }
                },
            ),
            # Child message.updated
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "child-msg-1",
                        "role": "assistant",
                        "sessionID": "child-1",
                    }
                },
            ),
            # Child tool running
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "tool",
                        "id": "child-part-1",
                        "sessionID": "child-1",
                        "messageID": "child-msg-1",
                        "tool": "Bash",
                        "callID": "child-call-1",
                        "state": {
                            "status": "running",
                            "input": {"command": "ls"},
                            "output": "",
                        },
                    }
                },
            ),
            # Child tool completed
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "tool",
                        "id": "child-part-1",
                        "sessionID": "child-1",
                        "messageID": "child-msg-1",
                        "tool": "Bash",
                        "callID": "child-call-1",
                        "state": {
                            "status": "completed",
                            "input": {"command": "ls"},
                            "output": "file.txt",
                        },
                    }
                },
            ),
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]

        events = []
        async for event in bridge._stream_opencode_response_sse("cp-msg-1", "Test prompt"):
            events.append(event)

        tool_events = [e for e in events if e["type"] == "tool_call"]
        assert len(tool_events) == 2
        assert tool_events[0]["status"] == "running"
        assert tool_events[0]["isSubtask"] is True
        assert tool_events[0]["messageId"] == "cp-msg-1"
        assert tool_events[1]["status"] == "completed"
        assert tool_events[1]["isSubtask"] is True

    @pytest.mark.asyncio
    async def test_child_text_events_not_forwarded(
        self, bridge: AgentBridge, opencode_message_id: str
    ):
        """Child session text events should NOT be forwarded."""
        http_client = bridge.http_client

        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-1",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": opencode_message_id,
                    }
                },
            ),
            create_sse_event(
                "session.created",
                {
                    "info": {
                        "id": "child-1",
                        "parentID": "oc-session-123",
                    }
                },
            ),
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "child-msg-1",
                        "role": "assistant",
                        "sessionID": "child-1",
                    }
                },
            ),
            # Child text event — should be suppressed
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "text",
                        "id": "child-text-1",
                        "sessionID": "child-1",
                        "messageID": "child-msg-1",
                        "text": "I am thinking...",
                    },
                    "delta": "I am thinking...",
                },
            ),
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]

        events = []
        async for event in bridge._stream_opencode_response_sse("cp-msg-1", "Test prompt"):
            events.append(event)

        token_events = [e for e in events if e["type"] == "token"]
        assert len(token_events) == 0

    @pytest.mark.asyncio
    async def test_child_idle_does_not_terminate_stream(
        self, bridge: AgentBridge, opencode_message_id: str
    ):
        """Child session.idle should NOT terminate the parent stream."""
        http_client = bridge.http_client

        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-1",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": opencode_message_id,
                    }
                },
            ),
            create_sse_event(
                "session.created",
                {
                    "info": {
                        "id": "child-1",
                        "parentID": "oc-session-123",
                    }
                },
            ),
            # Child goes idle — should NOT terminate
            create_sse_event("session.idle", {"sessionID": "child-1"}),
            # Parent text event after child idle
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "text",
                        "id": "part-1",
                        "sessionID": "oc-session-123",
                        "messageID": "oc-msg-1",
                        "text": "Task result",
                    }
                },
            ),
            # Parent goes idle — terminates
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]

        events = []
        async for event in bridge._stream_opencode_response_sse("cp-msg-1", "Test prompt"):
            events.append(event)

        token_events = [e for e in events if e["type"] == "token"]
        assert len(token_events) == 1
        assert token_events[0]["content"] == "Task result"

    @pytest.mark.asyncio
    async def test_child_session_status_idle_does_not_terminate_stream(
        self, bridge: AgentBridge, opencode_message_id: str
    ):
        """Child session.status with type=idle should NOT terminate the parent stream."""
        http_client = bridge.http_client

        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-1",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": opencode_message_id,
                    }
                },
            ),
            create_sse_event(
                "session.created",
                {
                    "info": {
                        "id": "child-1",
                        "parentID": "oc-session-123",
                    }
                },
            ),
            # Child session.status idle — should NOT terminate
            create_sse_event(
                "session.status",
                {"sessionID": "child-1", "status": {"type": "idle"}},
            ),
            # Parent text event after child status idle
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "text",
                        "id": "part-1",
                        "sessionID": "oc-session-123",
                        "messageID": "oc-msg-1",
                        "text": "Still going",
                    }
                },
            ),
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]

        events = []
        async for event in bridge._stream_opencode_response_sse("cp-msg-1", "Test prompt"):
            events.append(event)

        token_events = [e for e in events if e["type"] == "token"]
        assert len(token_events) == 1
        assert token_events[0]["content"] == "Still going"

    @pytest.mark.asyncio
    async def test_child_session_error_forwarded_without_termination(
        self, bridge: AgentBridge, opencode_message_id: str
    ):
        """Child session errors should be forwarded with isSubtask=True but not terminate stream."""
        http_client = bridge.http_client

        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-1",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": opencode_message_id,
                    }
                },
            ),
            create_sse_event(
                "session.created",
                {
                    "info": {
                        "id": "child-1",
                        "parentID": "oc-session-123",
                    }
                },
            ),
            # Child session error
            create_sse_event(
                "session.error",
                {
                    "sessionID": "child-1",
                    "error": {"data": {"message": "Sub-task failed"}},
                },
            ),
            # Parent text after child error — should still be received
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "text",
                        "id": "part-1",
                        "sessionID": "oc-session-123",
                        "messageID": "oc-msg-1",
                        "text": "Recovered from sub-task error",
                    }
                },
            ),
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]

        events = []
        async for event in bridge._stream_opencode_response_sse("cp-msg-1", "Test prompt"):
            events.append(event)

        error_events = [e for e in events if e["type"] == "error"]
        assert len(error_events) == 1
        assert error_events[0]["error"] == "Sub-task failed"
        assert error_events[0]["isSubtask"] is True

        token_events = [e for e in events if e["type"] == "token"]
        assert len(token_events) == 1
        assert token_events[0]["content"] == "Recovered from sub-task error"

    @pytest.mark.asyncio
    async def test_child_message_buffering_race_condition(
        self, bridge: AgentBridge, opencode_message_id: str
    ):
        """Child parts arriving before message.updated should be buffered and flushed."""
        http_client = bridge.http_client

        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-1",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": opencode_message_id,
                    }
                },
            ),
            create_sse_event(
                "session.created",
                {
                    "info": {
                        "id": "child-1",
                        "parentID": "oc-session-123",
                    }
                },
            ),
            # Child tool event BEFORE message.updated — should be buffered
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "tool",
                        "id": "child-part-1",
                        "sessionID": "child-1",
                        "messageID": "child-msg-1",
                        "tool": "Read",
                        "callID": "child-call-1",
                        "state": {
                            "status": "running",
                            "input": {"path": "/file.txt"},
                            "output": "",
                        },
                    }
                },
            ),
            # Now child message.updated arrives — should flush buffered part
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "child-msg-1",
                        "role": "assistant",
                        "sessionID": "child-1",
                    }
                },
            ),
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]

        events = []
        async for event in bridge._stream_opencode_response_sse("cp-msg-1", "Test prompt"):
            events.append(event)

        tool_events = [e for e in events if e["type"] == "tool_call"]
        assert len(tool_events) == 1
        assert tool_events[0]["isSubtask"] is True
        assert tool_events[0]["tool"] == "Read"

    @pytest.mark.asyncio
    async def test_resumed_child_session_discovered_via_metadata(
        self, bridge: AgentBridge, opencode_message_id: str
    ):
        """Child sessions resumed via task_id should be discovered from task tool metadata."""
        http_client = bridge.http_client

        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-1",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": opencode_message_id,
                    }
                },
            ),
            # NO session.created — child was resumed via task_id
            # Parent task tool part with metadata.sessionId
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "tool",
                        "id": "parent-part-1",
                        "sessionID": "oc-session-123",
                        "messageID": "oc-msg-1",
                        "tool": "task",
                        "callID": "task-call-1",
                        "metadata": {"sessionId": "child-1"},
                        "state": {
                            "status": "running",
                            "input": {"prompt": "do something"},
                            "output": "",
                        },
                    }
                },
            ),
            # Now child events arrive
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "child-msg-1",
                        "role": "assistant",
                        "sessionID": "child-1",
                    }
                },
            ),
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "tool",
                        "id": "child-part-1",
                        "sessionID": "child-1",
                        "messageID": "child-msg-1",
                        "tool": "Bash",
                        "callID": "child-call-1",
                        "state": {
                            "status": "running",
                            "input": {"command": "echo hello"},
                            "output": "",
                        },
                    }
                },
            ),
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]

        events = []
        async for event in bridge._stream_opencode_response_sse("cp-msg-1", "Test prompt"):
            events.append(event)

        tool_events = [e for e in events if e["type"] == "tool_call"]
        # Should have: parent task tool (running) + child Bash tool (running)
        parent_tools = [e for e in tool_events if not e.get("isSubtask")]
        child_tools = [e for e in tool_events if e.get("isSubtask")]
        assert len(parent_tools) == 1
        assert parent_tools[0]["tool"] == "task"
        assert len(child_tools) == 1
        assert child_tools[0]["tool"] == "Bash"
        assert child_tools[0]["isSubtask"] is True

    @pytest.mark.asyncio
    async def test_parent_child_callid_collision(
        self, bridge: AgentBridge, opencode_message_id: str
    ):
        """Parent and child using same callID should both emit events (session-scoped dedupe)."""
        http_client = bridge.http_client

        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-1",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": opencode_message_id,
                    }
                },
            ),
            create_sse_event(
                "session.created",
                {
                    "info": {
                        "id": "child-1",
                        "parentID": "oc-session-123",
                    }
                },
            ),
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "child-msg-1",
                        "role": "assistant",
                        "sessionID": "child-1",
                    }
                },
            ),
            # Parent tool with callID "abc"
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "tool",
                        "id": "parent-part-1",
                        "sessionID": "oc-session-123",
                        "messageID": "oc-msg-1",
                        "tool": "Bash",
                        "callID": "abc",
                        "state": {
                            "status": "running",
                            "input": {"command": "echo parent"},
                            "output": "",
                        },
                    }
                },
            ),
            # Child tool with same callID "abc"
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "tool",
                        "id": "child-part-1",
                        "sessionID": "child-1",
                        "messageID": "child-msg-1",
                        "tool": "Bash",
                        "callID": "abc",
                        "state": {
                            "status": "running",
                            "input": {"command": "echo child"},
                            "output": "",
                        },
                    }
                },
            ),
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]

        events = []
        async for event in bridge._stream_opencode_response_sse("cp-msg-1", "Test prompt"):
            events.append(event)

        tool_events = [e for e in events if e["type"] == "tool_call"]
        # Both should be emitted despite same callID (session-scoped dedupe)
        assert len(tool_events) == 2
        parent_tools = [e for e in tool_events if not e.get("isSubtask")]
        child_tools = [e for e in tool_events if e.get("isSubtask")]
        assert len(parent_tools) == 1
        assert len(child_tools) == 1

    @pytest.mark.asyncio
    async def test_grandchild_session_not_tracked(
        self, bridge: AgentBridge, opencode_message_id: str
    ):
        """Grandchild sessions (parentID != opencode_session_id) should NOT be tracked."""
        http_client = bridge.http_client

        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-1",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": opencode_message_id,
                    }
                },
            ),
            # Direct child
            create_sse_event(
                "session.created",
                {
                    "info": {
                        "id": "child-1",
                        "parentID": "oc-session-123",
                    }
                },
            ),
            # Grandchild — parentID is child-1, NOT oc-session-123
            create_sse_event(
                "session.created",
                {
                    "info": {
                        "id": "grandchild-1",
                        "parentID": "child-1",
                    }
                },
            ),
            # Grandchild message + tool — should be filtered out
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "gc-msg-1",
                        "role": "assistant",
                        "sessionID": "grandchild-1",
                    }
                },
            ),
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "tool",
                        "id": "gc-part-1",
                        "sessionID": "grandchild-1",
                        "messageID": "gc-msg-1",
                        "tool": "Bash",
                        "callID": "gc-call-1",
                        "state": {
                            "status": "running",
                            "input": {"command": "echo grandchild"},
                            "output": "",
                        },
                    }
                },
            ),
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]

        events = []
        async for event in bridge._stream_opencode_response_sse("cp-msg-1", "Test prompt"):
            events.append(event)

        tool_events = [e for e in events if e["type"] == "tool_call"]
        assert len(tool_events) == 0  # Grandchild events should be filtered out


class TestCompactionHandling:
    """Tests for session compaction handling in the bridge.

    When OpenCode compacts a session, the message chain changes:
    1. A compaction summary message is created (summary=True, mode=compaction)
    2. A synthetic "Continue..." user message is injected
    3. The next assistant response has parentID pointing to the synthetic message,
       NOT to our original opencode_message_id

    The bridge must detect session.compacted and accept post-compaction messages.
    """

    @pytest.mark.asyncio
    async def test_post_compaction_text_forwarded(
        self, bridge: AgentBridge, opencode_message_id: str
    ):
        """After compaction, text from the new assistant message should be forwarded."""
        http_client = bridge.http_client

        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            # Pre-compaction: normal assistant with matching parentID
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-1",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": opencode_message_id,
                    }
                },
            ),
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "text",
                        "id": "part-1",
                        "sessionID": "oc-session-123",
                        "messageID": "oc-msg-1",
                        "text": "Let me check...",
                    },
                    "delta": "Let me check...",
                },
            ),
            # Compaction happens
            create_sse_event(
                "session.compacted",
                {"sessionID": "oc-session-123"},
            ),
            # Compaction summary message (should be skipped)
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-summary",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": "msg_compaction_user",
                        "summary": True,
                    }
                },
            ),
            # Post-compaction assistant with different parentID
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-2",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": "msg_synthetic_continue",
                    }
                },
            ),
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "text",
                        "id": "part-2",
                        "sessionID": "oc-session-123",
                        "messageID": "oc-msg-2",
                        "text": "Here is the answer.",
                    },
                    "delta": "Here is the answer.",
                },
            ),
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]

        events = []
        async for event in bridge._stream_opencode_response_sse("cp-msg-1", "Test prompt"):
            events.append(event)

        token_events = [e for e in events if e["type"] == "token"]
        assert len(token_events) == 2
        assert token_events[0]["content"] == "Let me check..."
        assert token_events[1]["content"] == "Here is the answer."

    @pytest.mark.asyncio
    async def test_compaction_summary_text_not_forwarded(
        self, bridge: AgentBridge, opencode_message_id: str
    ):
        """The compaction summary message text should NOT be forwarded to the user."""
        http_client = bridge.http_client

        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-1",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": opencode_message_id,
                    }
                },
            ),
            # Compaction
            create_sse_event(
                "session.compacted",
                {"sessionID": "oc-session-123"},
            ),
            # Compaction summary with summary=True
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-summary",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": "msg_compaction_user",
                        "summary": True,
                    }
                },
            ),
            # Summary text — should be skipped
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "text",
                        "id": "summary-part",
                        "sessionID": "oc-session-123",
                        "messageID": "oc-msg-summary",
                        "text": "## Goal\nThe user was working on...",
                    },
                    "delta": "## Goal\nThe user was working on...",
                },
            ),
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]

        events = []
        async for event in bridge._stream_opencode_response_sse("cp-msg-1", "Test prompt"):
            events.append(event)

        # Summary text should not appear
        token_events = [e for e in events if e["type"] == "token"]
        assert len(token_events) == 0

    @pytest.mark.asyncio
    async def test_without_compaction_strict_parent_matching(
        self, bridge: AgentBridge, opencode_message_id: str
    ):
        """Without compaction, messages with wrong parentID should still be rejected."""
        http_client = bridge.http_client

        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            # Message with non-matching parentID (no compaction event)
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-wrong",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": "msg_some_other_id",
                    }
                },
            ),
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "text",
                        "id": "part-wrong",
                        "sessionID": "oc-session-123",
                        "messageID": "oc-msg-wrong",
                        "text": "Should not appear",
                    },
                    "delta": "Should not appear",
                },
            ),
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]

        events = []
        async for event in bridge._stream_opencode_response_sse("cp-msg-1", "Test prompt"):
            events.append(event)

        token_events = [e for e in events if e["type"] == "token"]
        assert len(token_events) == 0

    @pytest.mark.asyncio
    async def test_compaction_parts_buffered_before_message_updated(
        self, bridge: AgentBridge, opencode_message_id: str
    ):
        """Parts arriving before message.updated after compaction should be buffered and flushed."""
        http_client = bridge.http_client

        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-1",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": opencode_message_id,
                    }
                },
            ),
            # Compaction
            create_sse_event(
                "session.compacted",
                {"sessionID": "oc-session-123"},
            ),
            # Part arrives BEFORE message.updated for post-compaction msg
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "text",
                        "id": "part-post",
                        "sessionID": "oc-session-123",
                        "messageID": "oc-msg-post",
                        "text": "Buffered text",
                    },
                    "delta": "Buffered text",
                },
            ),
            # Now message.updated arrives (non-summary, non-matching parentID)
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-post",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": "msg_synthetic_continue",
                    }
                },
            ),
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]

        events = []
        async for event in bridge._stream_opencode_response_sse("cp-msg-1", "Test prompt"):
            events.append(event)

        token_events = [e for e in events if e["type"] == "token"]
        assert len(token_events) == 1
        assert token_events[0]["content"] == "Buffered text"

    @pytest.mark.asyncio
    async def test_fetch_final_state_after_compaction(self):
        """_fetch_final_message_state with compaction_occurred should find post-compaction text."""
        bridge = AgentBridge(
            sandbox_id="test-sandbox",
            session_id="test-session",
            control_plane_url="http://localhost:8787",
            auth_token="test-token",
        )
        bridge.opencode_session_id = "oc-session-123"
        bridge.http_client = AsyncMock()

        # API returns: compaction summary + post-compaction response
        messages = [
            {
                "info": {
                    "id": "oc-msg-summary",
                    "role": "assistant",
                    "parentID": "msg_compaction_user",
                    "summary": True,
                },
                "parts": [
                    {"id": "summary-part", "type": "text", "text": "## Goal\nSummary..."},
                ],
            },
            {
                "info": {
                    "id": "oc-msg-post",
                    "role": "assistant",
                    "parentID": "msg_synthetic_continue",
                },
                "parts": [
                    {"id": "post-part", "type": "text", "text": "Here is the answer."},
                ],
            },
        ]

        bridge.http_client.get = AsyncMock(return_value=MockResponse(200, messages))

        events = []
        async for event in bridge._fetch_final_message_state(
            "cp-msg-1",
            "msg_original_id",
            {},
            set(),
            compaction_occurred=True,
        ):
            events.append(event)

        # Should find the post-compaction response but NOT the summary
        assert len(events) == 1
        assert events[0]["content"] == "Here is the answer."
        assert events[0]["messageId"] == "cp-msg-1"

    @pytest.mark.asyncio
    async def test_fetch_final_state_without_compaction_rejects_unknown(self):
        """_fetch_final_message_state without compaction should reject non-matching messages."""
        bridge = AgentBridge(
            sandbox_id="test-sandbox",
            session_id="test-session",
            control_plane_url="http://localhost:8787",
            auth_token="test-token",
        )
        bridge.opencode_session_id = "oc-session-123"
        bridge.http_client = AsyncMock()

        messages = [
            {
                "info": {
                    "id": "oc-msg-post",
                    "role": "assistant",
                    "parentID": "msg_some_other_id",
                },
                "parts": [
                    {"id": "part-1", "type": "text", "text": "Should not appear"},
                ],
            },
        ]

        bridge.http_client.get = AsyncMock(return_value=MockResponse(200, messages))

        events = []
        async for event in bridge._fetch_final_message_state(
            "cp-msg-1",
            "msg_original_id",
            {},
            set(),
            compaction_occurred=False,
        ):
            events.append(event)

        assert len(events) == 0

    @pytest.mark.asyncio
    async def test_child_compaction_does_not_affect_parent(
        self, bridge: AgentBridge, opencode_message_id: str
    ):
        """Compaction in a child session should NOT trigger compaction handling for parent."""
        http_client = bridge.http_client

        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-1",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": opencode_message_id,
                    }
                },
            ),
            create_sse_event(
                "session.created",
                {
                    "info": {
                        "id": "child-1",
                        "parentID": "oc-session-123",
                    }
                },
            ),
            # Compaction in CHILD session — should not affect parent tracking
            create_sse_event(
                "session.compacted",
                {"sessionID": "child-1"},
            ),
            # Message with wrong parentID in parent — should still be rejected
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "oc-msg-wrong",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": "msg_some_other_id",
                    }
                },
            ),
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "text",
                        "id": "part-wrong",
                        "sessionID": "oc-session-123",
                        "messageID": "oc-msg-wrong",
                        "text": "Should not appear",
                    },
                    "delta": "Should not appear",
                },
            ),
            create_sse_event("session.idle", {"sessionID": "oc-session-123"}),
        ]

        events = []
        async for event in bridge._stream_opencode_response_sse("cp-msg-1", "Test prompt"):
            events.append(event)

        token_events = [e for e in events if e["type"] == "token"]
        assert len(token_events) == 0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

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
from unittest.mock import AsyncMock, patch

import pytest

from src.sandbox.bridge import AgentBridge, OpenCodeIdentifier, _extract_error_message
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
        return MockResponse(200, {})

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
                        "messageID": "msg-1",
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
    async def test_text_streaming_with_delta(self, bridge: AgentBridge):
        """Should accumulate text deltas correctly."""
        http_client = bridge.http_client

        # SSE events with text deltas
        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "text",
                        "id": "part-1",
                        "sessionID": "oc-session-123",
                        "messageID": "msg-1",
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
                        "messageID": "msg-1",
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
    async def test_text_streaming_without_delta(self, bridge: AgentBridge):
        """Should handle full text updates without delta field."""
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
                        "messageID": "msg-1",
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
    async def test_tool_events(self, bridge: AgentBridge):
        """Should emit tool events correctly."""
        http_client = bridge.http_client

        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "tool",
                        "id": "part-1",
                        "sessionID": "oc-session-123",
                        "messageID": "msg-1",
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
                        "messageID": "msg-1",
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
    async def test_filters_other_sessions(self, bridge: AgentBridge):
        """Should filter out events from other sessions."""
        http_client = bridge.http_client

        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            # Event from our session
            create_sse_event(
                "message.part.updated",
                {
                    "part": {
                        "type": "text",
                        "id": "part-1",
                        "sessionID": "oc-session-123",
                        "messageID": "msg-1",
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
    async def test_completion_on_session_status_idle(self, bridge: AgentBridge):
        """Should complete on session.status with type=idle."""
        http_client = bridge.http_client

        known_msg_id = "msg_test_completion_idle"

        http_client.sse_events = [
            create_sse_event("server.connected", {}),
            create_sse_event(
                "message.updated",
                {
                    "info": {
                        "id": "msg-1",
                        "role": "assistant",
                        "sessionID": "oc-session-123",
                        "parentID": known_msg_id,
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
                        "messageID": "msg-1",
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
        with patch.object(OpenCodeIdentifier, "ascending", return_value=known_msg_id):
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
    async def test_message_id_comes_from_control_plane(self, bridge: AgentBridge):
        """All events should use control plane's messageId."""
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
                        "messageID": "oc-internal-msg-id",  # OpenCode's internal ID
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


class TestSSEFollowUpMessageBug:
    """Integration tests for the follow-up message bug fix.

    Tests the scenario where:
    1. First prompt gets response "The last commit was 073d4e7..."
    2. Second prompt asks "who was it by?"
    3. Bug: Second prompt would show first prompt's response

    The fix uses parentID-based correlation: we pass our message_id to OpenCode,
    and filter based on assistant messages whose parentID matches our message_id.
    """

    @pytest.mark.asyncio
    async def test_second_prompt_shows_correct_response(self, bridge: AgentBridge):
        """Second prompt should show its own response, not the first prompt's."""
        http_client = bridge.http_client

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
                        "parentID": "cp-msg-1",  # Points to our user message
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
                            "parentID": "cp-msg-1",
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
                        "parentID": "cp-msg-2",  # Points to our user message
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
                            "parentID": "cp-msg-1",  # First prompt's message
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
                            "parentID": "cp-msg-2",  # Second prompt's message
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


class TestExtractErrorMessage:
    """Tests for _extract_error_message helper."""

    def test_none_error(self):
        assert _extract_error_message(None) == "Unknown error"

    def test_empty_string(self):
        assert _extract_error_message("") == "Unknown error"

    def test_string_error(self):
        assert _extract_error_message("Something went wrong") == "Something went wrong"

    def test_dict_with_message(self):
        assert _extract_error_message({"message": "Bad request"}) == "Bad request"

    def test_dict_with_description(self):
        assert _extract_error_message({"description": "Rate limited"}) == "Rate limited"

    def test_nested_error_object(self):
        """Anthropic API error format: {"error": {"type": "...", "message": "..."}}"""
        error = {
            "type": "error",
            "error": {"type": "authentication_error", "message": "invalid x-api-key"},
        }
        result = _extract_error_message(error)
        assert "authentication_error" in result
        assert "invalid x-api-key" in result

    def test_dict_with_no_known_keys(self):
        error = {"code": 500, "status": "fail"}
        result = _extract_error_message(error)
        assert "500" in result  # Falls back to JSON serialization

    def test_empty_dict(self):
        assert _extract_error_message({}) == "Unknown error"

    def test_json_encoded_api_error(self):
        """OpenCode sends APIError as a JSON string."""
        error = json.dumps({
            "name": "APIError",
            "data": {
                "message": "invalid x-api-key",
                "statusCode": 401,
                "isRetryable": False,
            },
        })
        result = _extract_error_message(error)
        assert "invalid x-api-key" in result
        assert "401" in result
        assert "APIError" in result

    def test_json_encoded_simple_message(self):
        """JSON string with just a message field."""
        error = json.dumps({"message": "rate limit exceeded"})
        result = _extract_error_message(error)
        assert result == "rate limit exceeded"

    def test_dict_data_message_format(self):
        """Direct dict in OpenCode APIError format."""
        error = {
            "name": "APIError",
            "data": {"message": "overloaded", "statusCode": 529},
        }
        result = _extract_error_message(error)
        assert "overloaded" in result
        assert "529" in result


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

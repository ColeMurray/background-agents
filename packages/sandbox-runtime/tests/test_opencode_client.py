"""
Unit tests for OpenCodeClient transport seams exposed by the extraction.

SSE frame parsing and end-to-end streaming stay covered by test_bridge_sse.py;
these tests target the plain request methods (post_prompt / request_stop /
get_messages) against a fake HTTP transport.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.opencode_client import OpenCodeClient, SSEConnectionError
from tests.conftest import MockResponse

BASE_URL = "http://localhost:4096"
SESSION_ID = "oc-session-123"


def make_client(http_client: AsyncMock) -> OpenCodeClient:
    return OpenCodeClient(
        http_client=http_client,
        base_url=BASE_URL,
        log=MagicMock(),
    )


class TestPostPrompt:
    async def test_posts_body_to_prompt_async_endpoint(self):
        http_client = AsyncMock()
        http_client.post.return_value = MockResponse(204)
        body = {"parts": [{"type": "text", "text": "hi"}]}

        await make_client(http_client).post_prompt(SESSION_ID, body)

        assert http_client.post.await_count == 1
        args, kwargs = http_client.post.await_args
        assert args[0] == f"{BASE_URL}/session/{SESSION_ID}/prompt_async"
        assert kwargs["json"] == body

    async def test_raises_on_error_status(self):
        http_client = AsyncMock()
        http_client.post.return_value = MockResponse(500, text="boom")

        with pytest.raises(RuntimeError, match="Async prompt failed: 500 - boom"):
            await make_client(http_client).post_prompt(SESSION_ID, {"parts": []})


class TestRequestStop:
    async def test_posts_abort_and_reports_success(self):
        http_client = AsyncMock()
        http_client.post.return_value = MockResponse(200)

        stopped = await make_client(http_client).request_stop(SESSION_ID, reason="command")

        assert stopped is True
        args, _ = http_client.post.await_args
        assert args[0] == f"{BASE_URL}/session/{SESSION_ID}/abort"

    async def test_no_session_id_is_a_noop(self):
        http_client = AsyncMock()

        stopped = await make_client(http_client).request_stop(None, reason="command")

        assert stopped is False
        http_client.post.assert_not_awaited()

    async def test_transport_error_reports_failure(self):
        http_client = AsyncMock()
        http_client.post.side_effect = ConnectionError("refused")

        stopped = await make_client(http_client).request_stop(SESSION_ID, reason="command")

        assert stopped is False


class TestGetMessages:
    async def test_returns_parsed_message_list(self):
        messages = [{"info": {"id": "oc-msg-1", "role": "assistant"}, "parts": []}]
        http_client = AsyncMock()
        http_client.get.return_value = MockResponse(200, messages)

        result = await make_client(http_client).get_messages(SESSION_ID)

        assert result == messages
        args, _ = http_client.get.await_args
        assert args[0] == f"{BASE_URL}/session/{SESSION_ID}/message"

    async def test_returns_none_on_error_status(self):
        http_client = AsyncMock()
        http_client.get.return_value = MockResponse(500)

        assert await make_client(http_client).get_messages(SESSION_ID) is None


class TestOpenEventStream:
    async def test_raises_on_non_200_response(self):
        class FailingStream:
            status_code = 503

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return None

        http_client = MagicMock()
        http_client.stream.return_value = FailingStream()

        with pytest.raises(SSEConnectionError, match="SSE connection failed: 503"):
            async with make_client(http_client).open_event_stream():
                pass

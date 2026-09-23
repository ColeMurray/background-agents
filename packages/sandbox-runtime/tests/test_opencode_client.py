"""
Unit tests for OpenCodeClient transport seams exposed by the extraction.

SSE frame parsing and end-to-end streaming stay covered by test_bridge_sse.py;
these tests target the plain request methods (create_session / session_exists /
post_prompt / request_stop / get_messages) and the events() context manager
against a fake HTTP transport.
"""

import asyncio
import json
from collections.abc import AsyncIterator
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from sandbox_runtime.harness.opencode_client import (
    OpenCodeClient,
    SSEConnectionError,
    SSEInactivityTimeoutError,
    SSEStreamDisconnectedError,
)
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


class TestWaitUntilIdle:
    async def test_polls_until_execution_domain_is_idle(self):
        http_client = AsyncMock()
        http_client.get.side_effect = [
            MockResponse(200, {SESSION_ID: {"type": "busy"}}),
            MockResponse(200, {}),
        ]

        stopped = await make_client(http_client).wait_until_idle(timeout_seconds=1)

        assert stopped is True
        assert http_client.get.await_count == 2

    @pytest.mark.parametrize(
        "statuses",
        [
            {"child": {"type": "busy"}},
            {SESSION_ID: {"type": "idle"}, "child": {"type": "busy"}},
        ],
    )
    async def test_busy_child_prevents_domain_idle(self, statuses):
        http_client = AsyncMock()
        http_client.get.return_value = MockResponse(200, statuses)

        assert await make_client(http_client).wait_until_idle(timeout_seconds=0.01) is False

    async def test_waits_until_child_is_idle(self):
        http_client = AsyncMock()
        http_client.get.side_effect = [
            MockResponse(200, {SESSION_ID: {"type": "idle"}, "child": {"type": "busy"}}),
            MockResponse(200, {SESSION_ID: {"type": "idle"}, "child": {"type": "idle"}}),
        ]

        assert await make_client(http_client).wait_until_idle(timeout_seconds=1) is True
        assert http_client.get.await_count == 2

    async def test_active_session_at_deadline_is_unconfirmed(self):
        http_client = AsyncMock()
        http_client.get.return_value = MockResponse(200, {SESSION_ID: {"type": "busy"}})

        stopped = await make_client(http_client).wait_until_idle(timeout_seconds=0.01)

        assert stopped is False

    async def test_hung_status_request_cannot_outlive_deadline(self):
        http_client = AsyncMock()
        request_started = asyncio.Event()

        async def hung_status(*_args, **_kwargs):
            request_started.set()
            await asyncio.Event().wait()

        http_client.get.side_effect = hung_status

        stopped = await asyncio.wait_for(
            make_client(http_client).wait_until_idle(timeout_seconds=0.01),
            timeout=0.2,
        )

        assert stopped is False
        assert request_started.is_set()

    async def test_explicit_cancellation_propagates_during_status_request(self):
        http_client = AsyncMock()
        request_started = asyncio.Event()

        async def hung_status(*_args, **_kwargs):
            request_started.set()
            await asyncio.Event().wait()

        http_client.get.side_effect = hung_status
        waiting = asyncio.create_task(make_client(http_client).wait_until_idle(timeout_seconds=1))
        await request_started.wait()
        waiting.cancel()

        with pytest.raises(asyncio.CancelledError):
            await waiting

    async def test_delayed_busy_status_uses_recalculated_sleep_budget(self, monkeypatch):
        http_client = AsyncMock()
        real_sleep = asyncio.sleep
        requested_sleeps = []

        async def delayed_busy(*_args, **_kwargs):
            await real_sleep(0.1)
            return MockResponse(200, {SESSION_ID: {"type": "busy"}})

        async def record_sleep(delay):
            requested_sleeps.append(delay)
            await real_sleep(delay)

        http_client.get.side_effect = delayed_busy
        monkeypatch.setattr("sandbox_runtime.harness.opencode_client.asyncio.sleep", record_sleep)
        monkeypatch.setattr(
            "sandbox_runtime.harness.opencode_client.EXECUTION_STOP_POLL_SECONDS", 1.0
        )

        stopped = await asyncio.wait_for(
            make_client(http_client).wait_until_idle(timeout_seconds=0.2),
            timeout=0.5,
        )

        assert stopped is False
        assert len(requested_sleeps) == 1
        assert requested_sleeps[0] < 0.15

    @pytest.mark.parametrize(
        "payload",
        [
            [{"type": "idle"}],
            "idle",
            {SESSION_ID: "idle"},
            {SESSION_ID: {"type": "idle"}, "child": {"status": "idle"}},
            {SESSION_ID: {"type": "idle"}, "child": {"type": "unknown"}},
        ],
    )
    async def test_malformed_status_payload_is_not_idle_evidence(self, payload):
        http_client = AsyncMock()
        http_client.get.return_value = MockResponse(200, payload)

        stopped = await make_client(http_client).wait_until_idle(timeout_seconds=0.01)

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


class TestPoolOwnership:
    async def test_aclose_leaves_injected_pool_open(self):
        pool = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200)))
        client = OpenCodeClient(base_url=BASE_URL, log=MagicMock(), http_client=pool)

        assert await client.session_exists(SESSION_ID) is True
        await client.aclose()

        assert pool.is_closed is False
        await pool.aclose()

    async def test_owned_pool_created_lazily_and_closed_by_aclose(self):
        client = OpenCodeClient(base_url=BASE_URL, log=MagicMock())

        pool = client._client()

        assert client._client() is pool
        await client.aclose()
        assert pool.is_closed


class TestCreateSession:
    async def test_returns_created_session_id(self):
        http_client = AsyncMock()
        http_client.post.return_value = MockResponse(200, {"id": "oc-new-session"})

        session_id = await make_client(http_client).create_session()

        assert session_id == "oc-new-session"
        args, kwargs = http_client.post.await_args
        assert args[0] == f"{BASE_URL}/session"
        assert kwargs["json"] == {}

    async def test_raises_on_error_status(self):
        http_client = AsyncMock()
        http_client.post.return_value = MockResponse(500, {})

        with pytest.raises(httpx.HTTPStatusError):
            await make_client(http_client).create_session()


class TestSessionExists:
    async def test_true_on_200(self):
        http_client = AsyncMock()
        http_client.get.return_value = MockResponse(200, {"id": SESSION_ID})

        assert await make_client(http_client).session_exists(SESSION_ID) is True
        args, _ = http_client.get.await_args
        assert args[0] == f"{BASE_URL}/session/{SESSION_ID}"

    async def test_false_on_non_200(self):
        http_client = AsyncMock()
        http_client.get.return_value = MockResponse(404)

        assert await make_client(http_client).session_exists(SESSION_ID) is False


class MockSSEStream:
    """Fake httpx streaming response: a context manager yielding text chunks."""

    def __init__(self, chunks: list[str], status_code: int = 200):
        self.status_code = status_code
        self._chunks = chunks

    async def aiter_text(self) -> AsyncIterator[str]:
        for chunk in self._chunks:
            yield chunk
            await asyncio.sleep(0)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None


def sse_frame(event_type: str) -> str:
    return f"data: {json.dumps({'type': event_type, 'properties': {}})}\n\n"


class TestEvents:
    async def test_yields_decoded_event_dicts(self):
        http_client = MagicMock()
        http_client.stream.return_value = MockSSEStream(
            [sse_frame("server.connected"), sse_frame("session.idle")]
        )

        received = []
        async with make_client(http_client).events(inactivity_timeout_seconds=5.0) as events:
            async for event in events:
                received.append(event)

        assert [e["type"] for e in received] == ["server.connected", "session.idle"]

    async def test_raises_on_non_200_response(self):
        http_client = MagicMock()
        http_client.stream.return_value = MockSSEStream([], status_code=503)

        with pytest.raises(SSEConnectionError, match="SSE connection failed: 503"):
            async with make_client(http_client).events(inactivity_timeout_seconds=5.0):
                pass

    async def test_translates_transport_failure(self):
        class DroppingSSEStream(MockSSEStream):
            async def aiter_text(self) -> AsyncIterator[str]:
                async for chunk in super().aiter_text():
                    yield chunk
                raise httpx.RemoteProtocolError("peer closed connection")

        http_client = MagicMock()
        http_client.stream.return_value = DroppingSSEStream([sse_frame("server.connected")])

        with pytest.raises(SSEStreamDisconnectedError):
            async with make_client(http_client).events(inactivity_timeout_seconds=5.0) as events:
                async for _event in events:
                    pass

    async def test_raises_inactivity_error_when_stream_hangs(self):
        class HangingSSEStream(MockSSEStream):
            async def aiter_text(self) -> AsyncIterator[str]:
                yield sse_frame("server.connected")
                await asyncio.sleep(60)

        http_client = MagicMock()
        http_client.stream.return_value = HangingSSEStream([])

        with pytest.raises(SSEInactivityTimeoutError, match="SSE stream inactive"):
            async with make_client(http_client).events(inactivity_timeout_seconds=0.05) as events:
                async for _event in events:
                    pass

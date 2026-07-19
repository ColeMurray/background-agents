"""HTTP/SSE transport client for the bundled local OpenCode server."""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Any, Final

import httpx

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from .log_config import StructuredLogger

HTTP_CONNECT_TIMEOUT_SECONDS: Final = 30.0
OPENCODE_REQUEST_TIMEOUT_SECONDS: Final = 30.0


class SSEConnectionError(Exception):
    """Raised when SSE connection fails."""


class SSEStreamDisconnectedError(SSEConnectionError):
    """Raised when the SSE transport fails while connecting or mid-stream."""


class SSEInactivityTimeoutError(Exception):
    """Raised when no SSE data arrives within the inactivity deadline."""


class OpenCodeClient:
    """HTTP/SSE transport for the local OpenCode server.

    Owns the OpenCode base URL and every raw wire concern: session
    creation/lookup, the ``/event`` SSE stream and its frame parsing, kicking
    off async prompts, aborting sessions, and fetching message state.
    Prompt-lifecycle policy (inactivity/max-duration values, request-body
    construction, event translation) stays in ``OpenCodePromptStream``.

    Owns its connection pool unless one is injected.
    """

    def __init__(
        self,
        *,
        base_url: str,
        log: StructuredLogger,
        http_client: httpx.AsyncClient | None = None,
        connect_timeout_seconds: float = HTTP_CONNECT_TIMEOUT_SECONDS,
        request_timeout_seconds: float = OPENCODE_REQUEST_TIMEOUT_SECONDS,
    ) -> None:
        self._base_url = base_url
        self._log = log
        self._http_client = http_client
        self._owns_http_client = http_client is None
        self._connect_timeout_seconds = connect_timeout_seconds
        self._request_timeout_seconds = request_timeout_seconds

    async def aclose(self) -> None:
        if self._owns_http_client and self._http_client is not None:
            await self._http_client.aclose()

    def _client(self) -> httpx.AsyncClient:
        # Created on first request so constructing a bridge that never runs
        # (common in tests) does not leak an unclosed connection pool.
        if self._http_client is None:
            self._http_client = httpx.AsyncClient(
                timeout=httpx.Timeout(
                    self._request_timeout_seconds,
                    connect=self._connect_timeout_seconds,
                )
            )
        return self._http_client

    async def create_session(self) -> str | None:
        """Create a new OpenCode session, returning its id."""
        response = await self._client().post(
            f"{self._base_url}/session",
            json={},
            timeout=self._request_timeout_seconds,
        )
        response.raise_for_status()
        data: dict[str, Any] = response.json()
        session_id: str | None = data.get("id")
        return session_id

    async def session_exists(self, opencode_session_id: str) -> bool:
        """Whether OpenCode still knows the session (a 200 from its lookup)."""
        response = await self._client().get(
            f"{self._base_url}/session/{opencode_session_id}",
            timeout=self._request_timeout_seconds,
        )
        return response.status_code == 200

    @asynccontextmanager
    async def events(
        self, *, inactivity_timeout_seconds: float
    ) -> AsyncIterator[AsyncIterator[dict[str, Any]]]:
        """Open the ``/event`` SSE stream and hand back decoded event dicts.

        Owns the response lifecycle and the inactivity deadline: the deadline
        is armed before connecting, reset on every chunk received, and covers
        the caller's body for the lifetime of the context; expiry raises
        ``SSEInactivityTimeoutError``. A non-200 handshake raises
        ``SSEConnectionError``; httpx transport failures (while connecting or
        mid-stream) are translated into ``SSEStreamDisconnectedError``.
        """
        try:
            async with asyncio.timeout(inactivity_timeout_seconds) as timeout_ctx:
                async with self._client().stream(
                    "GET",
                    f"{self._base_url}/event",
                    timeout=httpx.Timeout(None, connect=self._connect_timeout_seconds, read=None),
                ) as response:
                    if response.status_code != 200:
                        raise SSEConnectionError(f"SSE connection failed: {response.status_code}")
                    yield self._decoded_events(response, timeout_ctx, inactivity_timeout_seconds)
        except TimeoutError:
            raise SSEInactivityTimeoutError(
                f"SSE stream inactive for {inactivity_timeout_seconds:.0f}s (no data received)."
            )
        except httpx.TransportError as e:
            self._log.error("bridge.sse_transport_error", exc=e)
            raise SSEStreamDisconnectedError(str(e)) from e

    async def post_prompt(self, opencode_session_id: str, request_body: dict[str, Any]) -> None:
        """Kick off the async prompt; the response arrives on the SSE stream."""
        prompt_response = await self._client().post(
            f"{self._base_url}/session/{opencode_session_id}/prompt_async",
            json=request_body,
            timeout=self._request_timeout_seconds,
        )
        if prompt_response.status_code not in [200, 204]:
            error_body = prompt_response.text
            self._log.error(
                "bridge.prompt_request_error",
                status_code=prompt_response.status_code,
                error_body=error_body,
            )
            raise RuntimeError(f"Async prompt failed: {prompt_response.status_code} - {error_body}")

    async def request_stop(self, opencode_session_id: str | None, *, reason: str) -> bool:
        """Best-effort abort of the active OpenCode prompt (saves LLM compute)."""
        if not opencode_session_id:
            return False

        try:
            await self._client().post(
                f"{self._base_url}/session/{opencode_session_id}/abort",
                timeout=self._request_timeout_seconds,
            )
            self._log.info("bridge.stop_requested", reason=reason)
            return True
        except Exception as e:
            self._log.warn("bridge.stop_request_error", exc=e, reason=reason)
            return False

    async def get_messages(self, opencode_session_id: str) -> list[Any] | None:
        """Fetch the session's message list; ``None`` when OpenCode rejects the fetch."""
        response = await self._client().get(
            f"{self._base_url}/session/{opencode_session_id}/message",
            timeout=self._request_timeout_seconds,
        )
        if response.status_code != 200:
            self._log.warn(
                "bridge.final_state_fetch_error",
                status_code=response.status_code,
            )
            return None
        messages: list[Any] = response.json()
        return messages

    async def _decoded_events(
        self,
        response: httpx.Response,
        timeout_ctx: asyncio.Timeout | None = None,
        inactivity_timeout_seconds: float | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Parse Server-Sent Events stream from OpenCode.

        SSE format:
            data: {"type": "...", "properties": {...}}

            data: {"type": "...", "properties": {...}}

        Events are separated by double newlines.
        If timeout_ctx is provided, its deadline is reset to now plus
        ``inactivity_timeout_seconds`` on every chunk received.
        """
        buffer = ""
        async for chunk in response.aiter_text():
            buffer += chunk
            if timeout_ctx is not None and inactivity_timeout_seconds is not None:
                timeout_ctx.reschedule(
                    asyncio.get_running_loop().time() + inactivity_timeout_seconds
                )

            # Frames split on LF-LF only: the peer is the bundled localhost
            # OpenCode server (Bun/Hono), which emits LF-framed SSE. CRLF
            # framing is deliberately not handled.
            while "\n\n" in buffer:
                event_str, buffer = buffer.split("\n\n", 1)

                # Parse the event lines
                data_lines: list[str] = []
                for line in event_str.split("\n"):
                    if line.startswith("data:"):
                        # Handle both "data: {...}" and "data:{...}" formats
                        data_content = line[5:].lstrip()
                        if data_content:
                            data_lines.append(data_content)

                # Join multi-line data and parse JSON
                if data_lines:
                    try:
                        raw_data = "\n".join(data_lines)
                        event = json.loads(raw_data)
                        yield event
                    except json.JSONDecodeError as e:
                        self._log.debug("bridge.sse_parse_error", exc=e)

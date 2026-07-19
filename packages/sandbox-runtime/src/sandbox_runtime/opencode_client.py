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


class OpenCodeClient:
    """HTTP/SSE transport for the local OpenCode server.

    Owns the OpenCode base URL and every raw wire concern: opening the
    ``/event`` SSE stream, parsing SSE frames, kicking off async prompts,
    aborting sessions, and fetching message state. Prompt-lifecycle policy
    (inactivity/max-duration timeouts, request-body construction, event
    translation) stays in ``OpenCodePromptStream``.
    """

    def __init__(
        self,
        *,
        http_client: httpx.AsyncClient,
        base_url: str,
        log: StructuredLogger,
        connect_timeout_seconds: float = HTTP_CONNECT_TIMEOUT_SECONDS,
        request_timeout_seconds: float = OPENCODE_REQUEST_TIMEOUT_SECONDS,
    ) -> None:
        self._http_client = http_client
        self._base_url = base_url
        self._log = log
        self._connect_timeout_seconds = connect_timeout_seconds
        self._request_timeout_seconds = request_timeout_seconds

    @asynccontextmanager
    async def open_event_stream(self) -> AsyncIterator[httpx.Response]:
        """Open the ``/event`` SSE stream, failing fast on a non-200 response."""
        async with self._http_client.stream(
            "GET",
            f"{self._base_url}/event",
            timeout=httpx.Timeout(None, connect=self._connect_timeout_seconds, read=None),
        ) as response:
            if response.status_code != 200:
                raise SSEConnectionError(f"SSE connection failed: {response.status_code}")
            yield response

    async def post_prompt(self, opencode_session_id: str, request_body: dict[str, Any]) -> None:
        """Kick off the async prompt; the response arrives on the SSE stream."""
        prompt_response = await self._http_client.post(
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
            await self._http_client.post(
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
        response = await self._http_client.get(
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

    async def parse_sse_stream(
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

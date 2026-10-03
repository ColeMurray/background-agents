"""Bounded, retried GETs for the sandbox-only control-plane boot endpoints."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

import httpx

if TYPE_CHECKING:
    from collections.abc import Mapping

CONTROL_PLANE_FETCH_ATTEMPTS = 3
CONTROL_PLANE_FETCH_RETRY_BASE_SECONDS = 0.25


class ResponseTooLargeError(RuntimeError):
    """The response body exceeded the caller's byte limit; never retried."""


def retryable_fetch_error(error: Exception) -> bool:
    """Timeouts, throttling, server failures, and transport errors may succeed on retry."""
    if isinstance(error, httpx.HTTPStatusError):
        return error.response.status_code in {408, 429} or error.response.status_code >= 500
    return isinstance(error, (httpx.TransportError, OSError))


async def fetch_bounded(
    url: str,
    *,
    headers: Mapping[str, str],
    max_bytes: int,
    timeout_seconds: float,
    transport: httpx.AsyncBaseTransport | None = None,
) -> bytes:
    """Stream a 2xx body of at most ``max_bytes``, retrying transient failures.

    Raises ResponseTooLargeError for an oversized body, or the last
    ``httpx.HTTPError``/``OSError`` once the error is permanent or the attempts
    are exhausted. Callers translate both into their own failure types.
    """
    for attempt in range(CONTROL_PLANE_FETCH_ATTEMPTS):
        try:
            async with (
                httpx.AsyncClient(transport=transport) as client,
                client.stream("GET", url, headers=headers, timeout=timeout_seconds) as response,
            ):
                response.raise_for_status()
                chunks: list[bytes] = []
                size = 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > max_bytes:
                        raise ResponseTooLargeError("response exceeds the size limit")
                    chunks.append(chunk)
                return b"".join(chunks)
        except (httpx.HTTPError, OSError) as error:
            if not retryable_fetch_error(error) or attempt == CONTROL_PLANE_FETCH_ATTEMPTS - 1:
                raise
            await asyncio.sleep(CONTROL_PLANE_FETCH_RETRY_BASE_SECONDS * (2**attempt))
    raise AssertionError("unreachable: the final attempt returns or raises")

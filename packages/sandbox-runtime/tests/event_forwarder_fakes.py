"""Shared WebSocket fakes for the BufferedEventForwarder suites."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

from websockets import State

from sandbox_runtime.event_forwarder import SEND_TIMEOUT_SECONDS, BufferedEventForwarder


def make_forwarder(
    max_buffer_size: int = 1000,
    send_timeout_seconds: float = SEND_TIMEOUT_SECONDS,
) -> BufferedEventForwarder:
    return BufferedEventForwarder(
        sandbox_id="test-sandbox",
        log=MagicMock(),
        max_buffer_size=max_buffer_size,
        send_timeout_seconds=send_timeout_seconds,
    )


def open_ws() -> MagicMock:
    ws = MagicMock()
    ws.state = State.OPEN
    ws.send = AsyncMock()
    # An AsyncMock, so `assert_not_awaited` is a real assertion rather than an
    # auto-created attribute that passes no matter what.
    ws.close = AsyncMock()
    return ws


def sent_events(ws: MagicMock) -> list[dict]:
    return [json.loads(call.args[0]) for call in ws.send.await_args_list]


def wedged_ws(fail_signal: asyncio.Event) -> MagicMock:
    """A connection whose sends hang until signalled, then fail."""
    ws = MagicMock()
    ws.state = State.OPEN

    async def wedged_send(data: str) -> None:
        await fail_signal.wait()
        raise ConnectionError("stale connection flap")

    ws.send = wedged_send
    ws.close = AsyncMock()
    return ws


def hung_ws() -> MagicMock:
    """A peer that stopped reading.

    The socket stays OPEN and every send parks in flow control forever, so a
    write timeout is the only thing that can reveal the connection is dead.
    """
    ws = MagicMock()
    ws.state = State.OPEN

    async def never_completes(data: str) -> None:
        await asyncio.Event().wait()

    ws.send = never_completes
    ws.close = AsyncMock()
    return ws


async def settle() -> None:
    """Let every runnable coroutine advance to its next suspension point."""
    for _ in range(5):
        await asyncio.sleep(0)

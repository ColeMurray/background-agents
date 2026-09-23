"""Shutdown-stop deadline tests for the OpenCode harness."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.harness.opencode import OpencodeHarness

SESSION_ID = "oc-session-123"


def make_harness(client) -> OpencodeHarness:
    harness = OpencodeHarness(
        client=client,
        attachment_processor=MagicMock(),
        log=MagicMock(),
        limits=MagicMock(),
    )
    harness.session_id = SESSION_ID
    return harness


@pytest.mark.asyncio
async def test_stop_execution_bounds_hung_stop_request() -> None:
    stop_started = asyncio.Event()

    async def hung_stop(*_args, **_kwargs):
        stop_started.set()
        await asyncio.Event().wait()

    client = SimpleNamespace(
        request_stop=AsyncMock(side_effect=hung_stop),
        wait_until_idle=AsyncMock(),
    )

    stopped = await asyncio.wait_for(make_harness(client).stop_execution(0.01), timeout=0.2)

    assert stopped is False
    assert stop_started.is_set()
    client.wait_until_idle.assert_not_awaited()


@pytest.mark.asyncio
async def test_stop_execution_propagates_explicit_cancellation() -> None:
    stop_started = asyncio.Event()

    async def hung_stop(*_args, **_kwargs):
        stop_started.set()
        await asyncio.Event().wait()

    client = SimpleNamespace(
        request_stop=AsyncMock(side_effect=hung_stop),
        wait_until_idle=AsyncMock(),
    )
    stopping = asyncio.create_task(make_harness(client).stop_execution(1))
    await stop_started.wait()
    stopping.cancel()

    with pytest.raises(asyncio.CancelledError):
        await stopping


@pytest.mark.asyncio
async def test_stop_execution_requests_stop_then_confirms_idle() -> None:
    client = SimpleNamespace(
        request_stop=AsyncMock(return_value=True),
        wait_until_idle=AsyncMock(return_value=True),
    )

    assert await make_harness(client).stop_execution(1) is True
    client.request_stop.assert_awaited_once_with(SESSION_ID, reason="preservation")
    client.wait_until_idle.assert_awaited_once()
    assert client.wait_until_idle.await_args.args == ()
    remaining = client.wait_until_idle.await_args.kwargs["timeout_seconds"]
    assert 0 < remaining <= 1


@pytest.mark.asyncio
async def test_stop_execution_without_parent_session_still_requires_domain_idle() -> None:
    client = SimpleNamespace(
        request_stop=AsyncMock(return_value=False),
        wait_until_idle=AsyncMock(return_value=False),
    )
    harness = make_harness(client)
    harness.session_id = None

    assert await harness.stop_execution(1) is False
    client.request_stop.assert_awaited_once_with(None, reason="preservation")
    client.wait_until_idle.assert_awaited_once()

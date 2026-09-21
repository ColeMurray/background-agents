"""Claude harness execution containment for shutdown."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

import pytest

from tests.test_claude_harness import Harness, _result, _run

if TYPE_CHECKING:
    from pathlib import Path


class TestShutdownStop:
    @pytest.mark.asyncio
    async def test_disconnects_owned_child_after_interrupt(self, tmp_path: Path) -> None:
        h = Harness(tmp_path, turns=[[_result(0.1)]])
        await h.harness.open()
        await h.harness.create_session()
        await _run(h.harness)

        assert await h.harness.stop_execution(1) is True
        assert h.client.interrupts == 1
        assert h.client.disconnected is True
        assert h.harness._client is None

    @pytest.mark.asyncio
    async def test_hanging_interrupt_escalates_to_owned_child_disconnect(
        self, tmp_path: Path
    ) -> None:
        h = Harness(
            tmp_path,
            turns=[[_result(0.1)]],
            client_kwargs={"hang_interrupt": True},
        )
        await h.harness.open()
        await h.harness.create_session()
        await _run(h.harness)

        assert await h.harness.stop_execution(0.1) is True
        assert h.client.disconnected is True
        assert h.harness._client is None

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "client_kwargs", [{"fail_disconnect": True}, {"hang_disconnect": True}]
    )
    async def test_failed_disconnect_is_not_reported_as_contained_and_remains_retryable(
        self, tmp_path: Path, client_kwargs: dict[str, bool]
    ) -> None:
        h = Harness(tmp_path, turns=[[_result(0.1)]], client_kwargs=client_kwargs)
        await h.harness.open()
        await h.harness.create_session()
        await _run(h.harness)
        client = h.client

        assert await h.harness.stop_execution(0.05) is False
        assert h.harness._client is client

        client.fail_disconnect = False
        client.hang_disconnect = False
        assert await h.harness.stop_execution(0.1) is True
        assert client.disconnected is True
        assert h.harness._client is None

    @pytest.mark.asyncio
    async def test_concurrent_cleanup_cannot_erase_failed_disconnect_owner(
        self, tmp_path: Path
    ) -> None:
        h = Harness(tmp_path, turns=[[_result(0.1)]], client_kwargs={"fail_disconnect": True})
        await h.harness.open()
        await h.harness.create_session()
        await _run(h.harness)
        client = h.client

        async def interrupt_with_prompt_cleanup() -> None:
            await h.harness._disconnect()

        client.interrupt = interrupt_with_prompt_cleanup  # type: ignore[method-assign]

        assert await h.harness.stop_execution(0.1) is False
        assert h.harness._client is client

    @pytest.mark.asyncio
    async def test_stop_budget_includes_wait_for_concurrent_disconnect(
        self, tmp_path: Path
    ) -> None:
        h = Harness(tmp_path, turns=[[_result(0.1)]])
        await h.harness.open()
        await h.harness.create_session()
        await _run(h.harness)
        client = h.client
        disconnect_started = asyncio.Event()
        release_disconnect = asyncio.Event()

        async def stalled_disconnect() -> None:
            disconnect_started.set()
            await release_disconnect.wait()
            client.disconnected = True

        client.disconnect = stalled_disconnect  # type: ignore[method-assign]
        cleanup = asyncio.create_task(h.harness._disconnect())
        await disconnect_started.wait()

        assert await h.harness.stop_execution(0.01) is False
        assert h.harness._client is client

        release_disconnect.set()
        await cleanup
        assert h.harness._client is None
        assert await h.harness.stop_execution(0.01) is True

    @pytest.mark.asyncio
    async def test_connect_and_stop_are_serialized_without_losing_connecting_owner(
        self, tmp_path: Path
    ) -> None:
        h = Harness(tmp_path, turns=[], client_kwargs={"hang_connect": True})
        await h.harness.open()
        await h.harness.create_session()
        connecting = asyncio.create_task(h.harness._ensure_client("claude-sonnet-4-6", None))

        async def wait_for_client_owner() -> None:
            while h.harness._client is None:
                await asyncio.sleep(0)

        await asyncio.wait_for(wait_for_client_owner(), timeout=0.1)
        client = h.harness._client
        assert await h.harness.stop_execution(0.01) is False
        assert h.harness._client is client

        connecting.cancel()
        with pytest.raises(asyncio.CancelledError):
            await connecting
        assert h.harness._client is client

        h.client.hang_connect = False
        await h.harness._disconnect()
        assert h.harness._client is None

    @pytest.mark.asyncio
    async def test_explicit_stop_cancellation_retains_owned_client(self, tmp_path: Path) -> None:
        h = Harness(tmp_path, turns=[[_result(0.1)]], client_kwargs={"hang_disconnect": True})
        await h.harness.open()
        await h.harness.create_session()
        await _run(h.harness)
        client = h.client
        stopping = asyncio.create_task(h.harness.stop_execution(1))

        async def wait_for_interrupt() -> None:
            while client.interrupts == 0:
                await asyncio.sleep(0)

        await asyncio.wait_for(wait_for_interrupt(), timeout=0.1)
        stopping.cancel()
        with pytest.raises(asyncio.CancelledError):
            await stopping
        assert h.harness._client is client

        client.hang_disconnect = False
        assert await h.harness.stop_execution(0.1) is True

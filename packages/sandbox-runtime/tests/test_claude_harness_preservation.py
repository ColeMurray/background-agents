"""Claude harness execution containment for final preservation."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from tests.test_claude_harness import Harness, _result, _run

if TYPE_CHECKING:
    from pathlib import Path


class TestPreservationStop:
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

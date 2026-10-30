"""Resuming a persisted OpenCode session stops what an earlier bridge left running."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.harness import HarnessStartError
from sandbox_runtime.harness.opencode import OpencodeHarness

SESSION_ID = "oc-persisted"


def make_harness(client) -> OpencodeHarness:
    return OpencodeHarness(
        client=client,
        attachment_processor=MagicMock(),
        log=MagicMock(),
        limits=MagicMock(),
    )


def make_client(*, exists: bool = True, idle: list[bool] | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        session_exists=AsyncMock(return_value=exists),
        request_stop=AsyncMock(return_value=True),
        wait_until_idle=AsyncMock(side_effect=idle if idle is not None else [True]),
    )


@pytest.fixture
def no_retry_delay(monkeypatch):
    monkeypatch.setattr(
        "sandbox_runtime.harness.opencode.INHERITED_EXECUTION_STOP_RETRY_DELAY_SECONDS", 0.0
    )


async def test_resume_stops_the_inherited_execution_before_adopting():
    client = make_client()
    harness = make_harness(client)

    assert await harness.resume_session(SESSION_ID) is True

    assert harness.session_id == SESSION_ID
    client.request_stop.assert_awaited_once_with(SESSION_ID, reason="preservation")
    client.wait_until_idle.assert_awaited_once()


async def test_a_missing_session_is_not_stopped():
    client = make_client(exists=False)
    harness = make_harness(client)

    assert await harness.resume_session(SESSION_ID) is False

    assert harness.session_id is None
    client.request_stop.assert_not_awaited()


async def test_a_created_session_is_not_stopped():
    client = make_client()
    client.create_session = AsyncMock(return_value="oc-new")
    harness = make_harness(client)

    await harness.create_session()

    assert harness.session_id == "oc-new"
    client.request_stop.assert_not_awaited()


async def test_stop_is_retried_within_its_budget(no_retry_delay):
    """A server mid-tool-call may need a moment to honour the abort."""
    client = make_client(idle=[False, False, True])
    harness = make_harness(client)

    assert await harness.resume_session(SESSION_ID) is True

    assert client.request_stop.await_count == 3


async def test_a_session_that_stays_busy_refuses_the_resume(monkeypatch, no_retry_delay):
    monkeypatch.setattr(
        "sandbox_runtime.harness.opencode.INHERITED_EXECUTION_STOP_BUDGET_SECONDS", 0.0
    )
    client = make_client(idle=[False])
    harness = make_harness(client)

    with pytest.raises(HarnessStartError, match=SESSION_ID):
        await harness.resume_session(SESSION_ID)

    assert client.request_stop.await_count == 1

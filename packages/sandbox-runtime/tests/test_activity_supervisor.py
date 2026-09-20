"""Behavioral interleavings owned by the runtime activity supervisor."""

import asyncio
from unittest.mock import MagicMock

import pytest

from sandbox_runtime.activity_supervisor import ActivitySupervisor


def make_supervisor(events: list[dict]) -> ActivitySupervisor:
    async def send(event: dict) -> None:
        events.append(event)

    return ActivitySupervisor(
        send_event=send,
        prompt_finished=lambda: None,
        refresh_diff=lambda _message_id: None,
        log=MagicMock(),
    )


@pytest.mark.asyncio
async def test_preservation_drains_all_overlapping_prompts() -> None:
    events: list[dict] = []
    entered = [asyncio.Event(), asyncio.Event()]

    async def pending_prompt(index: int) -> dict:
        entered[index].set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    supervisor = make_supervisor(events)
    supervisor.start_prompt("first", lambda: pending_prompt(0))
    supervisor.start_prompt("second", lambda: pending_prompt(1))
    await asyncio.gather(*(event.wait() for event in entered))

    stopped = await supervisor.drain_for_preservation(
        deadline=asyncio.get_running_loop().time() + 1,
        prompt_error="sandbox_lifetime_expiring",
        push_cancellation_event=lambda _command: {},
        stop_execution=lambda _timeout: asyncio.sleep(0, result=True),
    )

    assert stopped is True
    assert supervisor.current_prompt_task is None
    assert [event["messageId"] for event in events] == ["first", "second"]
    assert all(event["error"] == "sandbox_lifetime_expiring" for event in events)


@pytest.mark.asyncio
async def test_prestart_prompt_cancellation_selects_one_terminal() -> None:
    events: list[dict] = []
    supervisor = make_supervisor(events)

    async def never_started() -> dict:
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    supervisor.start_prompt("message-1", never_started)
    supervisor.interrupt_prompt("sandbox_lifetime_expiring")

    async def wait_for_terminal() -> None:
        while not events:
            await asyncio.sleep(0)

    await asyncio.wait_for(wait_for_terminal(), timeout=0.1)

    assert events == [
        {
            "type": "execution_complete",
            "messageId": "message-1",
            "success": False,
            "error": "sandbox_lifetime_expiring",
        }
    ]


@pytest.mark.asyncio
async def test_ordinary_stop_does_not_replace_preservation_override() -> None:
    events: list[dict] = []
    entered = asyncio.Event()

    async def pending_prompt() -> dict:
        entered.set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    supervisor = make_supervisor(events)
    supervisor.start_prompt("message-1", pending_prompt)
    await entered.wait()
    supervisor.set_prompt_interruption("sandbox_lifetime_expiring", overwrite=True)
    supervisor.interrupt_prompt("Task was cancelled")

    async def wait_for_terminal() -> None:
        while not events:
            await asyncio.sleep(0)

    await asyncio.wait_for(wait_for_terminal(), timeout=0.1)
    assert events[0]["error"] == "sandbox_lifetime_expiring"

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
async def test_shutdown_drains_all_overlapping_prompts() -> None:
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

    stopped = await supervisor.drain_for_shutdown(
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
async def test_shutdown_settles_prompt_cancellation_cleanup_before_vendor_stop() -> None:
    events: list[dict] = []
    entered = asyncio.Event()
    cleanup_finished = asyncio.Event()
    stop_observations: list[bool] = []

    async def prompt() -> dict:
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            await asyncio.sleep(0)
            cleanup_finished.set()
            return {
                "type": "execution_complete",
                "messageId": "message-1",
                "success": True,
                "messageCostUsd": 0.25,
            }

    async def stop_execution(_remaining: float) -> bool:
        stop_observations.append(cleanup_finished.is_set())
        return True

    supervisor = make_supervisor(events)
    supervisor.start_prompt("message-1", prompt)
    await entered.wait()

    stopped = await supervisor.drain_for_shutdown(
        deadline=asyncio.get_running_loop().time() + 1,
        prompt_error="sandbox_lifetime_expiring",
        push_cancellation_event=lambda _command: {},
        stop_execution=stop_execution,
    )

    assert stopped is True
    assert stop_observations == [True]
    assert events == [
        {
            "type": "execution_complete",
            "messageId": "message-1",
            "success": False,
            "error": "sandbox_lifetime_expiring",
            "messageCostUsd": 0.25,
        }
    ]


@pytest.mark.asyncio
async def test_shutdown_cancels_gated_local_submission_before_vendor_idle_check() -> None:
    events: list[dict] = []
    entered = asyncio.Event()
    submit = asyncio.Event()
    vendor_busy = False

    async def prompt() -> dict:
        nonlocal vendor_busy
        entered.set()
        await submit.wait()
        vendor_busy = True
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    async def stop_execution(_remaining: float) -> bool:
        observed_idle = not vendor_busy
        submit.set()
        await asyncio.sleep(0)
        return observed_idle

    supervisor = make_supervisor(events)
    supervisor.start_prompt("message-1", prompt)
    await entered.wait()

    stopped = await supervisor.drain_for_shutdown(
        deadline=asyncio.get_running_loop().time() + 1,
        prompt_error="sandbox_lifetime_expiring",
        push_cancellation_event=lambda _command: {},
        stop_execution=stop_execution,
    )

    assert stopped is True
    assert vendor_busy is False
    assert events[0]["error"] == "sandbox_lifetime_expiring"


@pytest.mark.asyncio
async def test_shutdown_does_not_check_vendor_idle_when_local_cleanup_misses_deadline() -> None:
    events: list[dict] = []
    entered = asyncio.Event()
    cleanup_started = asyncio.Event()
    release_cleanup = asyncio.Event()
    stop_called = False

    async def prompt() -> dict:
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cleanup_started.set()
            await release_cleanup.wait()
            return {"type": "execution_complete", "messageId": "message-1", "success": True}

    async def stop_execution(_remaining: float) -> bool:
        nonlocal stop_called
        stop_called = True
        return True

    supervisor = make_supervisor(events)
    supervisor.start_prompt("message-1", prompt)
    await entered.wait()

    try:
        with pytest.raises(TimeoutError):
            await supervisor.drain_for_shutdown(
                deadline=asyncio.get_running_loop().time() + 0.01,
                prompt_error="sandbox_lifetime_expiring",
                push_cancellation_event=lambda _command: {},
                stop_execution=stop_execution,
            )
        assert cleanup_started.is_set()
        assert stop_called is False
    finally:
        release_cleanup.set()
        await supervisor.shutdown()


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
async def test_ordinary_stop_does_not_replace_shutdown_override() -> None:
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

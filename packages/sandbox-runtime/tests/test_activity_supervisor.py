"""Behavioral interleavings owned by the runtime activity supervisor."""

import asyncio
from unittest.mock import AsyncMock, MagicMock

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


@pytest.mark.asyncio
async def test_targeted_stop_drains_cleanup_then_confirms_vendor_containment() -> None:
    events: list[dict] = []
    supervisor = make_supervisor(events)
    entered = asyncio.Event()
    cleanup_started = asyncio.Event()
    release_cleanup = asyncio.Event()
    vendor_stop_started = asyncio.Event()
    vendor_stopped = asyncio.Event()

    async def prompt() -> dict:
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cleanup_started.set()
            await release_cleanup.wait()
            return {
                "type": "execution_complete",
                "messageId": "message-1",
                "success": True,
                "messageCostUsd": 1.25,
            }

    async def stop_execution(remaining: float) -> bool:
        assert 0 < remaining <= 1
        assert task.done()
        vendor_stop_started.set()
        await vendor_stopped.wait()
        return True

    supervisor.start_prompt("message-1", prompt)
    task = supervisor.current_prompt_task
    await entered.wait()
    stopping = asyncio.create_task(
        supervisor.stop_prompt(
            "message-1", command_id="stop-1", stop_execution=stop_execution, timeout_seconds=1
        )
    )
    try:
        await asyncio.wait_for(cleanup_started.wait(), timeout=1)
        assert not vendor_stop_started.is_set()
        assert not events
        release_cleanup.set()
        await asyncio.wait_for(vendor_stop_started.wait(), timeout=1)
        assert not any(event["type"] == "stop_confirmed" for event in events)
        vendor_stopped.set()
        assert await stopping is True
        await supervisor._join_deliveries(asyncio.get_running_loop().time() + 1)
        assert [event for event in events if event["type"] == "execution_complete"] == [
            {
                "type": "execution_complete",
                "messageId": "message-1",
                "success": False,
                "error": "stopped",
                "messageCostUsd": 1.25,
            }
        ]
        assert len([event for event in events if event["type"] == "stop_confirmed"]) == 1
    finally:
        release_cleanup.set()
        vendor_stopped.set()
        await stopping
        await supervisor.shutdown()


@pytest.mark.asyncio
async def test_targeted_stop_does_not_confirm_cleanup_that_outlives_deadline() -> None:
    events: list[dict] = []
    supervisor = make_supervisor(events)
    entered = asyncio.Event()
    release_cleanup = asyncio.Event()
    stop_execution = AsyncMock(return_value=True)

    async def prompt() -> dict:
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            await release_cleanup.wait()
            return {"type": "execution_complete", "messageId": "message-1", "success": True}

    supervisor.start_prompt("message-1", prompt)
    await entered.wait()
    try:
        assert not await supervisor.stop_prompt(
            "message-1",
            command_id="stop-1",
            stop_execution=stop_execution,
            timeout_seconds=0.01,
        )
        stop_execution.assert_not_awaited()
        assert not events
    finally:
        release_cleanup.set()
        await supervisor.current_prompt_task
        await supervisor.shutdown()


@pytest.mark.asyncio
async def test_targeted_stop_bounds_vendor_containment() -> None:
    events: list[dict] = []
    supervisor = make_supervisor(events)

    async def stop_execution(_remaining: float) -> bool:
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    assert not await asyncio.wait_for(
        supervisor.stop_prompt(
            "message-1",
            command_id="stop-1",
            stop_execution=stop_execution,
            timeout_seconds=0.01,
        ),
        timeout=1,
    )
    assert not events


@pytest.mark.asyncio
@pytest.mark.parametrize("completed_message_id", ["message-1", "other-message"])
async def test_targeted_stop_preserves_done_task_before_terminal_callback(
    completed_message_id: str,
) -> None:
    events: list[dict] = []
    supervisor = make_supervisor(events)
    completion = {
        "type": "execution_complete",
        "messageId": completed_message_id,
        "success": True,
        "messageCostUsd": 1.25,
    }
    task = asyncio.create_task(asyncio.sleep(0, result=completion))
    await task
    supervisor.track_prompt(completed_message_id, task)
    stop_execution = AsyncMock(return_value=True)

    assert await supervisor.stop_prompt("message-1", command_id=None, stop_execution=stop_execution)
    await asyncio.sleep(0)
    await supervisor._join_deliveries(asyncio.get_running_loop().time() + 1)

    stop_execution.assert_awaited_once()
    terminals = [event for event in events if event["type"] == "execution_complete"]
    assert terminals == [completion]
    assert terminals[0] is completion
    assert "error" not in completion
    confirmation = next(event for event in events if event["type"] == "stop_confirmed")
    assert "commandId" not in confirmation


@pytest.mark.asyncio
async def test_outbound_deliveries_are_owned_logged_and_cancelled_at_shutdown() -> None:
    supervisor = make_supervisor([])
    entered = asyncio.Event()
    cancelled = asyncio.Event()

    async def send(event):
        if event["type"] == "command_ack":
            raise RuntimeError("receipt failed")
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    supervisor._send_event = send
    supervisor.schedule_delivery({"type": "command_ack"})
    # Admission returns even though the confirmation cannot be written.
    assert await supervisor.stop_prompt(
        "message-1", command_id="stop-1", stop_execution=AsyncMock(return_value=True)
    )
    await asyncio.wait_for(entered.wait(), timeout=1)
    await asyncio.sleep(0)
    supervisor._log.error.assert_called_once()
    assert supervisor._log.error.call_args.args == ("bridge.activity_delivery_error",)
    assert len(supervisor._deliveries) == 1
    await supervisor.shutdown()
    assert cancelled.is_set()
    assert not supervisor._deliveries

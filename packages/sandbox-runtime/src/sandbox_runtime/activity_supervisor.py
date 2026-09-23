"""Own prompt/push task lifetimes and exactly-once terminal selection."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .log_config import StructuredLogger

Event = dict[str, Any]
EventSender = Callable[[Event], Awaitable[object]]


@dataclass
class _PromptActivity:
    message_id: str
    task: asyncio.Task[Event]
    interruption_error: str | None = None
    terminal_selected: bool = False


@dataclass
class _PushActivity:
    command: dict[str, Any]
    task: asyncio.Task[Event]
    cancellation_event: Event | None = None
    terminal_selected: bool = False


class ActivitySupervisor:
    """Supervise runtime work independently from reconnecting transport loops."""

    def __init__(
        self,
        *,
        send_event: EventSender,
        prompt_finished: Callable[[], None],
        refresh_diff: Callable[[str | None], None],
        log: StructuredLogger,
    ) -> None:
        self._send_event = send_event
        self._prompt_finished = prompt_finished
        self._refresh_diff = refresh_diff
        self._log = log
        self._current_prompt: _PromptActivity | None = None
        self._prompts: dict[asyncio.Task[Event], _PromptActivity] = {}
        self._push_lock = asyncio.Lock()
        self._pushes: dict[asyncio.Task[Event], _PushActivity] = {}
        self._deliveries: set[asyncio.Task[None]] = set()

    @property
    def current_prompt_task(self) -> asyncio.Task[Event] | None:
        return self._current_prompt.task if self._current_prompt is not None else None

    @property
    def push_tasks(self) -> tuple[asyncio.Task[Event], ...]:
        return tuple(self._pushes)

    def start_prompt(
        self, message_id: str, operation: Callable[[], Coroutine[Any, Any, Event]]
    ) -> None:
        task: asyncio.Task[Event] = asyncio.create_task(operation())
        self.track_prompt(message_id, task)

    def track_prompt(self, message_id: str, task: asyncio.Task[Event]) -> None:
        """Adopt the bridge's concrete vendor-prompt operation task."""
        activity = _PromptActivity(message_id=message_id, task=task)
        self._current_prompt = activity
        self._prompts[task] = activity
        task.add_done_callback(lambda completed: self._finish_prompt(activity, completed))

    def interrupt_prompt(self, error: str) -> None:
        self.set_prompt_interruption(error)
        activity = self._current_prompt
        if activity is not None and not activity.task.done():
            activity.task.cancel()

    def set_prompt_interruption(
        self, error: str, *, all_prompts: bool = False, overwrite: bool = False
    ) -> None:
        activities = tuple(self._prompts.values()) if all_prompts else (self._current_prompt,)
        for activity in activities:
            if activity is None or activity.terminal_selected:
                continue
            if activity.interruption_error is None or overwrite:
                activity.interruption_error = error

    def _cancel_prompts(self, *, all_prompts: bool) -> None:
        activities = tuple(self._prompts.values()) if all_prompts else (self._current_prompt,)
        for activity in activities:
            if activity is not None and not activity.task.done():
                activity.task.cancel()

    def _finish_prompt(self, activity: _PromptActivity, completed: asyncio.Task[Event]) -> None:
        self._prompt_finished()
        self._prompts.pop(completed, None)
        if self._current_prompt is activity:
            self._current_prompt = None
        if activity.terminal_selected:
            return
        if completed.cancelled():
            event: Event = {
                "type": "execution_complete",
                "messageId": activity.message_id,
                "success": False,
                "error": activity.interruption_error or "Task was cancelled",
            }
        elif error := completed.exception():
            event = {
                "type": "execution_complete",
                "messageId": activity.message_id,
                "success": False,
                "error": str(error),
            }
        else:
            event = completed.result()
        if activity.interruption_error is not None:
            event = {
                **event,
                "success": False,
                "error": activity.interruption_error,
            }
        activity.terminal_selected = True
        self._schedule_delivery(event, refresh_message_id=activity.message_id)

    def start_push(
        self,
        command: dict[str, Any],
        operation: Callable[[], Coroutine[Any, Any, Event]],
    ) -> None:
        async def locked_operation() -> Event:
            async with self._push_lock:
                return await operation()

        task = asyncio.create_task(locked_operation())
        activity = _PushActivity(command=command, task=task)
        self._pushes[task] = activity
        task.add_done_callback(lambda completed: self._finish_push(activity, completed))

    def _finish_push(self, activity: _PushActivity, completed: asyncio.Task[Event]) -> None:
        self._pushes.pop(completed, None)
        if activity.terminal_selected:
            return
        if completed.cancelled():
            event = activity.cancellation_event
            if event is None:
                return
        elif error := completed.exception():
            self._log.error("bridge.push_task_error", exc=error)
            event = activity.cancellation_event
            if event is None:
                return
        else:
            event = completed.result()
        activity.terminal_selected = True
        self._schedule_delivery(event)

    def _schedule_delivery(self, event: Event, *, refresh_message_id: str | None = None) -> None:
        async def deliver() -> None:
            await self._send_event(event)
            if refresh_message_id is not None:
                self._refresh_diff(refresh_message_id)

        task = asyncio.create_task(deliver())
        self._deliveries.add(task)

        def finish(completed: asyncio.Task[None]) -> None:
            self._deliveries.discard(completed)
            if not completed.cancelled() and (error := completed.exception()) is not None:
                self._log.error("bridge.activity_delivery_error", exc=error)

        task.add_done_callback(finish)

    async def drain_for_shutdown(
        self,
        *,
        deadline: float,
        prompt_error: str,
        push_cancellation_event: Callable[[dict[str, Any]], Event],
        stop_execution: Callable[[float], Awaitable[bool]],
    ) -> bool:
        self.set_prompt_interruption(prompt_error, all_prompts=True, overwrite=True)
        for activity in tuple(self._pushes.values()):
            if activity.terminal_selected:
                continue
            activity.cancellation_event = push_cancellation_event(activity.command)
            if not activity.task.done():
                activity.task.cancel()
        self._cancel_prompts(all_prompts=True)

        # Settle every admitted local starter before asking the vendor whether
        # it is idle. A prompt cancelled after the vendor check can otherwise
        # resume during cancellation cleanup and submit new vendor work after
        # containment was already reported successful.
        await self._join_operations(deadline)
        execution_stopped = await stop_execution(
            max(deadline - asyncio.get_running_loop().time(), 0.0)
        )
        await asyncio.sleep(0)
        await self._join_deliveries(deadline)
        return execution_stopped

    async def shutdown(self) -> None:
        self._cancel_prompts(all_prompts=True)
        for activity in tuple(self._pushes.values()):
            if not activity.task.done():
                activity.task.cancel()
        tasks = [
            *(activity.task for activity in self._pushes.values()),
            *self._prompts,
        ]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
            await asyncio.sleep(0)
        if self._deliveries:
            for task in self._deliveries:
                task.cancel()
            await asyncio.gather(*tuple(self._deliveries), return_exceptions=True)

    async def _join_operations(self, deadline: float) -> None:
        tasks = [
            *(activity.task for activity in self._pushes.values()),
            *self._prompts,
        ]
        if not tasks:
            return
        done, pending = await asyncio.wait(
            tasks,
            timeout=max(deadline - asyncio.get_running_loop().time(), 0.0),
        )
        for task in done:
            if not task.cancelled():
                task.exception()
        if pending:
            raise TimeoutError

    async def _join_deliveries(self, deadline: float) -> None:
        if not self._deliveries:
            return
        _done, pending = await asyncio.wait(
            tuple(self._deliveries),
            timeout=max(deadline - asyncio.get_running_loop().time(), 0.0),
        )
        if pending:
            raise TimeoutError

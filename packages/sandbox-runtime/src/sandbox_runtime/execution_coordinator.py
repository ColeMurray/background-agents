"""One owner for runtime admission, turn deadlines, Stop and terminal evidence.

The bridge supplies preparation and event transport; it cannot mutate execution
state. The phase is the sole admission fence, including while a terminal send or
an older interrupt request is still pending.
"""

from __future__ import annotations

import asyncio
import contextlib
import math
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING, Any

from .event_forwarder import SEND_TIMEOUT_SECONDS

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable, Coroutine

    from .harness.base import AgentHarness, HarnessPrompt, PromptLimits, TurnOutcome
    from .log_config import StructuredLogger

DEADLINE_CLOCK_ALLOWANCE_SECONDS = 1.0
GRACEFUL_STOP_MAX_SECONDS = 5.0
MAX_COMPLETED_PROMPTS = 256


class ExecutionPhase(StrEnum):
    IDLE = "idle"
    PREPARING = "preparing"
    RUNNING = "running"
    STOPPING = "stopping"
    QUARANTINED = "quarantined"


class PreparationFailed(RuntimeError):
    """A preparation dependency rejected work without leaving execution alive."""


@dataclass
class _Turn:
    message_id: str
    deadline_monotonic: float
    cleanup_deadline_monotonic: float
    epoch_offset_seconds: float
    stop_reason: str | None = None
    harness_started: bool = False
    execution_stopped: bool = True
    cleanup_started: bool = False
    interrupt_request_uncertain: bool = False
    observation_finished: asyncio.Event = field(default_factory=asyncio.Event)
    terminal_event: dict[str, Any] | None = None


def resolve_deadline(
    supplied_epoch_ms: object,
    *,
    fallback_seconds: float,
    now_monotonic: float,
    now_epoch_seconds: float,
) -> float:
    """Convert an absolute wire deadline once, without extending it on delivery."""
    if supplied_epoch_ms is None:
        return now_monotonic + fallback_seconds
    if (
        isinstance(supplied_epoch_ms, bool)
        or not isinstance(supplied_epoch_ms, (float, int))
        or not math.isfinite(supplied_epoch_ms)
    ):
        return now_monotonic
    remaining_seconds = (
        supplied_epoch_ms / 1000 - now_epoch_seconds - DEADLINE_CLOCK_ALLOWANCE_SECONDS
    )
    return now_monotonic + min(remaining_seconds, fallback_seconds)


class ExecutionCoordinator:
    """Serializes all work and owns the evidence required to reuse a runtime."""

    def __init__(
        self,
        *,
        sandbox_id: str,
        harness: Callable[[], AgentHarness],
        limits: Callable[[], PromptLimits],
        prepare: Callable[[dict[str, Any]], Awaitable[HarnessPrompt]],
        persist_session: Callable[[], Awaitable[None]],
        send_event: Callable[[dict[str, Any]], Coroutine[Any, Any, None]],
        on_started: Callable[[], None],
        on_reusable: Callable[[str], None],
        log: StructuredLogger,
    ) -> None:
        self._sandbox_id = sandbox_id
        self._harness = harness
        self._limits = limits
        self._prepare = prepare
        self._persist_session = persist_session
        self._send_event = send_event
        self._on_started = on_started
        self._on_reusable = on_reusable
        self._log = log
        self._phase = ExecutionPhase.IDLE
        self._turn: _Turn | None = None
        self._task: asyncio.Task[None] | None = None
        self._stop_task: asyncio.Task[None] | None = None
        self._completed: OrderedDict[str, dict[str, Any]] = OrderedDict()

    @property
    def phase(self) -> ExecutionPhase:
        return self._phase

    @property
    def prompt_task(self) -> asyncio.Task[None] | None:
        """The owned task; observation is exposed, assignment is not."""
        return self._task

    @property
    def quarantined(self) -> bool:
        return self._phase == ExecutionPhase.QUARANTINED

    def dispatch(self, command: dict[str, Any]) -> asyncio.Task[None] | None:
        """Admit one prompt or replay a terminal event; never overlap work."""
        message_id = command.get("messageId") or command.get("message_id", "unknown")
        if command.get("sandboxId", self._sandbox_id) != self._sandbox_id:
            self._log.warn("prompt.stale_sandbox", message_id=message_id)
            return None
        if message_id in self._completed:
            return asyncio.create_task(self._send_event(dict(self._completed[message_id])))
        if self._phase != ExecutionPhase.IDLE:
            self._log.warn("prompt.runtime_unavailable", message_id=message_id, phase=self._phase)
            return None
        turn = self._new_turn(command, message_id)
        self._turn = turn
        self._phase = ExecutionPhase.PREPARING
        self._on_started()
        self._task = asyncio.create_task(self._run(turn, command))
        self._task.add_done_callback(lambda task: self._task_done(turn, task))
        # Prompt execution survives transport reconnects; only replays are
        # returned to the transport's connection-scoped background-task set.
        return None

    async def execute(self, command: dict[str, Any]) -> None:
        """Dispatch and await completion, for callers without a receive loop."""
        replay = self.dispatch(command)
        if replay is not None:
            await replay
        elif self._task is not None:
            await self._task

    def _new_turn(self, command: dict[str, Any], message_id: str) -> _Turn:
        now_monotonic, now_epoch = asyncio.get_running_loop().time(), time.time()
        limits = self._limits()
        deadline = resolve_deadline(
            command.get("executionDeadlineMs"),
            fallback_seconds=limits.prompt_max_duration_seconds,
            now_monotonic=now_monotonic,
            now_epoch_seconds=now_epoch,
        )
        cleanup_deadline = resolve_deadline(
            command.get("cleanupDeadlineMs"),
            fallback_seconds=max(0.0, deadline - now_monotonic)
            + limits.prompt_cleanup_timeout_seconds,
            now_monotonic=now_monotonic,
            now_epoch_seconds=now_epoch,
        )
        self._log.info(
            "prompt.deadline_resolved",
            message_id=message_id,
            source="control_plane"
            if "executionDeadlineMs" in command
            else "legacy_derived_allowance",
            remaining_seconds=max(0.0, deadline - now_monotonic),
            cleanup_remaining_seconds=max(0.0, cleanup_deadline - now_monotonic),
        )
        return _Turn(message_id, deadline, cleanup_deadline, now_epoch - now_monotonic)

    def _begin_cleanup(self, turn: _Turn, reason: str) -> None:
        self._phase = ExecutionPhase.STOPPING
        turn.stop_reason = turn.stop_reason or reason
        turn.cleanup_started = True
        turn.cleanup_deadline_monotonic = min(
            turn.cleanup_deadline_monotonic,
            asyncio.get_running_loop().time() + self._limits().prompt_cleanup_timeout_seconds,
        )

    def request_stop(
        self, command: dict[str, Any] | None = None, *, deadline_monotonic: float | None = None
    ) -> None:
        """Record an idempotent, correlated Stop without blocking command intake."""
        command = command or {}
        turn = self._turn
        if turn is None or command.get("sandboxId", self._sandbox_id) != self._sandbox_id:
            return
        if command.get("messageId", turn.message_id) != turn.message_id:
            return
        if deadline_monotonic is not None:
            turn.cleanup_deadline_monotonic = min(
                turn.cleanup_deadline_monotonic, deadline_monotonic
            )
        if self._phase not in {ExecutionPhase.PREPARING, ExecutionPhase.RUNNING}:
            return
        self._begin_cleanup(turn, str(command.get("reason") or "Task was cancelled"))
        if command.get("cleanupDeadlineMs") is not None:
            turn.cleanup_deadline_monotonic = min(
                turn.cleanup_deadline_monotonic,
                resolve_deadline(
                    command["cleanupDeadlineMs"],
                    fallback_seconds=self._limits().prompt_cleanup_timeout_seconds,
                    now_monotonic=asyncio.get_running_loop().time(),
                    now_epoch_seconds=time.time(),
                ),
            )
        if self._task is not None and not self._task.done():
            self._stop_task = asyncio.create_task(self._request_graceful_stop(turn, self._task))

    async def _request_graceful_stop(self, turn: _Turn, task: asyncio.Task[None]) -> None:
        remaining = max(0.0, turn.cleanup_deadline_monotonic - asyncio.get_running_loop().time())
        grace_deadline = asyncio.get_running_loop().time() + min(
            GRACEFUL_STOP_MAX_SECONDS, remaining / 2
        )
        request_settled = True
        try:
            async with asyncio.timeout_at(grace_deadline):
                if turn.harness_started:
                    request_settled = False
                    accepted = await self._harness().abort()
                    request_settled = True
                    if accepted:
                        await turn.observation_finished.wait()
        except Exception as error:
            turn.interrupt_request_uncertain = not request_settled
            if request_settled:
                self._log.info("prompt.stop_observation_expired", message_id=turn.message_id)
            else:
                self._log.warn(
                    "prompt.interrupt_request_failed", message_id=turn.message_id, exc=error
                )
        finally:
            if not turn.observation_finished.is_set() and not task.done():
                task.cancel()

    async def _settle_observation(self, turn: _Turn, error: str | None) -> None:
        turn.observation_finished.set()
        if self._stop_task is not None and not self._stop_task.done():
            with contextlib.suppress(TimeoutError):
                async with asyncio.timeout_at(turn.cleanup_deadline_monotonic):
                    await asyncio.shield(self._stop_task)
        if turn.interrupt_request_uncertain:
            turn.execution_stopped = False
        if turn.execution_stopped:
            return
        self._begin_cleanup(turn, error or "Execution uncertain")
        if not turn.harness_started:
            return  # The harness cannot attest to preparation cancellation.
        try:
            async with asyncio.timeout_at(turn.cleanup_deadline_monotonic):
                stopped = await self._harness().stop(turn.cleanup_deadline_monotonic)
                turn.execution_stopped = stopped and not turn.interrupt_request_uncertain
        except (Exception, asyncio.CancelledError) as failure:
            self._log.warn("prompt.containment_failed", message_id=turn.message_id, exc=failure)
            turn.execution_stopped = False
        self._log.info(
            "prompt.containment_complete",
            message_id=turn.message_id,
            execution_stopped=turn.execution_stopped,
            reason=turn.stop_reason,
        )

    async def _run(self, turn: _Turn, command: dict[str, Any]) -> None:
        started = asyncio.get_running_loop().time()
        outcome = "success"
        error: str | None = None
        message_cost_usd: float | None = None
        emitted_output = False
        deadline = asyncio.timeout_at(turn.deadline_monotonic)

        async def emit(event: dict[str, Any]) -> None:
            nonlocal emitted_output, message_cost_usd
            if event.get("type") == "execution_complete":
                raise RuntimeError("harness must not emit execution_complete")
            if event.get("type") in {"token", "tool_call", "step_finish"}:
                emitted_output = True
            if event.get("type") == "step_finish" and "messageCostUsd" in event:
                message_cost_usd = event["messageCostUsd"]
            await self._send_event(event)

        self._log.info("prompt.start", message_id=turn.message_id, model=command.get("model"))
        try:
            if self.phase == ExecutionPhase.STOPPING:
                raise asyncio.CancelledError
            if turn.deadline_monotonic <= asyncio.get_running_loop().time():
                raise TimeoutError("Execution deadline reached; stopping execution.")
            async with deadline:
                turn.execution_stopped = False
                prompt = await self._prepare(command)
                if self._phase == ExecutionPhase.STOPPING:
                    # Stop during preparation cannot race into agent dispatch.
                    turn.execution_stopped = True
                    raise asyncio.CancelledError
                self._phase = ExecutionPhase.RUNNING
                turn.harness_started = True
                result: TurnOutcome = await self._harness().run_prompt(prompt, emit)
                turn.execution_stopped = result.execution_stopped
                if result.message_cost_usd is not None:
                    message_cost_usd = result.message_cost_usd
                await self._persist_session()
                error = result.error if not result.success else None
                if result.cancelled:
                    raise asyncio.CancelledError
            if error is None and not emitted_output:
                error = "The agent completed without emitting assistant output."
        except PreparationFailed as failure:
            turn.execution_stopped = True
            error = str(failure)
        except TimeoutError as failure:
            outcome = "timeout"
            error = (
                "Execution deadline reached; stopping execution."
                if deadline.expired()
                else str(failure) or "An upstream operation timed out."
            )
            self._begin_cleanup(turn, error)
        except asyncio.CancelledError:
            outcome = "cancelled"
            error = turn.stop_reason or "Task was cancelled"
            self._begin_cleanup(turn, error)
        except Exception as failure:
            error = str(failure)
            # A completed preparation failure dispatched no agent execution.
            # Cancellation and deadline expiry remain inconclusive above.
            turn.execution_stopped = turn.execution_stopped or not turn.harness_started
            self._log.error("prompt.error", message_id=turn.message_id, exc=failure)
        finally:
            await self._settle_observation(turn, error)
        error = turn.stop_reason or error
        self._log.info(
            "prompt.run",
            message_id=turn.message_id,
            model=command.get("model"),
            outcome=outcome if outcome != "success" else "error" if error else "success",
            duration_ms=int((asyncio.get_running_loop().time() - started) * 1000),
        )
        await self._finish(turn, error=error, message_cost_usd=message_cost_usd)

    async def _finish(
        self, turn: _Turn, *, error: str | None, message_cost_usd: float | None = None
    ) -> None:
        if turn.terminal_event is not None:
            return
        event = {
            "type": "execution_complete",
            "messageId": turn.message_id,
            "sandboxId": self._sandbox_id,
            "success": error is None,
            "executionStopped": turn.execution_stopped,
            **({"error": error} if error else {}),
            **({"messageCostUsd": message_cost_usd} if message_cost_usd is not None else {}),
            **(
                {
                    "cleanupDeadlineMs": int(
                        (turn.cleanup_deadline_monotonic + turn.epoch_offset_seconds) * 1000
                    )
                }
                if turn.cleanup_started
                else {}
            ),
        }
        turn.terminal_event = event
        self._completed[turn.message_id] = event
        while len(self._completed) > MAX_COMPLETED_PROMPTS:
            self._completed.popitem(last=False)
        try:
            with contextlib.suppress(TimeoutError):
                async with asyncio.timeout_at(
                    min(
                        turn.cleanup_deadline_monotonic,
                        asyncio.get_running_loop().time() + SEND_TIMEOUT_SECONDS,
                    )
                ):
                    await self._send_event(event)
        finally:
            self._phase = (
                ExecutionPhase.IDLE if turn.execution_stopped else ExecutionPhase.QUARANTINED
            )

    def _task_done(self, turn: _Turn, task: asyncio.Task[None]) -> None:
        failure = None if task.cancelled() else task.exception()
        if task is not self._task:
            return
        if turn.terminal_event is None:
            error = turn.stop_reason or "Task was cancelled"
            if failure is not None:
                error = str(failure)
            self._task = asyncio.create_task(self._finish(turn, error=error))
            self._task.add_done_callback(lambda completed: self._task_done(turn, completed))
            return
        self._task = None
        if self._phase == ExecutionPhase.IDLE:
            self._on_reusable(turn.message_id)

    def snapshot_deadline(self) -> float | None:
        """Permit snapshots only after cessation, without renewing cleanup."""
        if self._phase != ExecutionPhase.IDLE:
            return None
        deadline = asyncio.get_running_loop().time() + self._limits().prompt_cleanup_timeout_seconds
        if self._turn is not None and self._turn.cleanup_started:
            deadline = min(deadline, self._turn.cleanup_deadline_monotonic)
        return deadline

    async def shutdown(self, deadline_monotonic: float | None = None) -> float:
        """Stop admitted work and return the single remaining resource-close bound."""
        deadline = deadline_monotonic or (
            asyncio.get_running_loop().time() + self._limits().prompt_cleanup_timeout_seconds
        )
        if self._turn is not None:
            self._turn.cleanup_deadline_monotonic = min(
                self._turn.cleanup_deadline_monotonic, deadline
            )
        self.request_stop({"reason": "Sandbox shutdown requested"}, deadline_monotonic=deadline)
        if self._turn is not None and self._turn.cleanup_started:
            deadline = min(deadline, self._turn.cleanup_deadline_monotonic)
        if self._task is not None and not self._task.done():
            _, pending = await asyncio.wait(
                {self._task}, timeout=max(0.0, deadline - asyncio.get_running_loop().time())
            )
            if pending:
                self._phase = ExecutionPhase.QUARANTINED
                self._log.warn("bridge.shutdown_execution_uncertain")
        return deadline

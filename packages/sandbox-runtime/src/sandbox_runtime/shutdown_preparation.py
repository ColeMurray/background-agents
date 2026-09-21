"""Typed shutdown-preparation state machine and deadline owner."""

from __future__ import annotations

import asyncio
import math
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from .log_config import StructuredLogger

Generation = dict[str, Any]
Event = dict[str, Any]


@dataclass
class Open:
    generation: Generation | None


@dataclass
class Draining:
    generation: Generation
    operation_id: str


@dataclass
class Fenced:
    generation: Generation
    operation_id: str


type ShutdownPreparationState = Open | Draining | Fenced


@dataclass
class ShutdownPreparationCoordinator:
    """Own authenticated generation, fencing, replay, retry, and stop deadlines."""

    state: ShutdownPreparationState = field(default_factory=lambda: Open(generation=None))
    _results: dict[str, Event] = field(default_factory=dict)

    @property
    def fenced(self) -> bool:
        return not isinstance(self.state, Open)

    @property
    def generation(self) -> Generation | None:
        return self.state.generation

    def establish_generation(self, generation: Generation) -> Event:
        if generation != self.state.generation:
            self.state = Open(generation=generation)
            self._results.clear()
        return {"type": "sandbox_generation_ready", "generation": generation}

    async def prepare(
        self,
        command: dict[str, Any],
        *,
        parsed_generation: Generation,
        contain_activity: Callable[[float], Awaitable[bool]],
        persist_session: Callable[[], Awaitable[None]],
        log: StructuredLogger,
    ) -> Event | None:
        operation_id = command.get("operationId")
        message_id = command.get("messageId")
        stop_by_ms = command.get("stopByMs")
        if not isinstance(operation_id, str) or not operation_id:
            return None
        if cached := self._results.get(operation_id):
            return dict(cached)

        deadline_at_ms: float | None = None
        if not isinstance(stop_by_ms, bool) and isinstance(stop_by_ms, (int, float)):
            try:
                candidate_deadline = float(stop_by_ms)
            except OverflowError:
                pass
            else:
                if math.isfinite(candidate_deadline):
                    deadline_at_ms = candidate_deadline

        error: str | None = None
        if deadline_at_ms is None:
            error = "invalid_command"
        elif self.generation is None:
            error = "generation_not_established"
        elif parsed_generation != self.generation:
            error = "generation_mismatch"
        elif isinstance(self.state, Draining) and self.state.operation_id != operation_id:
            error = "preservation_in_progress"

        execution_stopped = False
        if error is None:
            assert deadline_at_ms is not None
            self.state = Draining(parsed_generation, operation_id)
            deadline = asyncio.get_running_loop().time() + max(
                (deadline_at_ms - time.time() * 1000) / 1000,
                0.0,
            )
            try:
                async with asyncio.timeout_at(deadline):
                    execution_stopped = await contain_activity(deadline)
                    if execution_stopped:
                        await persist_session()
            except TimeoutError:
                error = "stop_deadline_exceeded"
            except Exception as exc:
                log.warn("bridge.preservation_stop_error", exc=exc)
                error = "execution_stop_failed"
            finally:
                self.state = Fenced(parsed_generation, operation_id)
            if not execution_stopped and error is None:
                error = "execution_stop_unconfirmed"

        if error is not None:
            execution_stopped = False
        result: Event = {
            "type": "preservation_prepared",
            "operationId": operation_id,
            "generation": parsed_generation,
            "executionStopped": execution_stopped,
            **({"messageId": message_id} if isinstance(message_id, str) else {}),
            **({"error": error} if error is not None else {}),
        }
        self._results[operation_id] = result
        return dict(result)

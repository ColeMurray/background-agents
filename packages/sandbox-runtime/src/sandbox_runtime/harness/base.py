"""The harness seam: the contract between the sandbox runtime and an agent.

The seam has two halves with one owner each:

- ``HarnessProcessOwner`` is the supervisor half. It stages vendor config and
  owns any long-lived vendor server process (``opencode serve``), including
  its restart budget.
- ``AgentHarness`` is the bridge half. It runs prompts against the vendor and
  yields the runtime-neutral bridge events the control plane understands.

The bridge owns terminalisation: a harness never emits ``execution_complete``.
It yields events and returns a ``TurnOutcome``; the bridge emits exactly one
terminal event per prompt from that outcome.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

if TYPE_CHECKING:
    from pathlib import Path

    from ..attachment_processor import HydratedSessionAttachment
    from ..repo_config import RepoEntry


class HarnessId(StrEnum):
    """Harnesses this runtime can run. Only deployable implementations are listed."""

    OPENCODE = "opencode"
    CLAUDE = "claude"


DEFAULT_HARNESS_ID = HarnessId.OPENCODE


def parse_harness_id(value: object) -> HarnessId:
    """Resolve a wire/env harness value; absent means the built-in harness."""
    if value is None or value == "":
        return DEFAULT_HARNESS_ID
    try:
        return HarnessId(str(value))
    except ValueError as error:
        raise ValueError(f"Unsupported harness: {value!r}") from error


# Runtime-neutral bridge event dict (``token``, ``tool_call``, ``step_start``,
# ``step_finish``, ``context_compacted``, ``session_title``, ``error``,
# ``warning``). Never ``execution_complete``.
BridgeEvent = dict[str, Any]
EventSink = Callable[[BridgeEvent], Awaitable[None]]


@dataclass(frozen=True)
class PromptLimits:
    """Legacy turn-policy defaults, not the provider's remaining lifetime.

    Only OpenCode consumes the stream responsiveness setting. The bridge owns
    execution and cleanup deadlines and includes preparation in the turn budget.
    """

    inactivity_timeout_seconds: float
    prompt_max_duration_seconds: float
    prompt_cleanup_timeout_seconds: float


@dataclass(frozen=True)
class HarnessPrompt:
    """One prompt turn, in the control plane's vocabulary."""

    message_id: str
    text: str
    model: str | None = None
    reasoning_effort: str | None = None
    attachments: Sequence[HydratedSessionAttachment] = ()
    author: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class TurnOutcome:
    """What one ``run_prompt`` call produced, for the bridge to terminalise."""

    success: bool
    error: str | None = None
    cancelled: bool = False
    message_cost_usd: float | None = None
    # False on lost observation (EOF, transport failure, cancelled reader).
    # A request to interrupt is not evidence that active tools have stopped.
    execution_stopped: bool = True

    def __post_init__(self) -> None:
        if self.cancelled and self.success:
            raise ValueError("a cancelled turn cannot also be a success")
        if not self.success and not self.error:
            raise ValueError("a failed turn must carry an error message")

    @classmethod
    def ok(cls, *, message_cost_usd: float | None = None) -> TurnOutcome:
        return cls(success=True, message_cost_usd=message_cost_usd)

    @classmethod
    def failed(
        cls,
        error: str,
        *,
        message_cost_usd: float | None = None,
        execution_stopped: bool = True,
    ) -> TurnOutcome:
        return cls(
            success=False,
            error=error,
            message_cost_usd=message_cost_usd,
            execution_stopped=execution_stopped,
        )


class HarnessStartError(RuntimeError):
    """A harness could not open, and retrying without operator action is futile.

    The bridge exits with ``DETERMINISTIC_FAILURE_EXIT_CODE`` so the supervisor
    reports the cause instead of spending its restart budget.
    """


# Bridge exit code the supervisor treats as final (no restart).
DETERMINISTIC_FAILURE_EXIT_CODE = 78  # EX_CONFIG


@runtime_checkable
class AgentHarness(Protocol):
    """Bridge half of the seam: a per-session client for one agent vendor."""

    session_id: str | None
    """The vendor session id the harness owns: None until ``resume_session``
    succeeds or ``create_session`` runs. The bridge reads it; only the harness
    writes it."""

    @property
    def id(self) -> HarnessId: ...

    async def open(self) -> None:
        """Connect to the vendor. Raises ``HarnessStartError`` on a final failure."""
        ...

    async def close(self) -> None:
        """Tear down; must reap any child process the harness spawned."""
        ...

    async def resume_session(self, persisted_id: str) -> bool:
        """Adopt ``persisted_id`` when the vendor still has it; ``False`` leaves ``session_id`` unset."""
        ...

    async def create_session(self) -> None:
        """Create a fresh vendor session and set ``session_id``. The bridge calls this lazily."""
        ...

    async def run_prompt(self, prompt: HarnessPrompt, emit: EventSink) -> TurnOutcome:
        """Run one turn, delivering bridge events through ``emit``.

        Never emits ``execution_complete``. ``asyncio.CancelledError`` propagates
        so the bridge can settle the turn as cancelled.
        """
        ...

    async def abort(self) -> bool:
        """Best-effort stop of the in-flight turn; ``True`` when a stop was requested."""
        ...

    async def stop(self, deadline_monotonic: float) -> bool:
        """Contain active execution within one bridge-owned cleanup deadline.

        Return True only with evidence that the turn and its outstanding tools
        have ceased. An interrupt acknowledgement, reader cancellation, parent
        process exit, or disconnect alone is insufficient. False quarantines the
        runtime for provider termination; it must never receive another prompt.
        """
        ...


@runtime_checkable
class HarnessProcessOwner(Protocol):
    """Supervisor half of the seam: staging plus any resident vendor process."""

    async def start(self, repositories: Sequence[RepoEntry], workdir: Path) -> None: ...

    async def stop(self) -> None: ...

    def exit_code(self) -> int | None:
        """Exit code of the vendor process, or ``None`` while it runs or when there is none."""
        ...

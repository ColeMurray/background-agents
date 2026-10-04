"""Boot-event delivery and the transition from transport-only to a ready harness.

Legacy bridges already have a harness when constructed. They still relay boot
warnings, but skip phase reporting, deferred attach, and boot-time command gates.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .boot_event_relay import BootEventRelay
from .constants import BOOT_EVENTS_FILE_PATH
from .git_signing import GitSigningError
from .harness import HarnessStartError
from .push_operation import PushRejected, PushRequest

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from .event_forwarder import BufferedEventForwarder
    from .git_signing import GitSigningRuntime
    from .harness import AgentHarness

RECONNECT_BACKOFF_BASE = 2.0
RECONNECT_MAX_DELAY_SECONDS = 60.0
BOOT_EVENTS_POLL_SECONDS = 0.25


class BootAttach:
    """Own harness attachment and boot state independently of the socket lifecycle."""

    def __init__(
        self,
        *,
        early_connect: bool,
        harness: AgentHarness | None,
        harness_factory: Callable[[], AgentHarness],
        git_signing: GitSigningRuntime,
        event_forwarder: BufferedEventForwarder,
        shutdown_event: asyncio.Event,
        log: Any,
        load_session_id: Callable[[AgentHarness], Awaitable[None]],
        build_ready_event: Callable[[], dict[str, Any]],
        send_event: Callable[[dict[str, Any]], Awaitable[bool]],
        end_run: Callable[[], Awaitable[None]],
        record_fatal_error: Callable[[str], None],
    ) -> None:
        self.early_connect = early_connect
        self._harness_factory = harness_factory
        # Building a harness may read supervisor-written handoffs or probe the
        # vendor server, so early mode must defer even construction until attach.
        self.harness = (
            None if early_connect else (harness if harness is not None else harness_factory())
        )
        self.git_signing = git_signing
        self.event_forwarder = event_forwarder
        self.shutdown_event = shutdown_event
        self.log = log
        self._load_session_id = load_session_id
        self._build_ready_event = build_ready_event
        self._send_event = send_event
        self._end_run = end_run
        self._record_fatal_error = record_fatal_error
        self._boot_ready = asyncio.Event()
        if not early_connect:
            self._boot_ready.set()
        self.boot_relay = BootEventRelay(Path(BOOT_EVENTS_FILE_PATH), log)
        self._boot_relay_task: asyncio.Task[None] | None = None
        self._held_boot_lines: list[dict[str, Any]] = []
        self._signing_initialized = False
        self.failure: BaseException | None = None
        self.outcome: str | None = None

    @property
    def booting(self) -> bool:
        return not self._boot_ready.is_set()

    async def start(self) -> None:
        """Open legacy harnesses before transport; early harnesses attach in the relay."""
        if not self.early_connect:
            assert self.harness is not None
            await self._open_harness(self.harness)
            await self._load_session_id(self.harness)
        self._boot_relay_task = asyncio.create_task(self._relay_boot_events())

    async def before_connect(self) -> None:
        """Keep legacy signing initialization inside the transport retry loop."""
        if not self.early_connect and not self._signing_initialized:
            await self.git_signing.initialize(None)
            self._signing_initialized = True

    async def on_connect(self) -> None:
        """Resend readiness or the latest phase once per connection."""
        if self.booting:
            # Never buffer phases: older phases would be stale on reconnect.
            await self.event_forwarder.send(self.boot_relay.latest_phase_event(), buffered=False)
        else:
            await self._send_event(self._build_ready_event())

    async def stop(self) -> None:
        """Stop attach work before the bridge cancels prompts and closes the harness."""
        if self._boot_relay_task is not None and not self._boot_relay_task.done():
            self._boot_relay_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._boot_relay_task

    async def wait_until_ready(self, message_id: str, deadline: float) -> None:
        """Wait inside the prompt's existing deadline, without granting a new budget."""
        if self.booting:
            self.log.info(
                "prompt.held_until_ready",
                message_id=message_id,
                timeout_s=max(deadline - asyncio.get_running_loop().time(), 0.0),
            )
            await self._boot_ready.wait()

    async def handle_command(self, cmd: dict[str, Any]) -> bool:
        """Consume commands that cannot run while booting; let the bridge route the rest."""
        if not self.booting:
            return False
        cmd_type = cmd.get("type")
        if cmd_type not in ("snapshot", "refresh_diff", "push"):
            return False
        # A half-booted filesystem is not a snapshot. Neither snapshot nor diff
        # refresh has a failure reply shape, so both are dropped.
        self.log.warn("bridge.command_refused_while_booting", cmd_type=cmd_type)
        if cmd_type == "push":
            # Parse only for correlation fields so the pending push can settle.
            try:
                request: PushRequest | None = PushRequest.from_push_spec(cmd.get("pushSpec"))
            except PushRejected as rejected:
                request = rejected.request
            await self._send_event(
                {
                    "type": "push_error",
                    "error": "Push failed - the sandbox is still booting",
                    "branchName": request.branch_name if request is not None else "",
                    **(request.repo_fields() if request is not None else {}),
                    "timestamp": time.time(),
                }
            )
        return True

    async def end_run(self, outcome: str) -> None:
        self.outcome = outcome
        await self._end_run()

    async def _relay_boot_events(self) -> None:
        """Tail boot events until harness completion, then hand off held warnings."""
        try:
            while not self.shutdown_event.is_set():
                await self._relay_boot_events_once()
                if self.boot_relay.harness_completed:
                    await self._buffer_held_boot_events()
                    return
                await asyncio.sleep(BOOT_EVENTS_POLL_SECONDS)
        except asyncio.CancelledError:
            raise
        except HarnessStartError as error:
            self.failure = error
            await self.end_run("harness_start_failed")
        except GitSigningError as error:
            if self.shutdown_event.is_set():
                await self.end_run("shutdown")
                return
            self.log.error("bridge.signing_init_failed", exc=error)
            self._record_fatal_error(str(error))
            self.failure = error
            await self.end_run("fatal_error")
        except Exception as error:
            self.log.error("bridge.harness_attach_failed", exc=error)
            self.failure = error
            await self.end_run("harness_attach_failed")

    async def _relay_boot_events_once(self) -> None:
        """Retry held warnings first, advancing the cursor only past delivered lines.

        Phases are never replayed from the file: reconnect sends the latest one.
        Warnings are at-least-once across bridge restarts; the durable cursor
        must never pass an undelivered warning.
        """
        lines = self._held_boot_lines + self.boot_relay.read_new_lines()
        self._held_boot_lines = []
        relayed_through: int | None = None
        for line in lines:
            event = BootEventRelay.to_event(line)
            if event is not None:
                if event["type"] == "warning":
                    if not await self.event_forwarder.send(event, buffered=False):
                        self._held_boot_lines.append(line)
                elif self.booting:
                    await self.event_forwarder.send(event, buffered=False)
            if not self._held_boot_lines:
                relayed_through = line["seq"]
        if relayed_through is not None:
            self.boot_relay.mark_relayed(relayed_through)
        if self.booting and self.boot_relay.harness_completed and self.harness is None:
            await self._attach_harness()

    async def _buffer_held_boot_events(self) -> None:
        """The relay stops at attach; its buffer handoff leaves the cursor behind."""
        held, self._held_boot_lines = self._held_boot_lines, []
        for line in held:
            event = BootEventRelay.to_event(line)
            if event is not None:
                await self._send_event(event)

    async def _attach_harness(self) -> None:
        """Build, open, resume and initialize signing before announcing readiness."""
        harness = self._harness_factory()
        await self._open_harness(harness)
        try:
            await self._load_session_id(harness)
            await self._initialize_signing_for_attach()
        except BaseException:
            # The harness has not been published, so bridge cleanup cannot see it.
            with contextlib.suppress(Exception):
                await harness.close()
            raise
        self.harness = harness
        await self._send_event(self._build_ready_event())
        self._boot_ready.set()
        self.log.info("bridge.harness_attached", harness=harness.id.value)

    async def _open_harness(self, harness: AgentHarness) -> None:
        try:
            await harness.open()
        except HarnessStartError as error:
            self._record_fatal_error(str(error))
            self.log.error("bridge.harness_open_failed", exc=error, harness=harness.id.value)
            raise

    async def _initialize_signing_for_attach(self) -> None:
        """Use the transport's retry policy without delaying the early connection."""
        attempt = 0
        while True:
            try:
                await self.git_signing.initialize(None)
                return
            except GitSigningError as error:
                if not error.retryable:
                    raise
                attempt += 1
                delay = min(RECONNECT_BACKOFF_BASE**attempt, RECONNECT_MAX_DELAY_SECONDS)
                self.log.warn("bridge.signing_init_retry", attempt=attempt, delay_s=delay)
                await asyncio.sleep(delay)

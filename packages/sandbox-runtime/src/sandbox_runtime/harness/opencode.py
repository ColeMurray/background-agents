"""``AgentHarness`` over the bundled local OpenCode server."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from .base import (
    EventSink,
    HarnessId,
    HarnessPrompt,
    HarnessStartError,
    PromptLimits,
    TurnOutcome,
)
from .opencode_stream import OpenCodePromptStream

if TYPE_CHECKING:
    from ..attachment_processor import AttachmentProcessor
    from ..log_config import StructuredLogger
    from .opencode_client import OpenCodeClient

# The server outlives a bridge process, so a resumed session may still be
# executing what an earlier one dispatched. Each stop attempt waits this long;
# attempts repeat until the budget is spent.
INHERITED_EXECUTION_STOP_ATTEMPT_SECONDS = 15.0
INHERITED_EXECUTION_STOP_BUDGET_SECONDS = 120.0
# An attempt that fails at once (the abort request itself failed) is not
# repeated at once.
INHERITED_EXECUTION_STOP_RETRY_DELAY_SECONDS = 1.0


class OpencodeHarness:
    """OpenCode behind the seam: HTTP/SSE transport plus the SSE translator.

    The supervisor owns ``opencode serve`` (``OpenCodeServer``); this half only
    speaks to it. ``open()`` is a no-op because the supervisor's health gate
    runs before the bridge exists and a failed probe here would only turn a
    prompt-time error into a bridge crash.
    """

    id = HarnessId.OPENCODE
    # ``resume_session`` stops what the server still runs for an earlier bridge
    # and waits for its idle confirmation before the session is adopted.
    contains_inherited_execution = True

    def __init__(
        self,
        *,
        client: OpenCodeClient,
        attachment_processor: AttachmentProcessor,
        log: StructuredLogger,
        limits: PromptLimits,
    ) -> None:
        self.client = client
        self.attachment_processor = attachment_processor
        self.log = log
        # Read when the prompt stream is first built, so a caller can still
        # adjust budgets between construction and the first prompt.
        self.limits = limits
        self.session_id: str | None = None
        self._prompt_stream: OpenCodePromptStream | None = None

    @property
    def prompt_stream(self) -> OpenCodePromptStream:
        """The long-lived SSE translator, created on first use."""
        if self._prompt_stream is None:
            self._prompt_stream = OpenCodePromptStream(
                client=self.client,
                attachment_processor=self.attachment_processor,
                log=self.log,
                sse_inactivity_timeout_seconds=self.limits.inactivity_timeout_seconds,
                prompt_max_duration_seconds=self.limits.prompt_max_duration_seconds,
                prompt_cleanup_timeout_seconds=self.limits.prompt_cleanup_timeout_seconds,
            )
        return self._prompt_stream

    async def open(self) -> None:
        return None

    async def close(self) -> None:
        await self.client.aclose()

    async def resume_session(self, persisted_id: str) -> bool:
        # Only a confirmed 404 means the session is gone. Any other probe
        # result must fail the resume, so inherited work is stopped before
        # ``ready`` and a failed lookup cannot be treated as a fresh session.
        try:
            exists = await self.client.session_exists(persisted_id)
        except HarnessStartError:
            raise
        except Exception as error:
            raise HarnessStartError(
                f"OpenCode session {persisted_id} could not be checked before resume: {error}"
            ) from error
        if not exists:
            self.log.info("opencode.session.invalid", opencode_session_id=persisted_id)
            return False
        self.session_id = persisted_id
        await self._stop_inherited_execution()
        self.log.info(
            "opencode.session.ensure",
            opencode_session_id=persisted_id,
            action="loaded",
        )
        return True

    async def _stop_inherited_execution(self) -> None:
        """Stop whatever the server still runs for an earlier bridge process.

        Nothing in this process owns that work. A restarted bridge would
        otherwise report no owner in ``ready`` and the control plane would
        dispatch the next prompt into the same execution. A server mid-tool-call
        may need a moment to honour the abort, so attempts repeat within the
        budget; a confirmation that never comes refuses the resume.
        """
        loop = asyncio.get_running_loop()
        started = loop.time()
        attempts = 0
        while True:
            attempts += 1
            stopped = await self.stop_execution(INHERITED_EXECUTION_STOP_ATTEMPT_SECONDS)
            elapsed = loop.time() - started
            (self.log.info if stopped else self.log.warn)(
                "opencode.session.inherited_execution_stop",
                opencode_session_id=self.session_id,
                outcome="stopped" if stopped else "busy",
                attempts=attempts,
                duration_ms=int(elapsed * 1000),
            )
            if stopped:
                return
            if elapsed >= INHERITED_EXECUTION_STOP_BUDGET_SECONDS:
                raise HarnessStartError(
                    f"resumed session {self.session_id} did not become idle within "
                    f"{INHERITED_EXECUTION_STOP_BUDGET_SECONDS:g}s"
                )
            await asyncio.sleep(
                min(
                    INHERITED_EXECUTION_STOP_RETRY_DELAY_SECONDS,
                    INHERITED_EXECUTION_STOP_BUDGET_SECONDS - elapsed,
                )
            )

    async def create_session(self) -> None:
        created = await self.client.create_session()
        if not created:
            raise RuntimeError("OpenCode did not return a session id")
        self.session_id = created
        self.log.info("opencode.session.ensure", opencode_session_id=created, action="created")

    def stream_events(self, prompt: HarnessPrompt) -> Any:
        """The raw translated event stream for one prompt (test seam)."""
        if not self.session_id:
            raise RuntimeError("OpenCode session not initialized")
        return self.prompt_stream.stream_prompt(
            opencode_session_id=self.session_id,
            message_id=prompt.message_id,
            content=prompt.text,
            model=prompt.model,
            reasoning_effort=prompt.reasoning_effort,
            attachments=list(prompt.attachments),
            max_duration_seconds=prompt.max_duration_seconds,
        )

    async def run_prompt(self, prompt: HarnessPrompt, emit: EventSink) -> TurnOutcome:
        error_message: str | None = None
        message_cost_usd: float | None = None
        try:
            async for event in self.stream_events(prompt):
                if event.get("type") == "error":
                    error_message = str(event.get("error") or "Unknown error")
                if event.get("type") == "step_finish" and "messageCostUsd" in event:
                    message_cost_usd = event["messageCostUsd"]
                await emit(event)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self.log.error("harness.prompt_error", exc=error, message_id=prompt.message_id)
            return TurnOutcome.failed(str(error), message_cost_usd=message_cost_usd)
        if error_message is not None:
            return TurnOutcome.failed(error_message, message_cost_usd=message_cost_usd)
        return TurnOutcome.ok(message_cost_usd=message_cost_usd)

    async def abort(self) -> bool:
        if not self.session_id:
            return False
        return await self.client.request_stop(self.session_id, reason="command")

    async def stop_execution(self, timeout_seconds: float) -> bool:
        """Abort, then require the server's independent idle observation."""
        deadline = asyncio.get_running_loop().time() + max(timeout_seconds, 0.0)
        try:
            async with asyncio.timeout_at(deadline):
                await self.client.request_stop(self.session_id, reason="preservation")
                return await self.client.wait_until_idle(
                    timeout_seconds=max(deadline - asyncio.get_running_loop().time(), 0.0),
                )
        except TimeoutError:
            return False

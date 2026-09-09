"""``AgentHarness`` over the bundled local OpenCode server."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from .base import (
    EventSink,
    HarnessCapabilities,
    HarnessId,
    HarnessPrompt,
    PromptLimits,
    TurnOutcome,
)
from .opencode_stream import OpenCodePromptStream

if TYPE_CHECKING:
    from ..attachment_processor import AttachmentProcessor
    from ..log_config import StructuredLogger
    from .opencode_client import OpenCodeClient

OPENCODE_CAPABILITIES = HarnessCapabilities(
    model_families=None,
    provider_auth={
        "anthropic": ("api_key",),
        "openai": ("api_key", "provider_account"),
        "xai": ("api_key", "provider_account"),
    },
    # OpenCode does not stream thinking text to the timeline.
    reasoning_display=False,
)


class OpencodeHarness:
    """OpenCode behind the seam: HTTP/SSE transport plus the SSE translator.

    The supervisor owns ``opencode serve`` (``OpenCodeServer``); this half only
    speaks to it. ``open()`` is a no-op because the supervisor's health gate
    runs before the bridge exists and a failed probe here would only turn a
    prompt-time error into a bridge crash.
    """

    id = HarnessId.OPENCODE
    capabilities = OPENCODE_CAPABILITIES

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

    async def create_or_resume_session(self, persisted_id: str | None) -> str:
        if persisted_id:
            try:
                exists = await self.client.session_exists(persisted_id)
            except Exception:
                exists = False
            if exists:
                self.session_id = persisted_id
                self.log.info(
                    "opencode.session.ensure",
                    opencode_session_id=persisted_id,
                    action="loaded",
                )
                return persisted_id
            self.log.info("opencode.session.invalid", opencode_session_id=persisted_id)

        created = await self.client.create_session()
        if not created:
            raise RuntimeError("OpenCode did not return a session id")
        self.session_id = created
        self.log.info("opencode.session.ensure", opencode_session_id=created, action="created")
        return created

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

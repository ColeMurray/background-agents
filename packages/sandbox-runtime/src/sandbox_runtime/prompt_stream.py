"""OpenCode prompt streaming: translates OpenCode SSE events to bridge events."""

from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING, Any, Final

from .opencode_client import (
    SSEConnectionError,
    SSEInactivityTimeoutError,
    SSEStreamDisconnectedError,
)
from .opencode_identifier import OpenCodeIdentifier

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from .attachment_processor import AttachmentProcessor, HydratedSessionAttachment
    from .log_config import StructuredLogger
    from .opencode_client import OpenCodeClient

# Cap on parts buffered for assistant messages that have not been authorized
# yet (their message.updated may arrive after their first parts).
MAX_PENDING_PART_EVENTS: Final = 2000
CONTEXT_OVERFLOW_ERROR_NAME: Final = "ContextOverflowError"

# Anthropic extended thinking budget tokens by reasoning effort level.
# "max" uses 31,999 — the API maximum for streaming responses.
# "high" uses 16,000 — a balanced level for faster responses with good reasoning.
ANTHROPIC_THINKING_BUDGETS: Final[dict[str, int]] = {
    "high": 16_000,
    "max": 31_999,
}
ANTHROPIC_ADAPTIVE_THINKING_MODELS: Final[frozenset[str]] = frozenset(
    {
        "claude-fable-5",
        "claude-opus-4-6",
        "claude-opus-4-7",
        "claude-opus-4-8",
        "claude-sonnet-4-6",
    }
)
ANTHROPIC_ADAPTIVE_EFFORTS: Final[frozenset[str]] = frozenset(
    {"low", "medium", "high", "xhigh", "max"}
)

OPENCODE_DEFAULT_TITLE_RE: Final = re.compile(
    r"^(new session|child session) - " r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class _PendingPart:
    """A part event held back until its assistant message is authorized."""

    part: dict[str, Any]
    delta: Any


@dataclass
class _PromptState:
    """Mutable translation state for one ``stream_prompt`` call."""

    opencode_session_id: str
    message_id: str
    opencode_message_id: str
    start_time: float
    cumulative_text: dict[str, str] = field(default_factory=dict)
    emitted_tool_states: set[str] = field(default_factory=set)
    allowed_assistant_msg_ids: set[str] = field(default_factory=set)
    user_message_ids: set[str] = field(default_factory=set)
    pending_parts: dict[str, list[_PendingPart]] = field(default_factory=dict)
    pending_parts_total: int = 0
    pending_drop_logged: bool = False
    # Child session tracking (sub-tasks)
    tracked_child_session_ids: set[str] = field(default_factory=set)
    # Compaction tracking: after compaction, parentID changes so we must
    # accept all non-summary assistant messages from the parent session
    compaction_occurred: bool = False
    emitted_error_messages: set[str] = field(default_factory=set)


class _Disposition(Enum):
    """What the stream loop should do after applying one SSE event."""

    CONTINUE = "continue"
    # Parent session went idle: emit the final message state, then finish.
    FINISHED_IDLE = "finished_idle"
    # Parent session errored: the error event was emitted, finish immediately.
    FAILED = "failed"


@dataclass(frozen=True)
class _StreamStep:
    """Bridge events produced by one SSE event, plus the loop disposition."""

    events: list[dict[str, Any]]
    disposition: _Disposition


class OpenCodePromptStream:
    """Streams one prompt through OpenCode and translates its SSE events.

    Uses messageID-based correlation for reliable event attribution:
    1. Generate an OpenCode-compatible ascending ID for the user message
    2. OpenCode creates assistant messages with parentID = our ascending ID
    3. Filter events to only process parts from our assistant messages
    4. Use the control plane's message_id for events sent back
    5. Track child sessions (sub-tasks) and forward their non-text events
       with isSubtask=True

    The instance is long-lived (one per bridge); the OpenCode session ID is a
    per-call parameter because the bridge can recreate its OpenCode session.
    """

    def __init__(
        self,
        *,
        client: OpenCodeClient,
        attachment_processor: AttachmentProcessor,
        log: StructuredLogger,
        sse_inactivity_timeout_seconds: float,
        prompt_max_duration_seconds: float,
    ) -> None:
        self._client = client
        self._attachment_processor = attachment_processor
        self._log = log
        self._sse_inactivity_timeout_seconds = sse_inactivity_timeout_seconds
        self._prompt_max_duration_seconds = prompt_max_duration_seconds
        # Session title dedupe survives across prompts so an unchanged title
        # is forwarded to the control plane at most once.
        self._last_forwarded_session_title: str | None = None

    async def stream_prompt(
        self,
        *,
        opencode_session_id: str,
        message_id: str,
        content: str,
        model: str | None = None,
        reasoning_effort: str | None = None,
        attachments: list[HydratedSessionAttachment] | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Stream response from OpenCode using Server-Sent Events.

        The ascending ID ensures our user message ID is lexicographically
        greater than any previous assistant message IDs, preventing the early
        exit condition in OpenCode's prompt loop (lastUser.id < lastAssistant.id).
        """
        opencode_message_id = OpenCodeIdentifier.ascending("message")
        request_body = self._build_prompt_request_body(
            content, model, opencode_message_id, reasoning_effort, attachments
        )

        state = _PromptState(
            opencode_session_id=opencode_session_id,
            message_id=message_id,
            opencode_message_id=opencode_message_id,
            start_time=time.time(),
        )
        state.user_message_ids.add(opencode_message_id)
        loop = asyncio.get_running_loop()

        try:
            async with self._client.events(
                inactivity_timeout_seconds=self._sse_inactivity_timeout_seconds
            ) as sse_events:
                prompt_start = loop.time()
                await self._client.post_prompt(opencode_session_id, request_body)

                async for sse_event in sse_events:
                    step = self._apply_sse_event(state, sse_event)
                    for event in step.events:
                        yield event

                    if step.disposition is _Disposition.FINISHED_IDLE:
                        async for final_event in self._fetch_final_message_state(state):
                            yield final_event
                        return
                    if step.disposition is _Disposition.FAILED:
                        return

                    if loop.time() > prompt_start + self._prompt_max_duration_seconds:
                        elapsed = time.time() - state.start_time
                        self._log.error(
                            "bridge.prompt_max_duration_timeout",
                            timeout_ms=int(self._prompt_max_duration_seconds * 1000),
                            elapsed_ms=int(elapsed * 1000),
                            message_id=message_id,
                        )
                        await self._client.request_stop(
                            opencode_session_id, reason="prompt_max_duration_timeout"
                        )
                        async for final_event in self._fetch_final_message_state(state):
                            yield final_event
                        raise RuntimeError(
                            f"Prompt exceeded max duration of "
                            f"{self._prompt_max_duration_seconds:.0f}s."
                        )

        except SSEInactivityTimeoutError:
            elapsed = time.time() - state.start_time
            self._log.error(
                "bridge.sse_inactivity_timeout",
                timeout_name="sse_inactivity",
                timeout_ms=int(self._sse_inactivity_timeout_seconds * 1000),
                elapsed_ms=int(elapsed * 1000),
                operation="bridge.sse",
                message_id=message_id,
            )
            await self._client.request_stop(opencode_session_id, reason="inactivity_timeout")
            async for final_event in self._fetch_final_message_state(state):
                yield final_event
            raise RuntimeError(
                f"SSE stream inactive for {self._sse_inactivity_timeout_seconds:.0f}s "
                f"(no data received). Total elapsed: {elapsed:.0f}s"
            )

        except SSEStreamDisconnectedError as e:
            async for final_event in self._fetch_final_message_state(state):
                yield final_event
            raise SSEConnectionError(
                "OpenCode event stream disconnected before completion; "
                "partial output was preserved when available."
            ) from e

    def _apply_sse_event(self, state: _PromptState, sse_event: dict[str, Any]) -> _StreamStep:
        """Translate one OpenCode SSE event into bridge events, mutating state."""
        event_type = sse_event.get("type")
        props = sse_event.get("properties", {})
        if not isinstance(props, dict):
            props = {}

        if event_type in ("server.connected", "server.heartbeat"):
            return _StreamStep(events=[], disposition=_Disposition.CONTINUE)

        if event_type == "session.created":
            # Track direct child sessions before filtering. Nothing downstream
            # processes session.created, so it never falls through.
            self._track_child_session(state, props)
            return _StreamStep(events=[], disposition=_Disposition.CONTINUE)

        events: list[dict[str, Any]] = []
        title_event = self._session_title_event_from_sse(state, event_type, props)
        if title_event:
            events.append(title_event)
        if event_type == "session.updated":
            return _StreamStep(events=events, disposition=_Disposition.CONTINUE)

        event_session_id = props.get("sessionID") or props.get("part", {}).get("sessionID")
        is_child = event_session_id in state.tracked_child_session_ids
        if event_session_id and event_session_id != state.opencode_session_id and not is_child:
            return _StreamStep(events=events, disposition=_Disposition.CONTINUE)

        if event_type == "message.updated":
            events.extend(self._on_message_updated(state, props))

        elif event_type == "message.part.updated":
            events.extend(self._on_part_updated(state, props))

        elif event_type == "session.idle":
            # Only parent idle terminates the stream
            if props.get("sessionID") == state.opencode_session_id:
                self._log_parent_idle(state, "bridge.session_idle")
                return _StreamStep(events=events, disposition=_Disposition.FINISHED_IDLE)

        elif event_type == "session.status":
            status = props.get("status", {})
            # Only parent status=idle terminates the stream
            if props.get("sessionID") == state.opencode_session_id and status.get("type") == "idle":
                self._log_parent_idle(state, "bridge.session_status_idle")
                return _StreamStep(events=events, disposition=_Disposition.FINISHED_IDLE)

        elif event_type == "session.error":
            return self._on_session_error(state, props)

        elif event_type == "session.compacted":
            if props.get("sessionID") == state.opencode_session_id:
                state.compaction_occurred = True
                self._log.info("bridge.session_compacted", message_id=state.message_id)

        return _StreamStep(events=events, disposition=_Disposition.CONTINUE)

    def _track_child_session(self, state: _PromptState, props: dict[str, Any]) -> None:
        info = props.get("info", {})
        child_id = info.get("id")
        child_parent = info.get("parentID")
        if child_id and child_parent == state.opencode_session_id:
            state.tracked_child_session_ids.add(child_id)
            self._log.info(
                "bridge.child_session_detected",
                child_session_id=child_id,
                source="session.created",
            )

    def _on_message_updated(
        self, state: _PromptState, props: dict[str, Any]
    ) -> list[dict[str, Any]]:
        """Authorize assistant messages and drain any parts buffered for them."""
        info = props.get("info", {})
        msg_session_id = info.get("sessionID")

        if msg_session_id == state.opencode_session_id:
            oc_msg_id = info.get("id", "")
            parent_id = info.get("parentID", "")
            role = info.get("role", "")
            finish = info.get("finish", "")

            if role == "user" and oc_msg_id:
                if oc_msg_id not in state.user_message_ids:
                    self._log.info(
                        "bridge.user_message_id_discovered",
                        expected_id=state.opencode_message_id,
                        actual_id=oc_msg_id,
                    )
                state.user_message_ids.add(oc_msg_id)

            parent_matches = parent_id in state.user_message_ids
            is_compaction_summary = info.get("summary") is True

            self._log.debug(
                "bridge.message_updated",
                role=role,
                oc_msg_id=oc_msg_id,
                parent_match=parent_matches,
                compaction_occurred=state.compaction_occurred,
                is_compaction_summary=is_compaction_summary,
            )

            events: list[dict[str, Any]] = []
            if role == "assistant" and oc_msg_id:
                belongs_to_prompt = (
                    parent_matches
                    or is_compaction_summary
                    or (state.compaction_occurred and not is_compaction_summary)
                )
                if belongs_to_prompt and info.get("error"):
                    error_event = self._parent_error_event_once(state, info["error"])
                    if error_event:
                        self._log.error(
                            "bridge.message_error",
                            error_msg=error_event["error"],
                            oc_msg_id=oc_msg_id,
                        )
                        events.append(error_event)

                # Accept if: parentID matches our message, OR compaction
                # happened and this isn't the compaction summary itself
                if parent_matches or (state.compaction_occurred and not is_compaction_summary):
                    state.allowed_assistant_msg_ids.add(oc_msg_id)
                    events.extend(self._drain_pending_parts(state, oc_msg_id, is_subtask=False))

            if finish and finish not in ("tool-calls", ""):
                self._log.debug(
                    "bridge.message_finished",
                    finish=finish,
                )
            return events

        if msg_session_id in state.tracked_child_session_ids:
            # Child session: authorize all assistant messages
            oc_msg_id = info.get("id", "")
            role = info.get("role", "")
            if role == "assistant" and oc_msg_id:
                state.allowed_assistant_msg_ids.add(oc_msg_id)
                return self._drain_pending_parts(state, oc_msg_id, is_subtask=True)

        return []

    def _on_part_updated(self, state: _PromptState, props: dict[str, Any]) -> list[dict[str, Any]]:
        """Forward parts of authorized messages; buffer parts that arrive early."""
        part = props.get("part", {})
        delta = props.get("delta")
        oc_msg_id = part.get("messageID", "")
        part_session_id = part.get("sessionID", "")

        # Discover child sessions from task tool metadata (covers task_id resume)
        if part.get("tool") == "task" and part_session_id == state.opencode_session_id:
            metadata = part.get("metadata")
            child_sid = metadata.get("sessionId") if isinstance(metadata, dict) else None
            if child_sid and child_sid not in state.tracked_child_session_ids:
                state.tracked_child_session_ids.add(child_sid)
                self._log.info(
                    "bridge.child_session_detected",
                    child_session_id=child_sid,
                    source="task_metadata",
                )

        if oc_msg_id in state.allowed_assistant_msg_ids:
            is_subtask = part_session_id in state.tracked_child_session_ids
            return self._handle_part(state, part, delta, is_subtask=is_subtask)
        if oc_msg_id:
            self._buffer_part(state, oc_msg_id, part, delta)
        return []

    def _on_session_error(self, state: _PromptState, props: dict[str, Any]) -> _StreamStep:
        error_session_id = props.get("sessionID")

        if error_session_id == state.opencode_session_id:
            error = props.get("error", {})
            if isinstance(error, dict) and error.get("name") == CONTEXT_OVERFLOW_ERROR_NAME:
                # With OpenCode's default automatic compaction enabled, this event
                # announces recovery; session.compacted and more work follow it.
                self._log.info(
                    "bridge.context_overflow_compacting",
                    error_msg=self._extract_error_message(error),
                )
                return _StreamStep(events=[], disposition=_Disposition.CONTINUE)

            error_event = self._parent_error_event_once(state, error)
            self._log.error("bridge.session_error", error_msg=error_event and error_event["error"])
            return _StreamStep(
                events=[error_event] if error_event else [],
                disposition=_Disposition.FAILED,
            )

        if error_session_id in state.tracked_child_session_ids:
            error_msg = self._extract_error_message(props.get("error", {}))
            self._log.error(
                "bridge.child_session_error",
                error_msg=error_msg,
                child_session_id=error_session_id,
            )
            # Stream does not end — the parent continues after a sub-task error
            return _StreamStep(
                events=[
                    {
                        "type": "error",
                        "error": error_msg or "Sub-task error",
                        "messageId": state.message_id,
                        "isSubtask": True,
                    }
                ],
                disposition=_Disposition.CONTINUE,
            )

        return _StreamStep(events=[], disposition=_Disposition.CONTINUE)

    def _parent_error_event_once(self, state: _PromptState, error: object) -> dict[str, Any] | None:
        """Build one parent error event across message.updated and session.error."""
        error_msg = self._extract_error_message(error) or "Unknown error"
        if error_msg in state.emitted_error_messages:
            return None
        state.emitted_error_messages.add(error_msg)
        return {
            "type": "error",
            "error": error_msg,
            "messageId": state.message_id,
        }

    def _handle_part(
        self,
        state: _PromptState,
        part: dict[str, Any],
        delta: Any,
        *,
        is_subtask: bool = False,
    ) -> list[dict[str, Any]]:
        """Translate one authorized part into bridge events."""
        part_type = part.get("type", "")
        part_id = part.get("id", "")
        events: list[dict[str, Any]] = []

        if part_type == "text":
            if is_subtask:
                return events  # Don't forward child text tokens
            text = part.get("text", "")
            if delta:
                state.cumulative_text[part_id] = state.cumulative_text.get(part_id, "") + delta
            else:
                state.cumulative_text[part_id] = text

            if state.cumulative_text.get(part_id):
                events.append(
                    {
                        "type": "token",
                        "content": state.cumulative_text[part_id],
                        "messageId": state.message_id,
                    }
                )

        elif part_type == "tool":
            tool_event = self._tool_call_event(part, state.message_id)
            if tool_event:
                tool_state = part.get("state", {})
                status = tool_state.get("status", "")
                call_id = part.get("callID", "")
                part_sid = part.get("sessionID", "")
                tool_key = f"tool:{part_sid}:{call_id}:{status}"

                if tool_key not in state.emitted_tool_states:
                    state.emitted_tool_states.add(tool_key)
                    events.append(tool_event)

        elif part_type == "step-start":
            events.append(
                {
                    "type": "step_start",
                    "messageId": state.message_id,
                }
            )

        elif part_type == "step-finish":
            events.append(
                {
                    "type": "step_finish",
                    "cost": part.get("cost"),
                    "tokens": part.get("tokens"),
                    "reason": part.get("reason"),
                    "messageId": state.message_id,
                }
            )

        if is_subtask:
            for ev in events:
                ev["isSubtask"] = True
        return events

    def _buffer_part(
        self, state: _PromptState, oc_msg_id: str, part: dict[str, Any], delta: Any
    ) -> None:
        if state.pending_parts_total >= MAX_PENDING_PART_EVENTS:
            if not state.pending_drop_logged:
                self._log.warn(
                    "bridge.pending_parts_dropped",
                    message_id=state.message_id,
                    limit=MAX_PENDING_PART_EVENTS,
                )
                state.pending_drop_logged = True
            return
        state.pending_parts.setdefault(oc_msg_id, []).append(_PendingPart(part=part, delta=delta))
        state.pending_parts_total += 1

    def _drain_pending_parts(
        self, state: _PromptState, oc_msg_id: str, *, is_subtask: bool
    ) -> list[dict[str, Any]]:
        pending = state.pending_parts.pop(oc_msg_id, [])
        if not pending:
            return []
        state.pending_parts_total -= len(pending)
        events: list[dict[str, Any]] = []
        for entry in pending:
            events.extend(self._handle_part(state, entry.part, entry.delta, is_subtask=is_subtask))
        return events

    def _log_parent_idle(self, state: _PromptState, log_event: str) -> None:
        self._log.debug(
            log_event,
            elapsed_s=round(time.time() - state.start_time, 1),
            tracked_msgs=len(state.allowed_assistant_msg_ids),
        )

    def _tool_call_event(
        self,
        part: dict[str, Any],
        message_id: str,
    ) -> dict[str, Any] | None:
        """Build a tool_call event from a tool part.

        Returns None for a pending invocation with no input yet — there is
        nothing to show until arguments start streaming.
        """
        tool_state = part.get("state", {})
        status = tool_state.get("status", "")
        tool_input = tool_state.get("input", {})

        self._log.debug(
            "bridge.tool_part",
            tool=part.get("tool"),
            status=status,
        )

        if status in ("pending", "") and not tool_input:
            return None

        return {
            "type": "tool_call",
            "tool": part.get("tool", ""),
            "args": tool_input,
            "callId": part.get("callID", ""),
            "status": status,
            "output": tool_state.get("output", ""),
            "messageId": message_id,
        }

    def _build_prompt_request_body(
        self,
        content: str,
        model: str | None,
        opencode_message_id: str | None = None,
        reasoning_effort: str | None = None,
        attachments: list[HydratedSessionAttachment] | None = None,
    ) -> dict[str, Any]:
        """Build request body for OpenCode prompt requests.

        Args:
            content: The prompt text content
            model: Optional model override (e.g., "claude-haiku-4-5" or "anthropic/claude-haiku-4-5")
            opencode_message_id: OpenCode-compatible ascending message ID (e.g., "msg_...").
                                 When provided, OpenCode uses this as the user message ID,
                                 and assistant responses will have parentID pointing to it.
            reasoning_effort: Optional reasoning effort level (e.g., "high", "max")
            attachments: Optional list of attachment dicts (type/name/url/content/mimeType)
                         to forward as OpenCode file parts.
        """
        parts: list[dict[str, Any]] = [{"type": "text", "text": content}]
        parts.extend(
            dict(part) for part in self._attachment_processor.build_file_parts(attachments)
        )
        request_body: dict[str, Any] = {"parts": parts}

        if opencode_message_id:
            request_body["messageID"] = opencode_message_id

        if model:
            if "/" in model:
                provider_id, model_id = model.split("/", 1)
            else:
                provider_id, model_id = "anthropic", model
            model_spec: dict[str, Any] = {
                "providerID": provider_id,
                "modelID": model_id,
            }

            if reasoning_effort:
                if provider_id == "anthropic":
                    if model_id in ANTHROPIC_ADAPTIVE_THINKING_MODELS:
                        anthropic_options: dict[str, Any] = {
                            "thinking": {"type": "adaptive"},
                        }
                        if reasoning_effort in ANTHROPIC_ADAPTIVE_EFFORTS:
                            anthropic_options["outputConfig"] = {"effort": reasoning_effort}
                        model_spec["options"] = anthropic_options
                    else:
                        budget = ANTHROPIC_THINKING_BUDGETS.get(reasoning_effort)
                        if budget is not None:
                            model_spec["options"] = {
                                "thinking": {"type": "enabled", "budgetTokens": budget}
                            }
                elif provider_id == "openai":
                    model_spec["options"] = {
                        "reasoningEffort": reasoning_effort,
                        "reasoningSummary": "auto",
                    }

            request_body["model"] = model_spec

        return request_body

    def _session_title_event_from_sse(
        self, state: _PromptState, event_type: object, props: dict[str, Any]
    ) -> dict[str, str] | None:
        if event_type != "session.updated":
            return None

        info = props.get("info")
        if not isinstance(info, dict):
            return None

        session_id = props.get("sessionID") or info.get("id")
        if session_id != state.opencode_session_id:
            return None

        return self._session_title_event_once(info.get("title"))

    def _session_title_event_once(self, title: object) -> dict[str, str] | None:
        trimmed = self._normalize_forwardable_session_title(title)
        if trimmed is None:
            return None
        if trimmed == self._last_forwarded_session_title:
            return None

        self._last_forwarded_session_title = trimmed
        return {"type": "session_title", "title": trimmed}

    @staticmethod
    def _normalize_forwardable_session_title(title: object) -> str | None:
        if not isinstance(title, str):
            return None

        trimmed = title.strip()
        if not trimmed or OPENCODE_DEFAULT_TITLE_RE.match(trimmed):
            return None
        return trimmed

    @staticmethod
    def _extract_error_message(error: object) -> str | None:
        """Extract message from OpenCode NamedError: { "name": "...", "data": { "message": "..." } }."""
        if isinstance(error, dict):
            data = error.get("data")
            if isinstance(data, dict) and "message" in data:
                return str(data["message"])
            message = error.get("message") or error.get("name")
            return str(message) if message else None
        return str(error) if error else None

    async def _fetch_final_message_state(
        self, state: _PromptState
    ) -> AsyncIterator[dict[str, Any]]:
        """Fetch final message state from API to ensure complete text.

        This is called after session.idle (and on the timeout/disconnect
        paths) to capture any text that may have been missed due to SSE event
        ordering. It fetches the latest message state and emits any text
        that's longer than what ``state.cumulative_text`` says we already
        sent.

        Accepts an assistant message when its parentID matches one of the
        prompt's user message IDs, when it was already authorized during SSE
        streaming, or — after compaction, which rewrites the message chain —
        when it is not the compaction summary itself.
        """
        if not state.opencode_session_id:
            return

        try:
            messages = await self._client.get_messages(state.opencode_session_id)
            if messages is None:
                return

            for msg in messages:
                info = msg.get("info", {})
                role = info.get("role", "")
                msg_id = info.get("id", "")
                parent_id = info.get("parentID", "")

                if role != "assistant":
                    continue

                parent_matches = parent_id in state.user_message_ids
                in_tracked_set = msg_id in state.allowed_assistant_msg_ids
                is_compaction_summary = info.get("summary") is True

                # Accept if: parentID matches, was tracked during SSE, or
                # compaction occurred and this isn't the summary message
                should_accept = (
                    parent_matches
                    or in_tracked_set
                    or (state.compaction_occurred and not is_compaction_summary)
                )
                if not should_accept:
                    continue

                parts = msg.get("parts", [])
                for part in parts:
                    part_type = part.get("type", "")
                    part_id = part.get("id", "")

                    if part_type == "text":
                        text = part.get("text", "")
                        previously_sent = state.cumulative_text.get(part_id, "")
                        if len(text) > len(previously_sent):
                            self._log.debug(
                                "bridge.final_text_update",
                                prev_len=len(previously_sent),
                                new_len=len(text),
                            )
                            state.cumulative_text[part_id] = text
                            yield {
                                "type": "token",
                                "content": text,
                                "messageId": state.message_id,
                            }

        except Exception as e:
            self._log.error("bridge.final_state_error", exc=e)

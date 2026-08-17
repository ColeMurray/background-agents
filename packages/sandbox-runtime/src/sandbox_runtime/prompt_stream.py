"""OpenCode prompt streaming: translates OpenCode SSE events to bridge events."""

from __future__ import annotations

import asyncio
import math
import re
import time
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING, Any, Final

from .child_activity import (
    MAX_PENDING_CHILD_ACTIVITY,
    ChildActivityCorrelator,
    MessageDisposition,
    PendingChildActivity,
    PendingChildError,
    PendingChildMessage,
)
from .message_attribution import AssistantMessageDisposition, MessageAttribution
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
        "claude-opus-5",
        "claude-sonnet-4-6",
        "claude-sonnet-5",
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
    attribution: MessageAttribution = field(init=False)
    pending_parts: dict[str, list[_PendingPart]] = field(default_factory=dict)
    pending_parts_total: int = 0
    pending_drop_logged: bool = False
    child_activity: ChildActivityCorrelator = field(default_factory=ChildActivityCorrelator)
    emitted_error_messages: set[str] = field(default_factory=set)
    # Set when a parent context-overflow announcement was swallowed; cleared by
    # session.compacted. If still set at idle with no error emitted, the
    # promised compaction never happened and the prompt must fail.
    pending_overflow_error: str | None = None

    def __post_init__(self) -> None:
        self.attribution = MessageAttribution(
            self.opencode_message_id,
            # start_time is captured before the prompt is posted, so nothing
            # OpenCode creates for this prompt can predate it.
            int(self.start_time * 1000),
        )


class _Disposition(Enum):
    """What the stream loop should do after applying one SSE event."""

    CONTINUE = "continue"
    # Parent session went idle: emit the final message state, then finish.
    FINISHED_IDLE = "finished_idle"
    # Parent session errored: the error event was emitted, finish immediately.
    FAILED = "failed"


class _PromptMaxDurationTimeout(Exception):
    pass


@dataclass(frozen=True)
class _StreamStep:
    """Bridge events produced by one SSE event, plus the loop disposition."""

    events: list[dict[str, Any]]
    disposition: _Disposition


def _message_created_epoch_ms(info: dict[str, Any]) -> int | None:
    """Read `time.created` off an OpenCode message, or None when it is absent.

    Non-finite values are treated as absent rather than converted: `int()`
    raises on NaN and infinity, which would tear down the SSE loop over a
    malformed payload.
    """
    time_info = info.get("time")
    if not isinstance(time_info, dict):
        return None
    created = time_info.get("created")
    if isinstance(created, bool) or not isinstance(created, (int, float)):
        return None
    if not math.isfinite(created):
        return None
    return int(created)


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
        prompt_cleanup_timeout_seconds: float,
    ) -> None:
        self._client = client
        self._attachment_processor = attachment_processor
        self._log = log
        self._sse_inactivity_timeout_seconds = sse_inactivity_timeout_seconds
        self._prompt_max_duration_seconds = prompt_max_duration_seconds
        self._prompt_cleanup_timeout_seconds = prompt_cleanup_timeout_seconds
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

        Supplying our own user message ID is what makes attribution possible:
        OpenCode stamps the assistant messages it generates for this prompt
        with `parentID` pointing at it. The ID's ordering carries no meaning —
        see OpenCodeIdentifier on why these IDs must never be compared.
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
        loop = asyncio.get_running_loop()
        prompt_deadline = loop.time() + self._prompt_max_duration_seconds
        try:
            async with AsyncExitStack() as stack:
                try:
                    async with asyncio.timeout(prompt_deadline - loop.time()):
                        sse_events = await stack.enter_async_context(
                            self._client.events(
                                inactivity_timeout_seconds=self._sse_inactivity_timeout_seconds
                            )
                        )
                        await self._client.post_prompt(opencode_session_id, request_body)
                except TimeoutError as error:
                    raise _PromptMaxDurationTimeout from error
                event_iterator = aiter(sse_events)

                while True:
                    remaining_seconds = prompt_deadline - loop.time()
                    if remaining_seconds <= 0:
                        raise _PromptMaxDurationTimeout
                    try:
                        async with asyncio.timeout(remaining_seconds):
                            sse_event = await anext(event_iterator)
                    except StopAsyncIteration:
                        break
                    except TimeoutError as error:
                        raise _PromptMaxDurationTimeout from error

                    step = self._apply_sse_event(state, sse_event)
                    if step.disposition is not _Disposition.CONTINUE:
                        for event in self._flush_unassociated_child_activity(state):
                            yield event
                    for event in step.events:
                        yield event

                    if step.disposition is _Disposition.FINISHED_IDLE:
                        async for final_event in self._fetch_final_message_state(state):
                            yield final_event
                        return
                    if step.disposition is _Disposition.FAILED:
                        return

                for event in self._flush_unassociated_child_activity(state):
                    yield event

        except _PromptMaxDurationTimeout:
            elapsed = time.time() - state.start_time
            self._log.error(
                "bridge.prompt_max_duration_timeout",
                timeout_ms=int(self._prompt_max_duration_seconds * 1000),
                elapsed_ms=int(elapsed * 1000),
                message_id=message_id,
            )
            pending_child_events = self._flush_unassociated_child_activity(state)
            for event in pending_child_events:
                yield event
            final_events: list[dict[str, Any]] = []
            try:
                async with asyncio.timeout(self._prompt_cleanup_timeout_seconds):
                    await self._client.request_stop(
                        opencode_session_id, reason="prompt_max_duration_timeout"
                    )
                    async for event in self._fetch_final_message_state(state):
                        final_events.append(event)
            except TimeoutError:
                self._log.error(
                    "bridge.prompt_timeout_cleanup_timeout",
                    timeout_ms=int(self._prompt_cleanup_timeout_seconds * 1000),
                    message_id=message_id,
                )
            for final_event in final_events:
                yield final_event
            raise RuntimeError(
                f"Prompt exceeded max duration of {self._prompt_max_duration_seconds:.0f}s."
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
            pending_child_events = self._flush_unassociated_child_activity(state)
            for event in pending_child_events:
                yield event
            await self._client.request_stop(opencode_session_id, reason="inactivity_timeout")
            async for final_event in self._fetch_final_message_state(state):
                yield final_event
            raise RuntimeError(
                f"SSE stream inactive for {self._sse_inactivity_timeout_seconds:.0f}s "
                f"(no data received). Total elapsed: {elapsed:.0f}s"
            )

        except SSEStreamDisconnectedError as e:
            for event in self._flush_unassociated_child_activity(state):
                yield event
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
        is_child = state.child_activity.is_tracked(event_session_id)
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
                events.extend(self._unrecovered_overflow_events(state))
                return _StreamStep(events=events, disposition=_Disposition.FINISHED_IDLE)

        elif event_type == "session.status":
            status = props.get("status", {})
            # Only parent status=idle terminates the stream
            if props.get("sessionID") == state.opencode_session_id and status.get("type") == "idle":
                self._log_parent_idle(state, "bridge.session_status_idle")
                events.extend(self._unrecovered_overflow_events(state))
                return _StreamStep(events=events, disposition=_Disposition.FINISHED_IDLE)

        elif event_type == "session.error":
            return self._on_session_error(state, props)

        elif event_type == "session.compacted":
            if props.get("sessionID") == state.opencode_session_id:
                state.attribution.mark_compacted()
                state.pending_overflow_error = None
                self._log.info("bridge.session_compacted", message_id=state.message_id)
                events.append({"type": "context_compacted", "messageId": state.message_id})

        return _StreamStep(events=events, disposition=_Disposition.CONTINUE)

    def _track_child_session(self, state: _PromptState, props: dict[str, Any]) -> None:
        info = props.get("info", {})
        child_id = info.get("id")
        child_parent = info.get("parentID")
        if child_id and child_parent == state.opencode_session_id:
            if state.child_activity.track(child_id):
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
                if state.attribution.add_user_message(oc_msg_id):
                    self._log.info(
                        "bridge.user_message_id_discovered",
                        expected_id=state.opencode_message_id,
                        actual_id=oc_msg_id,
                    )

            parent_matches = state.attribution.parent_matches(parent_id)
            is_compaction_summary = info.get("summary") is True

            self._log.debug(
                "bridge.message_updated",
                role=role,
                oc_msg_id=oc_msg_id,
                parent_match=parent_matches,
                compaction_occurred=state.attribution.is_compacted,
                is_compaction_summary=is_compaction_summary,
            )

            events: list[dict[str, Any]] = []
            if role == "assistant" and oc_msg_id:
                disposition = state.attribution.assistant_disposition(
                    oc_msg_id,
                    parent_id,
                    is_summary=is_compaction_summary,
                    created_epoch_ms=_message_created_epoch_ms(info),
                )
                if disposition is not AssistantMessageDisposition.REJECT and info.get("error"):
                    error_event = self._parent_error_event_once(state, info["error"])
                    if error_event:
                        self._log.error(
                            "bridge.message_error",
                            error_msg=error_event["error"],
                            oc_msg_id=oc_msg_id,
                        )
                        events.append(error_event)

                if disposition is AssistantMessageDisposition.OUTPUT:
                    events.extend(self._drain_pending_parts(state, oc_msg_id, is_subtask=False))

            if finish and finish not in ("tool-calls", ""):
                self._log.debug(
                    "bridge.message_finished",
                    finish=finish,
                )
            return events

        if state.child_activity.is_tracked(msg_session_id):
            oc_msg_id = info.get("id", "")
            role = info.get("role", "")
            if role == "assistant" and oc_msg_id:
                child_disposition = state.child_activity.authorize_or_queue_message(
                    msg_session_id, oc_msg_id
                )
                if child_disposition is MessageDisposition.DROPPED:
                    self._log_pending_child_drop(state)
                    return []
                if child_disposition is MessageDisposition.QUEUED:
                    return []
                state.attribution.allow_assistant(oc_msg_id)
                return self._drain_pending_parts(state, oc_msg_id, is_subtask=True)

        return []

    def _on_part_updated(self, state: _PromptState, props: dict[str, Any]) -> list[dict[str, Any]]:
        """Forward parts of authorized messages; buffer parts that arrive early."""
        part = props.get("part", {})
        delta = props.get("delta")
        oc_msg_id = part.get("messageID", "")
        part_session_id = part.get("sessionID", "")
        events: list[dict[str, Any]] = []
        correlated_child_sid: str | None = None

        # Discover child sessions from task tool metadata (covers task_id resume)
        if part.get("tool") == "task" and part_session_id == state.opencode_session_id:
            tool_state = part.get("state", {})
            metadata = tool_state.get("metadata") if isinstance(tool_state, dict) else None
            child_sid = metadata.get("sessionId") if isinstance(metadata, dict) else None
            task_call_id = part.get("callID")
            if child_sid:
                if task_call_id:
                    is_new_child = state.child_activity.associate(child_sid, task_call_id)
                    correlated_child_sid = child_sid
                else:
                    is_new_child = state.child_activity.track(child_sid)
                if is_new_child:
                    self._log.info(
                        "bridge.child_session_detected",
                        child_session_id=child_sid,
                        source="task_metadata",
                    )

        if state.attribution.is_assistant_allowed(oc_msg_id):
            is_subtask = state.child_activity.is_tracked(part_session_id)
            events.extend(self._handle_part(state, part, delta, is_subtask=is_subtask))
        elif oc_msg_id:
            self._buffer_part(state, oc_msg_id, part, delta)

        if correlated_child_sid:
            events.extend(self._release_child_activity(state, correlated_child_sid))

        if part.get("tool") == "task":
            status = part.get("state", {}).get("status", "")
            if status in ("completed", "error"):
                state.child_activity.close(part.get("callID", ""))

        return events

    def _on_session_error(self, state: _PromptState, props: dict[str, Any]) -> _StreamStep:
        error_session_id = props.get("sessionID")

        if error_session_id == state.opencode_session_id:
            error = props.get("error", {})
            if isinstance(error, dict) and error.get("name") == CONTEXT_OVERFLOW_ERROR_NAME:
                # With OpenCode's default automatic compaction enabled, this event
                # announces recovery; session.compacted and more work follow it.
                # Remember the error so idle-without-compaction still fails.
                state.pending_overflow_error = (
                    self._extract_error_message(error) or "Context overflow"
                )
                self._log.info(
                    "bridge.context_overflow_compacting",
                    error_msg=state.pending_overflow_error,
                )
                return _StreamStep(events=[], disposition=_Disposition.CONTINUE)

            error_event = self._parent_error_event_once(state, error)
            self._log.error(
                "bridge.session_error",
                error_msg=self._extract_error_message(error),
                deduped=error_event is None,
            )
            return _StreamStep(
                events=[error_event] if error_event else [],
                disposition=_Disposition.FAILED,
            )

        if isinstance(error_session_id, str) and state.child_activity.is_tracked(error_session_id):
            error = props.get("error", {})
            if isinstance(error, dict) and error.get("name") == CONTEXT_OVERFLOW_ERROR_NAME:
                # Child sessions recover through the same automatic compaction;
                # surfacing this would fail the whole prompt spuriously.
                self._log.info(
                    "bridge.child_context_overflow_compacting",
                    error_msg=self._extract_error_message(error),
                    child_session_id=error_session_id,
                )
                return _StreamStep(events=[], disposition=_Disposition.CONTINUE)

            error_msg = self._extract_error_message(error)
            self._log.error(
                "bridge.child_session_error",
                error_msg=error_msg,
                child_session_id=error_session_id,
            )
            # Stream does not end — the parent continues after a sub-task error
            normalized_error = error_msg or "Sub-task error"
            task_call_id = state.child_activity.task_for_activity(error_session_id)
            if not task_call_id:
                if not state.child_activity.queue_error(error_session_id, normalized_error):
                    self._log_pending_child_drop(state)
                return _StreamStep(events=[], disposition=_Disposition.CONTINUE)
            return _StreamStep(
                events=[
                    self._child_error_event(
                        state,
                        error_session_id,
                        normalized_error,
                        task_call_id,
                    )
                ],
                disposition=_Disposition.CONTINUE,
            )

        return _StreamStep(events=[], disposition=_Disposition.CONTINUE)

    def _unrecovered_overflow_events(self, state: _PromptState) -> list[dict[str, Any]]:
        """Fail the prompt if a swallowed overflow's promised compaction never came.

        The context-overflow announcement is only safe to swallow because
        compaction normally follows it. If the session goes idle without
        compacting and without any error emitted, surface the original
        overflow error instead of reporting silent success.
        """
        if state.pending_overflow_error is None or state.emitted_error_messages:
            return []
        self._log.error(
            "bridge.context_overflow_unrecovered",
            error_msg=state.pending_overflow_error,
        )
        state.emitted_error_messages.add(state.pending_overflow_error)
        return [
            {
                "type": "error",
                "error": state.pending_overflow_error,
                "messageId": state.message_id,
            }
        ]

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
                child_session_id = state.child_activity.child_for_task(call_id) or ""
                tool_key = f"tool:{part_sid}:{call_id}:{status}:{child_session_id}"

                if part.get("tool") == "task":
                    if child_session_id:
                        tool_event["childSessionId"] = child_session_id

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
            child_session_id = part.get("sessionID", "")
            for ev in events:
                ev["isSubtask"] = True
                if child_session_id:
                    ev["childSessionId"] = child_session_id
                    task_call_id = state.child_activity.task_for_message(part.get("messageID", ""))
                    if task_call_id:
                        ev["taskCallId"] = task_call_id
        return events

    def _release_child_activity(
        self, state: _PromptState, child_session_id: str
    ) -> list[dict[str, Any]]:
        return [
            event
            for activity in state.child_activity.release(child_session_id)
            for event in self._emit_pending_child_activity(state, activity)
        ]

    def _flush_unassociated_child_activity(self, state: _PromptState) -> list[dict[str, Any]]:
        return [
            event
            for activity in state.child_activity.flush()
            for event in self._emit_pending_child_activity(state, activity)
        ]

    def _emit_pending_child_activity(
        self, state: _PromptState, activity: PendingChildActivity
    ) -> list[dict[str, Any]]:
        task_call_id = state.child_activity.task_for_pending(activity)
        if isinstance(activity, PendingChildError):
            return [
                self._child_error_event(
                    state, activity.child_session_id, activity.error, task_call_id
                )
            ]

        if not isinstance(activity, PendingChildMessage):
            return []
        state.attribution.allow_assistant(activity.message_id)
        return self._drain_pending_parts(state, activity.message_id, is_subtask=True)

    def _log_pending_child_drop(self, state: _PromptState) -> None:
        if not state.child_activity.should_log_drop():
            return
        self._log.warn(
            "bridge.pending_child_activity_dropped",
            message_id=state.message_id,
            limit=MAX_PENDING_CHILD_ACTIVITY,
        )

    def _child_error_event(
        self,
        state: _PromptState,
        child_session_id: str,
        error: str,
        task_call_id: str | None,
    ) -> dict[str, Any]:
        event = {
            "type": "error",
            "error": error,
            "messageId": state.message_id,
            "isSubtask": True,
            "childSessionId": child_session_id,
        }
        if task_call_id:
            event["taskCallId"] = task_call_id
        return event

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
            tracked_msgs=state.attribution.allowed_assistant_count,
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
                elif provider_id == "xai":
                    request_body["variant"] = reasoning_effort

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
        streaming, or after compaction, which rewrites the message chain.
        The compaction fallback is limited to messages created after this
        prompt's user message: the API returns the whole session history, and
        re-emitting prior turns' text here would overwrite this prompt's
        final output with stale messages. The compaction summary itself is
        never accepted: its text is internal context, and its parentID (the
        compaction user message) matches.
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

                is_compaction_summary = info.get("summary") is True
                disposition = state.attribution.assistant_disposition(
                    msg_id,
                    parent_id,
                    is_summary=is_compaction_summary,
                    created_epoch_ms=_message_created_epoch_ms(info),
                )
                if disposition is not AssistantMessageDisposition.OUTPUT:
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

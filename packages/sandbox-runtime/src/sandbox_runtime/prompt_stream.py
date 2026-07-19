"""OpenCode prompt streaming: translates OpenCode SSE events to bridge events."""

from __future__ import annotations

import asyncio
import json
import re
import secrets
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING, Any, ClassVar, Final

import httpx

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from .attachment_processor import AttachmentProcessor, HydratedSessionAttachment
    from .log_config import StructuredLogger

HTTP_CONNECT_TIMEOUT_SECONDS: Final = 30.0
OPENCODE_REQUEST_TIMEOUT_SECONDS: Final = 30.0

# Cap on parts buffered for assistant messages that have not been authorized
# yet (their message.updated may arrive after their first parts).
MAX_PENDING_PART_EVENTS: Final = 2000

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


class SSEConnectionError(Exception):
    """Raised when SSE connection fails."""


class OpenCodeIdentifier:
    """
    Generate OpenCode-compatible ascending IDs.

    Port of OpenCode's TypeScript implementation:
    https://github.com/anomalyco/opencode/blob/8f0d08fae07c97a090fcd31d0d4c4a6fa7eeaa1d/packages/opencode/src/id/id.ts

    Format: {prefix}_{timestamp_hex}{random_base62}
    - prefix: type identifier (e.g., "msg" for messages)
    - timestamp_hex: 12 hex chars encoding (timestamp_ms * 0x1000 + counter)
    - random_base62: 14 random base62 characters

    IDs are monotonically increasing, ensuring new user messages always have
    IDs greater than previous assistant messages (required for OpenCode's
    prompt loop).

    Note: Uses class-level state for monotonic generation. Safe for async code
    but NOT thread-safe.
    """

    PREFIXES: ClassVar[dict[str, str]] = {
        "session": "ses",
        "message": "msg",
        "part": "prt",
    }
    BASE62_CHARS: ClassVar[str] = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    RANDOM_LENGTH: ClassVar[int] = 14

    _last_timestamp: ClassVar[int] = 0
    _counter: ClassVar[int] = 0

    @classmethod
    def ascending(cls, prefix: str) -> str:
        """Generate an ascending ID with the given prefix."""
        if prefix not in cls.PREFIXES:
            raise ValueError(f"Unknown prefix: {prefix}")

        prefix_str = cls.PREFIXES[prefix]
        current_timestamp = int(time.time() * 1000)

        if current_timestamp != cls._last_timestamp:
            cls._last_timestamp = current_timestamp
            cls._counter = 0
        cls._counter += 1

        encoded = current_timestamp * 0x1000 + cls._counter
        encoded_48bit = encoded & 0xFFFFFFFFFFFF
        timestamp_bytes = encoded_48bit.to_bytes(6, byteorder="big")
        timestamp_hex = timestamp_bytes.hex()
        random_suffix = cls._random_base62(cls.RANDOM_LENGTH)

        return f"{prefix_str}_{timestamp_hex}{random_suffix}"

    @classmethod
    def _random_base62(cls, length: int) -> str:
        """Generate random base62 string."""
        return "".join(cls.BASE62_CHARS[secrets.randbelow(62)] for _ in range(length))


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
        http_client: httpx.AsyncClient,
        opencode_base_url: str,
        attachment_processor: AttachmentProcessor,
        log: StructuredLogger,
        sse_inactivity_timeout_seconds: float,
        prompt_max_duration_seconds: float,
    ) -> None:
        self._http_client = http_client
        self._opencode_base_url = opencode_base_url
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

        sse_url = f"{self._opencode_base_url}/event"
        async_url = f"{self._opencode_base_url}/session/{opencode_session_id}/prompt_async"

        state = _PromptState(
            opencode_session_id=opencode_session_id,
            message_id=message_id,
            opencode_message_id=opencode_message_id,
            start_time=time.time(),
        )
        state.user_message_ids.add(opencode_message_id)
        loop = asyncio.get_running_loop()

        try:
            deadline = loop.time() + self._sse_inactivity_timeout_seconds
            async with asyncio.timeout_at(deadline) as timeout_ctx:
                async with self._http_client.stream(
                    "GET",
                    sse_url,
                    timeout=httpx.Timeout(None, connect=HTTP_CONNECT_TIMEOUT_SECONDS, read=None),
                ) as sse_response:
                    if sse_response.status_code != 200:
                        raise SSEConnectionError(
                            f"SSE connection failed: {sse_response.status_code}"
                        )

                    prompt_start = loop.time()
                    await self._post_prompt(async_url, request_body)

                    async for sse_event in self._parse_sse_stream(sse_response, timeout_ctx):
                        step = self._apply_sse_event(state, sse_event)
                        for event in step.events:
                            yield event

                        if step.disposition is _Disposition.FINISHED_IDLE:
                            async for final_event in self._final_state_events(state):
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
                            await self.request_stop(
                                opencode_session_id, reason="prompt_max_duration_timeout"
                            )
                            async for final_event in self._final_state_events(state):
                                yield final_event
                            raise RuntimeError(
                                f"Prompt exceeded max duration of "
                                f"{self._prompt_max_duration_seconds:.0f}s."
                            )

        except TimeoutError:
            elapsed = time.time() - state.start_time
            self._log.error(
                "bridge.sse_inactivity_timeout",
                timeout_name="sse_inactivity",
                timeout_ms=int(self._sse_inactivity_timeout_seconds * 1000),
                elapsed_ms=int(elapsed * 1000),
                operation="bridge.sse",
                message_id=message_id,
            )
            await self.request_stop(opencode_session_id, reason="inactivity_timeout")
            async for final_event in self._final_state_events(state):
                yield final_event
            raise RuntimeError(
                f"SSE stream inactive for {self._sse_inactivity_timeout_seconds:.0f}s "
                f"(no data received). Total elapsed: {elapsed:.0f}s"
            )

        except httpx.TransportError as e:
            self._log.error("bridge.sse_transport_error", exc=e)
            async for final_event in self._final_state_events(state):
                yield final_event
            raise SSEConnectionError(
                "OpenCode event stream disconnected before completion; "
                "partial output was preserved when available."
            ) from e

    async def request_stop(self, opencode_session_id: str | None, *, reason: str) -> bool:
        """Best-effort abort of the active OpenCode prompt (saves LLM compute)."""
        if not opencode_session_id:
            return False

        try:
            await self._http_client.post(
                f"{self._opencode_base_url}/session/{opencode_session_id}/abort",
                timeout=OPENCODE_REQUEST_TIMEOUT_SECONDS,
            )
            self._log.info("bridge.stop_requested", reason=reason)
            return True
        except Exception as e:
            self._log.warn("bridge.stop_request_error", exc=e, reason=reason)
            return False

    async def _post_prompt(self, async_url: str, request_body: dict[str, Any]) -> None:
        """Kick off the async prompt; the response arrives on the SSE stream."""
        prompt_response = await self._http_client.post(
            async_url,
            json=request_body,
            timeout=OPENCODE_REQUEST_TIMEOUT_SECONDS,
        )
        if prompt_response.status_code not in [200, 204]:
            error_body = prompt_response.text
            self._log.error(
                "bridge.prompt_request_error",
                status_code=prompt_response.status_code,
                error_body=error_body,
            )
            raise RuntimeError(f"Async prompt failed: {prompt_response.status_code} - {error_body}")

    async def _parse_sse_stream(
        self,
        response: httpx.Response,
        timeout_ctx: asyncio.Timeout | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Parse Server-Sent Events stream from OpenCode.

        SSE format:
            data: {"type": "...", "properties": {...}}

            data: {"type": "...", "properties": {...}}

        Events are separated by double newlines.
        If timeout_ctx is provided, the deadline is reset on every chunk received.
        """
        buffer = ""
        async for chunk in response.aiter_text():
            buffer += chunk
            if timeout_ctx is not None:
                timeout_ctx.reschedule(
                    asyncio.get_running_loop().time() + self._sse_inactivity_timeout_seconds
                )

            # Process complete events (separated by double newlines)
            while "\n\n" in buffer:
                event_str, buffer = buffer.split("\n\n", 1)

                # Parse the event lines
                data_lines: list[str] = []
                for line in event_str.split("\n"):
                    if line.startswith("data:"):
                        # Handle both "data: {...}" and "data:{...}" formats
                        data_content = line[5:].lstrip()
                        if data_content:
                            data_lines.append(data_content)

                # Join multi-line data and parse JSON
                if data_lines:
                    try:
                        raw_data = "\n".join(data_lines)
                        event = json.loads(raw_data)
                        yield event
                    except json.JSONDecodeError as e:
                        self._log.debug("bridge.sse_parse_error", exc=e)

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
                # Accept if: parentID matches our message, OR compaction
                # happened and this isn't the compaction summary itself
                if parent_matches or (state.compaction_occurred and not is_compaction_summary):
                    state.allowed_assistant_msg_ids.add(oc_msg_id)
                    events = self._drain_pending_parts(state, oc_msg_id, is_subtask=False)

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
            error_msg = self._extract_error_message(props.get("error", {}))
            self._log.error("bridge.session_error", error_msg=error_msg)
            return _StreamStep(
                events=[
                    {
                        "type": "error",
                        "error": error_msg or "Unknown error",
                        "messageId": state.message_id,
                    }
                ],
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
            tool_event = self._transform_part_to_event(part, state.message_id)
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

    def _transform_part_to_event(
        self,
        part: dict[str, Any],
        message_id: str,
    ) -> dict[str, Any] | None:
        """Transform a single OpenCode part to a bridge event."""
        part_type = part.get("type")

        if part_type == "text":
            text = part.get("text", "")
            if text:
                return {
                    "type": "token",
                    "content": text,
                    "messageId": message_id,
                }
        elif part_type == "tool":
            state = part.get("state", {})
            status = state.get("status", "")
            tool_input = state.get("input", {})

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
                "output": state.get("output", ""),
                "messageId": message_id,
            }
        elif part_type == "step-finish":
            return {
                "type": "step_finish",
                "cost": part.get("cost"),
                "tokens": part.get("tokens"),
                "reason": part.get("reason"),
                "messageId": message_id,
            }
        elif part_type == "step-start":
            return {
                "type": "step_start",
                "messageId": message_id,
            }

        return None

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

    async def _final_state_events(self, state: _PromptState) -> AsyncIterator[dict[str, Any]]:
        async for event in self._fetch_final_message_state(
            state.opencode_session_id,
            state.message_id,
            state.opencode_message_id,
            state.cumulative_text,
            state.allowed_assistant_msg_ids,
            user_message_ids=state.user_message_ids,
            compaction_occurred=state.compaction_occurred,
        ):
            yield event

    async def _fetch_final_message_state(
        self,
        opencode_session_id: str,
        message_id: str,
        opencode_message_id: str,
        cumulative_text: dict[str, str],
        tracked_msg_ids: set[str] | None = None,
        user_message_ids: set[str] | None = None,
        compaction_occurred: bool = False,
    ) -> AsyncIterator[dict[str, Any]]:
        """Fetch final message state from API to ensure complete text.

        This is called after session.idle to capture any text that may have
        been missed due to SSE event ordering. It fetches the latest message
        state and emits any text that's longer than what we've already sent.

        Args:
            opencode_session_id: OpenCode session to fetch messages from
            message_id: Control plane message ID (used in events sent back)
            opencode_message_id: OpenCode ascending ID (used for parentID correlation)
            cumulative_text: Text already sent, keyed by part ID
            tracked_msg_ids: Assistant message IDs tracked during SSE streaming
            compaction_occurred: Whether session compaction happened during this prompt.
                When True, accepts non-summary assistant messages even if parentID
                doesn't match, since compaction changes the message chain.

        Uses parentID-based correlation if available, falling back to
        tracked_msg_ids from SSE streaming if parentID doesn't match.
        """
        if not opencode_session_id:
            return

        messages_url = f"{self._opencode_base_url}/session/{opencode_session_id}/message"

        try:
            response = await self._http_client.get(
                messages_url,
                timeout=OPENCODE_REQUEST_TIMEOUT_SECONDS,
            )
            if response.status_code != 200:
                self._log.warn(
                    "bridge.final_state_fetch_error",
                    status_code=response.status_code,
                )
                return

            messages = response.json()

            for msg in messages:
                info = msg.get("info", {})
                role = info.get("role", "")
                msg_id = info.get("id", "")
                parent_id = info.get("parentID", "")

                if role != "assistant":
                    continue

                valid_parent_ids = user_message_ids or {opencode_message_id}
                parent_matches = parent_id in valid_parent_ids
                in_tracked_set = tracked_msg_ids and msg_id in tracked_msg_ids
                is_compaction_summary = info.get("summary") is True

                # Accept if: parentID matches, was tracked during SSE, or
                # compaction occurred and this isn't the summary message
                should_accept = (
                    parent_matches
                    or in_tracked_set
                    or (compaction_occurred and not is_compaction_summary)
                )
                if not should_accept:
                    continue

                parts = msg.get("parts", [])
                for part in parts:
                    part_type = part.get("type", "")
                    part_id = part.get("id", "")

                    if part_type == "text":
                        text = part.get("text", "")
                        previously_sent = cumulative_text.get(part_id, "")
                        if len(text) > len(previously_sent):
                            self._log.debug(
                                "bridge.final_text_update",
                                prev_len=len(previously_sent),
                                new_len=len(text),
                            )
                            cumulative_text[part_id] = text
                            yield {
                                "type": "token",
                                "content": text,
                                "messageId": message_id,
                            }

        except Exception as e:
            self._log.error("bridge.final_state_error", exc=e)

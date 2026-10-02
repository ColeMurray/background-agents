"""Translate Claude SDK messages into bridge events and trajectory records."""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Final, Literal

from claude_agent_sdk import (
    TERMINAL_TASK_STATUSES,
    AssistantMessage,
    ConversationResetMessage,
    RateLimitEvent,
    ResultMessage,
    StreamEvent,
    SystemMessage,
    TaskNotificationMessage,
    TaskProgressMessage,
    TaskStartedMessage,
    TaskUpdatedMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from .base import TurnOutcome
from .claude_tools import OI_TOOL_SERVER_NAME

if TYPE_CHECKING:
    from claude_agent_sdk import Message, MessageOrigin

    from .base import BridgeEvent

# The timeline groups Claude's child activity under the runtime-neutral task tool.
SUBAGENT_TOOL_NAME: Final = "Agent"
TASK_TOOL_NAME: Final = "task"
# First-party MCP tools use the same wire ids as OpenCode; external tools stay qualified.
OI_TOOL_PREFIX: Final = f"mcp__{OI_TOOL_SERVER_NAME}__"
MAX_TRACKED_TASKS: Final = 128
AUTHENTICATION_FAILED_MESSAGE: Final = (
    "Anthropic rejected this session's credential. Reconnect the Claude account in "
    "Settings (or check ANTHROPIC_API_KEY) and start a new session."
)


@dataclass
class TrajectoryRecord:
    event: str
    fields: dict[str, Any] = field(default_factory=dict)


@dataclass
class SdkTurnResult:
    status: str
    is_error: bool
    duration_ms: int
    duration_api_ms: int
    num_turns: int
    total_cost_usd: float | None
    tokens: dict[str, Any] | None


@dataclass
class ClaudeTranslation:
    events: list[BridgeEvent] = field(default_factory=list)
    outcome: TurnOutcome | None = None
    records: list[TrajectoryRecord] = field(default_factory=list)
    agent_session_id: str | None = None
    result: SdkTurnResult | None = None


@dataclass
class _MessageText:
    message_id: str | None
    text: str = ""


@dataclass
class ClaudeTurnState:
    message_id: str
    # None: the previous turn reported no running total, so the next total
    # cannot be split between the two turns.
    cost_baseline: float | None
    texts: list[_MessageText] = field(default_factory=list)
    last_token_content: str = ""
    tool_names: dict[str, str] = field(default_factory=dict)
    tool_args: dict[str, dict[str, Any]] = field(default_factory=dict)
    assistant_messages: set[tuple[str | None, int]] = field(default_factory=set)
    emitted_error: bool = False
    step_id: str | None = None
    # Skip a session-injected turn until its result, not the prompt's result.
    injected: bool = False

    def turn_text(self) -> str:
        return "\n\n".join(entry.text for entry in self.texts if entry.text)

    def entry_for(self, message_id: str | None) -> _MessageText:
        for entry in self.texts:
            if entry.message_id == message_id and message_id is not None:
                return entry
        if self.texts and self.texts[-1].message_id is None:
            self.texts[-1].message_id = message_id
            return self.texts[-1]
        entry = _MessageText(message_id)
        self.texts.append(entry)
        return entry


def _injected_origin(origin: MessageOrigin | None) -> MessageOrigin | None:
    """The origin when it names a turn the session started on its own."""
    if origin is None or origin.get("kind") == "human":
        return None
    return origin


def _canonical_tool_name(name: str) -> str:
    """The runtime-neutral tool id a ``tool_call`` event carries."""
    if name == SUBAGENT_TOOL_NAME:
        return TASK_TOOL_NAME
    if name.startswith(OI_TOOL_PREFIX):
        return name[len(OI_TOOL_PREFIX) :]
    return name


def _tool_result_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    parts: list[str] = []
    for item in content:
        if isinstance(item, dict) and item.get("type") == "text":
            parts.append(str(item.get("text", "")))
    return "\n".join(parts)


def _usage_tokens(usage: Mapping[str, Any] | None) -> dict[str, Any] | None:
    if not usage:
        return None
    cache = {
        "read": usage.get("cache_read_input_tokens"),
        "write": usage.get("cache_creation_input_tokens"),
    }
    tokens: dict[str, Any] = {
        "input": usage.get("input_tokens"),
        "output": usage.get("output_tokens"),
        "cache": {k: v for k, v in cache.items() if isinstance(v, int)},
    }
    tokens = {k: v for k, v in tokens.items() if v not in (None, {})}
    return tokens or None


class ClaudeTranslator:
    """Own SDK interpretation and conversation-lived translation state."""

    def __init__(self) -> None:
        self.session_id: str | None = None
        self.cost_baseline: float | None = 0.0
        self.init_info: dict[str, Any] | None = None
        # A conversation reset's next result carries the new resumable id.
        self._session_rotated = False
        self._observed_native_id: str | None = None
        # A reused client can deliver a task's terminal update on a later prompt.
        self._task_parents: dict[str, str] = {}

    def reset_tracking(self) -> None:
        """Clear correlation state without changing the running cost baseline."""
        self._observed_native_id = None
        self._task_parents.clear()

    def translate(
        self, state: ClaudeTurnState, message: Message, *, interrupted: bool
    ) -> ClaudeTranslation:
        translation = ClaudeTranslation(
            agent_session_id=self._observed_native_id or self.session_id
        )
        native_id = getattr(message, "session_id", None)
        if isinstance(message, SystemMessage):
            native_id = native_id or message.data.get("session_id")
        if isinstance(native_id, str) and native_id:
            if native_id != self._observed_native_id:
                self.reset_tracking()
                self._observed_native_id = native_id
            translation.agent_session_id = native_id

        if isinstance(message, ConversationResetMessage):
            # Resets affect the conversation even inside a filtered injected turn.
            # The next human result supplies the new resumable session id.
            self.cost_baseline = 0.0
            state.cost_baseline = 0.0
            self._session_rotated = True
            self.reset_tracking()
            self._observed_native_id = message.session_id
            return translation

        if self._belongs_to_injected_turn(state, message, translation.records):
            if isinstance(message, (TaskNotificationMessage, TaskUpdatedMessage)):
                if message.status in TERMINAL_TASK_STATUSES:
                    self._task_parents.pop(message.task_id, None)
            return translation

        events = translation.events
        records = translation.records
        # Task lifecycle messages subclass SystemMessage, so handle them first.
        if isinstance(message, (TaskStartedMessage, TaskProgressMessage, TaskNotificationMessage)):
            if message.tool_use_id:
                self._task_parents[message.task_id] = message.tool_use_id
            fields: dict[str, Any] = {
                "task_id": message.task_id,
                "parent_tool_use_id": self._task_parents.get(message.task_id),
            }
            if isinstance(message, TaskNotificationMessage):
                fields["parent_tool_use_id"] = self._task_parents.pop(message.task_id, None)
            if len(self._task_parents) > MAX_TRACKED_TASKS:
                self._task_parents.pop(next(iter(self._task_parents)))
            if isinstance(message, TaskStartedMessage):
                fields.update(description_preview=message.description, task_type=message.task_type)
            else:
                usage = message.usage
                if isinstance(usage, Mapping):
                    fields.update(
                        {
                            key: usage[key]
                            for key in ("total_tokens", "tool_uses", "duration_ms")
                            if key in usage and type(usage[key]) is int
                        }
                    )
                if isinstance(message, TaskNotificationMessage):
                    fields["status"] = message.status
                else:
                    fields["last_tool_name"] = message.last_tool_name
            # Omit task summaries, result text, progress descriptions and raw data.
            records.append(TrajectoryRecord("claude." + message.subtype.replace("_", "."), fields))
            return translation

        if isinstance(message, TaskUpdatedMessage):
            parent_id = (
                self._task_parents.pop(message.task_id, None)
                if message.status in TERMINAL_TASK_STATUSES
                else self._task_parents.get(message.task_id)
            )
            if message.status or message.patch.get("error"):
                records.append(
                    TrajectoryRecord(
                        "claude.task.updated",
                        {
                            "task_id": message.task_id,
                            "parent_tool_use_id": parent_id,
                            "status": message.status,
                            "error_preview": message.patch.get("error"),
                        },
                    )
                )
            return translation

        if isinstance(message, SystemMessage):
            if message.subtype == "init":
                self.init_info = dict(message.data)
                records.append(
                    TrajectoryRecord(
                        "claude.init",
                        {
                            "model": message.data.get("model"),
                            "tool_count": len(message.data.get("tools") or []),
                        },
                    )
                )
            elif message.subtype == "compact_boundary":
                events.append({"type": "context_compacted", "messageId": state.message_id})
                metadata = message.data.get("compact_metadata")
                if not isinstance(metadata, Mapping):
                    metadata = {}
                records.append(
                    TrajectoryRecord(
                        "claude.context.compacted",
                        {
                            "trigger": metadata.get("trigger"),
                            "pre_tokens": metadata.get("pre_tokens"),
                        },
                    )
                )
            return translation

        if isinstance(message, StreamEvent):
            if message.parent_tool_use_id:
                return translation
            raw = message.event
            kind = raw.get("type")
            if kind == "message_start":
                message_id = (raw.get("message") or {}).get("id")
                state.texts.append(_MessageText(message_id))
                if state.step_id is None:
                    state.step_id = str(uuid.uuid4())
                    events.append(
                        {
                            "type": "step_start",
                            "messageId": state.message_id,
                            "stepId": state.step_id,
                        }
                    )
            elif kind == "content_block_delta":
                delta = raw.get("delta") or {}
                if delta.get("type") == "text_delta" and delta.get("text"):
                    entry = state.texts[-1] if state.texts else state.entry_for(None)
                    entry.text += str(delta["text"])
                    events.extend(self._token_event(state))
            return translation

        if isinstance(message, AssistantMessage):
            final_text = ""
            if not message.parent_tool_use_id:
                if state.step_id is None:
                    state.step_id = str(uuid.uuid4())
                    events.append(
                        {
                            "type": "step_start",
                            "messageId": state.message_id,
                            "stepId": state.step_id,
                        }
                    )
                final_text = "".join(
                    block.text for block in message.content if isinstance(block, TextBlock)
                )
                if final_text:
                    entry = state.entry_for(message.message_id)
                    if len(final_text) > len(entry.text):
                        entry.text = final_text
                        events.extend(self._token_event(state))
            for block in message.content:
                if isinstance(block, ToolUseBlock):
                    state.tool_names[block.id] = _canonical_tool_name(block.name)
                    state.tool_args[block.id] = dict(block.input)
                    events.append(
                        self._tool_event(
                            state,
                            records,
                            call_id=block.id,
                            status="running",
                            output="",
                            parent_tool_use_id=message.parent_tool_use_id,
                        )
                    )
            if message.error:
                events.extend(
                    self._error_events(
                        state,
                        message.error,
                        records,
                        parent_tool_use_id=message.parent_tool_use_id,
                    )
                )
            key = (message.message_id, hash(final_text))
            if final_text and key not in state.assistant_messages:
                state.assistant_messages.add(key)
                records.append(
                    TrajectoryRecord(
                        "claude.assistant.message",
                        {"assistant_message_id": message.message_id, "text_preview": final_text},
                    )
                )
            return translation

        if isinstance(message, UserMessage):
            if isinstance(message.content, str):
                return translation
            for block in message.content:
                if isinstance(block, ToolResultBlock):
                    events.append(
                        self._tool_event(
                            state,
                            records,
                            call_id=block.tool_use_id,
                            status="error" if block.is_error else "completed",
                            output=_tool_result_text(block.content),
                            parent_tool_use_id=message.parent_tool_use_id,
                        )
                    )
            return translation

        if isinstance(message, RateLimitEvent):
            info = message.rate_limit_info
            if info.status in ("allowed_warning", "rejected"):
                detail = f"Anthropic rate limit {info.status}"
                if info.rate_limit_type:
                    detail += f" ({info.rate_limit_type})"
                if info.resets_at:
                    detail += f"; resets at {info.resets_at}"
                events.append(
                    self._provider_event(
                        records, {"type": "warning", "scope": "provider", "message": detail}
                    )
                )
            return translation

        if isinstance(message, ResultMessage):
            if (
                self._session_rotated
                and message.session_id
                and message.session_id != self.session_id
            ):
                records.append(
                    TrajectoryRecord(
                        "claude.session.rotated",
                        {
                            "agent_session_id": message.session_id,
                            "previous_session_id": self.session_id,
                        },
                    )
                )
                self.session_id = message.session_id
                self._session_rotated = False
            total = message.total_cost_usd
            if total is None:
                # No total means no baseline for the next turn either.
                message_cost = 0.0
                self.cost_baseline = None
                events.append(
                    self._provider_event(
                        records,
                        {
                            "type": "warning",
                            "scope": "provider",
                            "message": "The Claude agent reported no cost for this turn; it is recorded as 0.",
                        },
                    )
                )
            elif state.cost_baseline is None:
                # Neither turn can be charged when the previous share is unknowable.
                message_cost = 0.0
                self.cost_baseline = total
                events.append(
                    self._provider_event(
                        records,
                        {
                            "type": "warning",
                            "scope": "provider",
                            "message": (
                                "The Claude agent reported no cost for the previous turn, so this "
                                "turn's cost cannot be separated from it; it is recorded as 0."
                            ),
                        },
                    )
                )
            else:
                message_cost = max(total - state.cost_baseline, 0.0)
                self.cost_baseline = total
            finish: BridgeEvent = {
                "type": "step_finish",
                "messageId": state.message_id,
                "stepId": state.step_id or str(uuid.uuid4()),
                "cost": message_cost,
                "messageCostUsd": message_cost,
                "reason": message.subtype,
            }
            tokens = _usage_tokens(message.usage)
            if tokens:
                finish["tokens"] = tokens
            events.append(finish)
            log_tokens: dict[str, Any] = {
                key: value
                for key, value in (tokens or {}).items()
                if key in ("input", "output") and type(value) is int
            }
            cache = {
                key: value
                for key, value in ((tokens or {}).get("cache") or {}).items()
                if type(value) is int
            }
            if cache:
                log_tokens["cache"] = cache
            translation.result = SdkTurnResult(
                status=message.subtype,
                is_error=message.is_error,
                duration_ms=message.duration_ms,
                duration_api_ms=message.duration_api_ms,
                num_turns=message.num_turns,
                total_cost_usd=message.total_cost_usd,
                tokens=log_tokens or None,
            )
            if interrupted:
                translation.outcome = TurnOutcome(
                    success=False,
                    error="Task was cancelled",
                    cancelled=True,
                    message_cost_usd=message_cost,
                )
            elif message.is_error or message.subtype != "success":
                detail = message.result or "; ".join(message.errors or []) or message.subtype
                if not state.emitted_error:
                    events.append(
                        self._provider_event(
                            records,
                            {"type": "error", "error": str(detail), "messageId": state.message_id},
                        )
                    )
                translation.outcome = TurnOutcome.failed(str(detail), message_cost_usd=message_cost)
            else:
                translation.outcome = TurnOutcome.ok(message_cost_usd=message_cost)
            return translation

        return translation

    def _belongs_to_injected_turn(
        self, state: ClaudeTurnState, message: Message, records: list[TrajectoryRecord]
    ) -> bool:
        """Filter CLI-injected turns, whose opening user and closing result have origin.

        The messages between those boundaries have no origin. Injected spend
        remains in the running total and lands on the prompt in flight.
        """
        if isinstance(message, UserMessage):
            if (origin := _injected_origin(message.origin)) is not None:
                state.injected = True
                records.append(
                    TrajectoryRecord(
                        "claude.injected_turn_started", {"origin_kind": origin["kind"]}
                    )
                )
            return state.injected
        if isinstance(message, ResultMessage):
            if (origin := _injected_origin(message.origin)) is not None:
                state.injected = False
                records.append(
                    TrajectoryRecord(
                        "claude.injected_turn_ignored", {"origin_kind": origin["kind"]}
                    )
                )
                return True
            state.injected = False
            return False
        return state.injected

    def _token_event(self, state: ClaudeTurnState) -> list[BridgeEvent]:
        content = state.turn_text()
        if not content or content == state.last_token_content:
            return []
        state.last_token_content = content
        return [{"type": "token", "content": content, "messageId": state.message_id}]

    def _tool_event(
        self,
        state: ClaudeTurnState,
        records: list[TrajectoryRecord],
        *,
        call_id: str,
        status: Literal["running", "completed", "error"],
        output: str,
        parent_tool_use_id: str | None,
    ) -> BridgeEvent:
        tool = state.tool_names.get(call_id, "tool")
        args = state.tool_args.get(call_id, {})
        event: BridgeEvent = {
            "type": "tool_call",
            "tool": tool,
            "args": args,
            "callId": call_id,
            "status": status,
            "output": output,
            "messageId": state.message_id,
        }
        if parent_tool_use_id:
            event["isSubtask"] = True
            event["taskCallId"] = parent_tool_use_id
        name = {"running": "started", "completed": "completed", "error": "failed"}[status]
        preview = {"args_preview": args} if status == "running" else {"output_preview": output}
        records.append(
            TrajectoryRecord(
                f"claude.tool.{name}",
                {
                    "tool": tool,
                    "call_id": call_id,
                    "status": status,
                    "parent_tool_use_id": parent_tool_use_id or None,
                    **preview,
                },
            )
        )
        return event

    def _provider_event(
        self,
        records: list[TrajectoryRecord],
        event: BridgeEvent,
        *,
        parent_tool_use_id: str | None = None,
    ) -> BridgeEvent:
        records.append(
            TrajectoryRecord(
                "claude.provider.warning",
                {
                    "status": event["type"],
                    "parent_tool_use_id": parent_tool_use_id,
                    "diagnostic_preview": event.get("message", event.get("error", "")),
                },
            )
        )
        return event

    def _error_events(
        self,
        state: ClaudeTurnState,
        error: str,
        records: list[TrajectoryRecord],
        *,
        parent_tool_use_id: str | None,
    ) -> list[BridgeEvent]:
        if error == "authentication_failed":
            if state.emitted_error:
                return []
            state.emitted_error = True
            # No account-state mutation here: the sandbox is not authoritative.
            return [
                self._provider_event(
                    records,
                    {
                        "type": "error",
                        "error": AUTHENTICATION_FAILED_MESSAGE,
                        "messageId": state.message_id,
                    },
                    parent_tool_use_id=parent_tool_use_id,
                )
            ]
        return [
            self._provider_event(
                records,
                {
                    "type": "warning",
                    "scope": "provider",
                    "message": f"Anthropic reported {error.replace('_', ' ')} on this turn.",
                },
                parent_tool_use_id=parent_tool_use_id,
            )
        ]

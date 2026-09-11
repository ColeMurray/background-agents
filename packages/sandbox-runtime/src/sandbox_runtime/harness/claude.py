"""``AgentHarness`` over the Claude Agent SDK.

The SDK spawns the ``claude`` binary as a child of the bridge process. This
module owns that child: it launches it through the clean-environment wrapper
(``claude_env.py``), holds the one credential in memory, translates SDK
messages into bridge events, applies the cost-baseline rule, and reconnects
with ``resume=`` when the transport drops. It never emits
``execution_complete``; the bridge terminalises every turn from the
``TurnOutcome`` returned here.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Final, Protocol

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    ConversationResetMessage,
    MessageOrigin,
    RateLimitEvent,
    ResultMessage,
    StreamEvent,
    SystemMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from ..credentials.provider_credential_client import (
    RuntimeCredentialClient,
    RuntimeCredentialDenied,
    RuntimeCredentialUnavailable,
)
from .base import (
    BridgeEvent,
    EventSink,
    HarnessId,
    HarnessPrompt,
    HarnessStartError,
    PromptLimits,
    TurnOutcome,
)
from .claude_env import (
    ClaudeCredential,
    bundled_claude_binary,
    harness_env,
    resolve_api_key_credential,
    write_clean_env_wrapper,
)
from .claude_tools import OI_TOOL_SERVER_NAME, ControlPlaneToolClient, ToolServerConfig

if TYPE_CHECKING:
    from pathlib import Path

    from ..log_config import StructuredLogger

# Models whose catalog efforts are the two-value ladder; they take an explicit
# thinking budget (the same budgets OpenCode configures) rather than `effort=`.
THINKING_BUDGET_MODELS: Final = frozenset(
    {"claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-5"}
)
THINKING_BUDGETS: Final = {"high": 16_000, "max": 31_999}
EFFORT_LEVELS: Final = frozenset({"low", "medium", "high", "xhigh", "max"})

# Everything the child may call; `dontAsk` approves what is listed and denies the rest.
ALLOWED_TOOLS: Final = (
    "Read",
    "Edit",
    "MultiEdit",
    "Write",
    "Bash",
    "Glob",
    "Grep",
    "LS",
    "Agent",
    "Skill",
    "WebFetch",
    "WebSearch",
    "TodoWrite",
    "TaskCreate",
    "TaskUpdate",
    "TaskList",
    "NotebookEdit",
    "BashOutput",
    "KillShell",
)
DISALLOWED_TOOLS: Final = ("AskUserQuestion",)
# Claude's sub-agent tool. The timeline groups child activity under the
# runtime-neutral task tool, so the vendor name never reaches the wire.
SUBAGENT_TOOL_NAME: Final = "Agent"
TASK_TOOL_NAME: Final = "task"
MAX_RECONNECTS_PER_SESSION: Final = 3
AUTHENTICATION_FAILED_MESSAGE: Final = (
    "Anthropic rejected this session's credential. Reconnect the Claude account in "
    "Settings (or check ANTHROPIC_API_KEY) and start a new session."
)


class SdkClient(Protocol):
    """The slice of ``ClaudeSDKClient`` the harness uses (a fake stands in for tests)."""

    async def connect(self) -> None: ...

    async def disconnect(self) -> None: ...

    async def query(self, prompt: Any, session_id: str = "default") -> None: ...

    async def interrupt(self) -> None: ...

    def receive_messages(self) -> AsyncIterator[Any]: ...


SdkClientFactory = Callable[[Any], SdkClient]


@dataclass(frozen=True)
class ClaudeHarnessConfig:
    workdir: Path
    config_dir: Path
    mcp_servers: tuple[Mapping[str, Any], ...]
    default_model: str
    oauth_managed: bool
    # Appended to the claude_code preset system prompt (repo guidance notes).
    system_prompt_append: str | None = None
    tools: ToolServerConfig | None = None


@dataclass
class _MessageText:
    message_id: str | None
    text: str = ""


def _injected_origin(origin: MessageOrigin | None) -> MessageOrigin | None:
    """The origin when it names a turn the session started on its own."""
    if origin is None or origin.get("kind") == "human":
        return None
    return origin


@dataclass
class _TurnState:
    message_id: str
    # None: the previous turn reported no running total, so the next total
    # cannot be split between the two turns.
    cost_baseline: float | None
    texts: list[_MessageText] = field(default_factory=list)
    last_token_content: str = ""
    tool_names: dict[str, str] = field(default_factory=dict)
    tool_args: dict[str, dict[str, Any]] = field(default_factory=dict)
    emitted_error: bool = False
    step_started: bool = False
    # Inside a turn the session injected (background task, channel, peer):
    # skip everything until that turn's result.
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


def bare_model_id(model: str | None, default: str) -> str:
    """``anthropic/claude-x`` → ``claude-x``; a bare id passes through."""
    value = model or default
    if "/" in value:
        provider, _, bare = value.partition("/")
        if provider != "anthropic":
            raise ValueError(f"The Claude harness cannot run provider {provider!r}")
        return bare
    return value


def reasoning_options(model: str, reasoning_effort: str | None) -> dict[str, Any]:
    """Per-model reasoning controls, in ``ClaudeAgentOptions`` keywords."""
    if not reasoning_effort or reasoning_effort == "none":
        return {}
    if model in THINKING_BUDGET_MODELS:
        budget = THINKING_BUDGETS.get(reasoning_effort)
        return {"thinking": {"type": "enabled", "budget_tokens": budget}} if budget else {}
    return {"effort": reasoning_effort} if reasoning_effort in EFFORT_LEVELS else {}


def mcp_server_options(servers: tuple[Mapping[str, Any], ...]) -> dict[str, Any]:
    """Session MCP servers in the SDK's config shape."""
    config: dict[str, Any] = {}
    for server in servers:
        name = server.get("name")
        if not name or server.get("enabled") is False:
            continue
        if server.get("type") == "remote":
            entry: dict[str, Any] = {"type": "http", "url": server.get("url", "")}
            headers = server.get("headers") or server.get("env") or {}
            if headers:
                entry["headers"] = dict(headers)
        else:
            command = list(server.get("command") or [])
            if not command:
                continue
            entry = {"type": "stdio", "command": command[0], "args": command[1:]}
            if server.get("env"):
                entry["env"] = dict(server["env"])
        config[str(name)] = entry
    return config


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


class ClaudeHarness:
    id = HarnessId.CLAUDE

    def __init__(
        self,
        *,
        config: ClaudeHarnessConfig,
        log: StructuredLogger,
        limits: PromptLimits,
        credential_client: RuntimeCredentialClient | None = None,
        environ: Mapping[str, str] | None = None,
        client_factory: SdkClientFactory | None = None,
        options_factory: Callable[..., Any] | None = None,
        tool_server_factory: Callable[[ControlPlaneToolClient], Any] | None = None,
        transcript_exists: Callable[[str, Path, Path], bool] | None = None,
        binary: Path | None = None,
    ) -> None:
        self.config = config
        self.log = log
        self.limits = limits
        self.credential_client = credential_client
        self.environ = environ if environ is not None else os.environ
        self._client_factory = client_factory
        self._options_factory = options_factory
        self._tool_server_factory = tool_server_factory
        self._transcript_exists = transcript_exists or _default_transcript_exists
        self._binary = binary

        self.session_id: str | None = None
        self.credential: ClaudeCredential | None = None
        self.wrapper_path: Path | None = None
        self._client: SdkClient | None = None
        self._connected_model: str | None = None
        self._connected_effort: str | None = None
        self._resume_on_connect = False
        self._needs_reconnect = False
        self._reconnects = 0
        self._cost_baseline: float | None = 0.0
        # Set by a conversation reset: the next result carries the new id.
        self._session_rotated = False
        self._interrupted = False
        self._tool_client: ControlPlaneToolClient | None = None
        self._tool_server: Any = None
        self.init_info: dict[str, Any] | None = None

    # --- lifecycle -----------------------------------------------------------

    async def open(self) -> None:
        """Resolve the credential and generate the clean-env wrapper.

        A credential denial is deterministic (``HarnessStartError``); a
        transient control-plane failure is an ordinary error the supervisor's
        bridge restart budget covers.
        """
        self.credential = await self._resolve_credential()
        binary = self._binary or bundled_claude_binary()
        self.wrapper_path = write_clean_env_wrapper(
            self.config.config_dir / "bin", mode=self.credential.mode, binary=binary
        )
        if self.config.tools is not None and self._tool_client is None:
            self._tool_client = ControlPlaneToolClient(self.config.tools, self.log)
        self.log.info(
            "claude.open",
            auth_mode=self.credential.mode.value,
            config_dir=str(self.config.config_dir),
            workdir=str(self.config.workdir),
        )

    async def _resolve_credential(self) -> ClaudeCredential:
        if self.config.oauth_managed:
            if self.credential_client is None:
                raise HarnessStartError(
                    "This session uses a connected Claude account but the runtime has no "
                    "credential endpoint configured."
                )
            try:
                issued = await self.credential_client.fetch("anthropic")
            except RuntimeCredentialDenied as error:
                raise HarnessStartError(str(error)) from error
            except RuntimeCredentialUnavailable as error:
                raise RuntimeError(f"Claude credential unavailable: {error}") from error
            return ClaudeCredential.oauth_token(issued.secret)
        credential = resolve_api_key_credential(self.environ)
        if credential is None:
            raise HarnessStartError(
                "No Anthropic credential is available to this session: set ANTHROPIC_API_KEY "
                "or select a connected Claude account, then start a new session."
            )
        return credential

    async def close(self) -> None:
        await self._disconnect()
        if self._tool_client is not None:
            await self._tool_client.aclose()
            self._tool_client = None

    async def resume_session(self, persisted_id: str) -> bool:
        if not self._transcript_exists(persisted_id, self.config.workdir, self.config.config_dir):
            self.log.info("claude.session.invalid", agent_session_id=persisted_id)
            return False
        self.session_id = persisted_id
        self._resume_on_connect = True
        self.log.info("claude.session.ensure", agent_session_id=persisted_id, action="loaded")
        return True

    async def create_session(self) -> None:
        self.session_id = str(uuid.uuid4())
        self._resume_on_connect = False
        self.log.info("claude.session.ensure", agent_session_id=self.session_id, action="created")

    # --- connection ------------------------------------------------------------

    def build_options(self, model: str, reasoning_effort: str | None) -> Any:
        """``ClaudeAgentOptions`` from the session's inputs (§5.1 of the design)."""
        if self.credential is None or self.wrapper_path is None or self.session_id is None:
            raise RuntimeError("Claude harness is not open")
        mcp_servers: dict[str, Any] = mcp_server_options(self.config.mcp_servers)
        allowed_tools = [*ALLOWED_TOOLS]
        allowed_tools.extend(f"mcp__{name}__*" for name in mcp_servers)
        if self._tool_client is not None:
            if self._tool_server is None:
                factory = self._tool_server_factory or _default_tool_server
                self._tool_server = factory(self._tool_client)
            mcp_servers[OI_TOOL_SERVER_NAME] = self._tool_server
            allowed_tools.append(f"mcp__{OI_TOOL_SERVER_NAME}__*")
        system_prompt: dict[str, Any] = {"type": "preset", "preset": "claude_code"}
        if self.config.system_prompt_append:
            system_prompt["append"] = self.config.system_prompt_append
        kwargs: dict[str, Any] = {
            "cwd": str(self.config.workdir),
            "cli_path": str(self.wrapper_path),
            "env": harness_env(self.config.config_dir, self.credential),
            "model": model,
            "mcp_servers": mcp_servers,
            "allowed_tools": allowed_tools,
            "disallowed_tools": [*DISALLOWED_TOOLS],
            "permission_mode": "dontAsk",
            "system_prompt": system_prompt,
            "setting_sources": ["user", "project"],
            "include_partial_messages": True,
            "forward_subagent_text": False,
            **reasoning_options(model, reasoning_effort),
        }
        if self._resume_on_connect:
            kwargs["resume"] = self.session_id
        else:
            kwargs["session_id"] = self.session_id
        build_options = self._options_factory or _default_options_factory
        return build_options(**kwargs)

    async def _ensure_client(self, model: str, reasoning_effort: str | None) -> SdkClient:
        same_shape = (
            self._client is not None
            and self._connected_model == model
            and self._connected_effort == reasoning_effort
            and not self._needs_reconnect
        )
        if same_shape and self._client is not None:
            return self._client
        if self._needs_reconnect:
            # Spent whether or not the previous attempt produced a client: a
            # connect that fails or hangs still counts against the budget.
            self._reconnects += 1
            if self._reconnects > MAX_RECONNECTS_PER_SESSION:
                raise RuntimeError(
                    "The Claude agent process failed repeatedly for this session; "
                    "start a new session."
                )
        await self._disconnect()
        options = self.build_options(model, reasoning_effort)
        factory = self._client_factory or _default_client_factory
        client = factory(options)
        # Held before connect so a connect the deadline cuts short is still
        # closed by the next reconnect rather than leaked.
        self._client = client
        await client.connect()
        self._connected_model = model
        self._connected_effort = reasoning_effort
        self._needs_reconnect = False
        # A fresh child starts its running total at zero (§5.3 baseline rule).
        self._cost_baseline = 0.0
        self.log.info(
            "claude.connected",
            model=model,
            reasoning_effort=reasoning_effort,
            resume=self._resume_on_connect,
        )
        # Every later (re)connect resumes the transcript this child writes.
        self._resume_on_connect = True
        return client

    async def _disconnect(self) -> None:
        client, self._client = self._client, None
        if client is None:
            return
        try:
            await client.disconnect()
        except Exception as error:
            self.log.warn("claude.disconnect_error", exc=error)

    # --- prompt ------------------------------------------------------------

    async def run_prompt(self, prompt: HarnessPrompt, emit: EventSink) -> TurnOutcome:
        try:
            model = bare_model_id(prompt.model, self.config.default_model)
        except ValueError as error:
            return TurnOutcome.failed(str(error))
        # One budget covers the whole turn: connect, submit, every read and
        # every emit. The inactivity budget applies to each read alone, and
        # cleanup after either has its own budget, so a hung SDK call can
        # never eat the snapshot reserve.
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.limits.prompt_max_duration_seconds
        try:
            async with asyncio.timeout_at(deadline):
                client = await self._ensure_client(model, prompt.reasoning_effort)
        except HarnessStartError:
            raise
        except TimeoutError:
            self.log.error("claude.connect_timeout", message_id=prompt.message_id)
            self._needs_reconnect = True
            await self._interrupt_within_budget()
            return TurnOutcome.failed(
                f"Claude agent did not start within {self.limits.prompt_max_duration_seconds:.0f}s."
            )
        except Exception as error:
            self.log.error("claude.connect_error", exc=error, message_id=prompt.message_id)
            self._needs_reconnect = True
            return TurnOutcome.failed(f"Claude agent failed to start: {error}")

        self._interrupted = False
        state = _TurnState(message_id=prompt.message_id, cost_baseline=self._cost_baseline)
        try:
            async with asyncio.timeout_at(deadline):
                await client.query(self._user_messages(prompt))
                stream = aiter(client.receive_messages())
                while True:
                    try:
                        async with asyncio.timeout(self.limits.inactivity_timeout_seconds):
                            message = await anext(stream)
                    except StopAsyncIteration:
                        break
                    except TimeoutError as error:
                        raise _InactivityTimeout from error
                    if self._belongs_to_injected_turn(state, message):
                        continue
                    events, outcome = self._translate(state, message)
                    for event in events:
                        await emit(event)
                    if outcome is not None:
                        return outcome
            self._needs_reconnect = True
            return TurnOutcome.failed(
                "The Claude agent stream ended before the turn completed.",
                message_cost_usd=None,
            )
        except asyncio.CancelledError:
            self._needs_reconnect = True
            raise
        except TimeoutError:
            await self._interrupt_within_budget()
            self._needs_reconnect = True
            return TurnOutcome.failed(
                f"Prompt exceeded max duration of {self.limits.prompt_max_duration_seconds:.0f}s."
            )
        except _InactivityTimeout:
            await self._interrupt_within_budget()
            self._needs_reconnect = True
            return TurnOutcome.failed(
                f"Claude agent produced no output for {self.limits.inactivity_timeout_seconds:.0f}s."
            )
        except Exception as error:
            self.log.error("claude.turn_error", exc=error, message_id=prompt.message_id)
            self._needs_reconnect = True
            return TurnOutcome.failed(f"Claude agent transport failed: {error}")

    def _belongs_to_injected_turn(self, state: _TurnState, message: Any) -> bool:
        """Every message of a turn the session injected, not of this prompt.

        The streaming connection can interleave turns the CLI starts on its
        own (task notifications, channel and peer messages). Only the user
        message that opens such a turn and the result that closes it carry
        ``origin``; the assistant messages, stream events and tool results
        between them do not. So a non-human user message opens the skip, its
        result closes it, and nothing in between reaches the timeline. Our
        own prompts are stamped ``origin: human``. The injected turn's spend
        stays in the running total and lands on the prompt in flight, so the
        session's cost still adds up.
        """
        if isinstance(message, UserMessage):
            if (origin := _injected_origin(message.origin)) is not None:
                state.injected = True
                self.log.info("claude.injected_turn_started", origin_kind=origin["kind"])
            return state.injected
        if isinstance(message, ResultMessage):
            if (origin := _injected_origin(message.origin)) is not None:
                state.injected = False
                self.log.info("claude.injected_turn_ignored", origin_kind=origin["kind"])
                return True
            state.injected = False
            return False
        return state.injected

    async def _interrupt_within_budget(self) -> bool:
        """Interrupt within the cleanup budget; drop the child if that hangs too.

        True when the child acknowledged the interrupt.
        """
        budget = self.limits.prompt_cleanup_timeout_seconds
        try:
            async with asyncio.timeout(budget):
                return await self._interrupt_quietly()
        except TimeoutError:
            self.log.warn("claude.interrupt_timeout", timeout_s=budget)
        try:
            async with asyncio.timeout(budget):
                await self._disconnect()
        except TimeoutError:
            self.log.warn("claude.disconnect_timeout", timeout_s=budget)
            self._client = None
        return False

    async def _interrupt_quietly(self) -> bool:
        if self._client is None:
            return False
        try:
            await self._client.interrupt()
        except Exception as error:
            self.log.warn("claude.interrupt_error", exc=error)
            return False
        return True

    async def abort(self) -> bool:
        if self._client is None:
            return False
        self._interrupted = True
        # The bridge cancels the prompt task too; the next prompt reconnects so
        # the interrupted turn's trailing messages never leak into it.
        self._needs_reconnect = True
        # The bridge awaits this inline on its command loop, so a hung
        # interrupt would stall every later command; bound it like cleanup.
        return await self._interrupt_within_budget()

    async def _user_messages(self, prompt: HarnessPrompt) -> AsyncIterator[dict[str, Any]]:
        content: list[dict[str, Any]] = [{"type": "text", "text": prompt.text}]
        for attachment in prompt.attachments:
            content.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": attachment["mimeType"],
                        "data": attachment["content"],
                    },
                }
            )
        yield {
            "type": "user",
            "message": {"role": "user", "content": content},
            "parent_tool_use_id": None,
            "session_id": self.session_id,
            # Lets the result of this prompt be told apart from injected turns.
            "origin": {"kind": "human"},
        }

    # --- translation (§5.2) -------------------------------------------------

    def _translate(
        self, state: _TurnState, message: Any
    ) -> tuple[list[BridgeEvent], TurnOutcome | None]:
        events: list[BridgeEvent] = []
        if isinstance(message, SystemMessage):
            if message.subtype == "init":
                self.init_info = dict(message.data)
                self.log.info(
                    "claude.init",
                    model=message.data.get("model"),
                    tool_count=len(message.data.get("tools") or []),
                )
            elif message.subtype == "compact_boundary":
                events.append({"type": "context_compacted", "messageId": state.message_id})
            return events, None

        if isinstance(message, StreamEvent):
            if message.parent_tool_use_id:
                return events, None
            raw = message.event
            kind = raw.get("type")
            if kind == "message_start":
                message_id = (raw.get("message") or {}).get("id")
                state.texts.append(_MessageText(message_id))
                if not state.step_started:
                    state.step_started = True
                    events.append({"type": "step_start", "messageId": state.message_id})
            elif kind == "content_block_delta":
                delta = raw.get("delta") or {}
                if delta.get("type") == "text_delta" and delta.get("text"):
                    entry = state.texts[-1] if state.texts else state.entry_for(None)
                    entry.text += str(delta["text"])
                    events.extend(self._token_event(state))
            return events, None

        if isinstance(message, AssistantMessage):
            is_subtask = bool(message.parent_tool_use_id)
            if not is_subtask:
                if not state.step_started:
                    state.step_started = True
                    events.append({"type": "step_start", "messageId": state.message_id})
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
                    state.tool_names[block.id] = (
                        TASK_TOOL_NAME if block.name == SUBAGENT_TOOL_NAME else block.name
                    )
                    state.tool_args[block.id] = dict(block.input)
                    events.append(
                        self._tool_event(
                            state,
                            call_id=block.id,
                            status="running",
                            output="",
                            parent_tool_use_id=message.parent_tool_use_id,
                        )
                    )
            if message.error:
                events.extend(self._error_events(state, message.error))
            return events, None

        if isinstance(message, UserMessage):
            if isinstance(message.content, str):
                return events, None
            for block in message.content:
                if isinstance(block, ToolResultBlock):
                    events.append(
                        self._tool_event(
                            state,
                            call_id=block.tool_use_id,
                            status="error" if block.is_error else "completed",
                            output=_tool_result_text(block.content),
                            parent_tool_use_id=message.parent_tool_use_id,
                        )
                    )
            return events, None

        if isinstance(message, RateLimitEvent):
            info = message.rate_limit_info
            if info.status in ("allowed_warning", "rejected"):
                detail = f"Anthropic rate limit {info.status}"
                if info.rate_limit_type:
                    detail += f" ({info.rate_limit_type})"
                if info.resets_at:
                    detail += f"; resets at {info.resets_at}"
                events.append({"type": "warning", "scope": "provider", "message": detail})
            return events, None

        if isinstance(message, ConversationResetMessage):
            # The running total restarts, and the messages that follow carry
            # the new session id the next resume and snapshot must use.
            self._cost_baseline = 0.0
            state.cost_baseline = 0.0
            self._session_rotated = True
            return events, None

        if isinstance(message, ResultMessage):
            if (
                self._session_rotated
                and message.session_id
                and message.session_id != self.session_id
            ):
                self.log.info(
                    "claude.session.rotated",
                    agent_session_id=message.session_id,
                    previous_session_id=self.session_id,
                )
                self.session_id = message.session_id
                self._session_rotated = False
            total = message.total_cost_usd
            if total is None:
                # No total means no baseline for the next turn either.
                message_cost = 0.0
                self._cost_baseline = None
                events.append(
                    {
                        "type": "warning",
                        "scope": "provider",
                        "message": "The Claude agent reported no cost for this turn; it is recorded as 0.",
                    }
                )
            elif state.cost_baseline is None:
                # The previous turn's share of this total is unknowable, so
                # neither turn is charged and the baseline re-anchors here.
                message_cost = 0.0
                self._cost_baseline = total
                events.append(
                    {
                        "type": "warning",
                        "scope": "provider",
                        "message": (
                            "The Claude agent reported no cost for the previous turn, so this "
                            "turn's cost cannot be separated from it; it is recorded as 0."
                        ),
                    }
                )
            else:
                message_cost = max(total - state.cost_baseline, 0.0)
                self._cost_baseline = total
            finish: BridgeEvent = {
                "type": "step_finish",
                "messageId": state.message_id,
                "cost": message_cost,
                "messageCostUsd": message_cost,
                "reason": message.subtype,
            }
            tokens = _usage_tokens(message.usage)
            if tokens:
                finish["tokens"] = tokens
            events.append(finish)
            if self._interrupted:
                return events, TurnOutcome(
                    success=False,
                    error="Task was cancelled",
                    cancelled=True,
                    message_cost_usd=message_cost,
                )
            if message.is_error or message.subtype != "success":
                detail = message.result or "; ".join(message.errors or []) or message.subtype
                if not state.emitted_error:
                    events.append(
                        {"type": "error", "error": str(detail), "messageId": state.message_id}
                    )
                return events, TurnOutcome.failed(str(detail), message_cost_usd=message_cost)
            return events, TurnOutcome.ok(message_cost_usd=message_cost)

        return events, None

    def _token_event(self, state: _TurnState) -> list[BridgeEvent]:
        content = state.turn_text()
        if not content or content == state.last_token_content:
            return []
        state.last_token_content = content
        return [{"type": "token", "content": content, "messageId": state.message_id}]

    def _tool_event(
        self,
        state: _TurnState,
        *,
        call_id: str,
        status: str,
        output: str,
        parent_tool_use_id: str | None,
    ) -> BridgeEvent:
        event: BridgeEvent = {
            "type": "tool_call",
            "tool": state.tool_names.get(call_id, "tool"),
            "args": state.tool_args.get(call_id, {}),
            "callId": call_id,
            "status": status,
            "output": output,
            "messageId": state.message_id,
        }
        if parent_tool_use_id:
            event["isSubtask"] = True
            event["taskCallId"] = parent_tool_use_id
        return event

    def _error_events(self, state: _TurnState, error: str) -> list[BridgeEvent]:
        if error == "authentication_failed":
            if state.emitted_error:
                return []
            state.emitted_error = True
            # No account-state mutation here: the sandbox is not authoritative.
            return [
                {
                    "type": "error",
                    "error": AUTHENTICATION_FAILED_MESSAGE,
                    "messageId": state.message_id,
                }
            ]
        return [
            {
                "type": "warning",
                "scope": "provider",
                "message": f"Anthropic reported {error.replace('_', ' ')} on this turn.",
            }
        ]


class _InactivityTimeout(Exception):
    pass


def _default_transcript_exists(session_id: str, workdir: Path, config_dir: Path) -> bool:
    """Whether the child wrote a transcript for ``session_id`` under ``config_dir``.

    The SDK's ``get_session_info`` resolves the projects directory from the
    *bridge's* ``CLAUDE_CONFIG_DIR``, which is never set: the config dir only
    reaches the child through ``options.env``. Look under the directory the
    child actually writes to. Session ids are UUIDs, so a glob across project
    directories is unambiguous and immune to path-canonicalisation drift
    between ``workdir`` and the child's realpath.
    """
    try:
        uuid.UUID(session_id)
    except ValueError:
        return False
    projects = config_dir / "projects"
    if not projects.is_dir():
        return False
    del workdir  # informational; the transcript is keyed by session id
    return any(path.is_file() for path in projects.glob(f"*/{session_id}.jsonl"))


def _default_options_factory(**kwargs: Any) -> Any:
    return ClaudeAgentOptions(**kwargs)


def _default_client_factory(options: Any) -> SdkClient:
    return ClaudeSDKClient(options=options)


def _default_tool_server(client: ControlPlaneToolClient) -> Any:
    from .claude_tools import build_tool_server

    return build_tool_server(client)

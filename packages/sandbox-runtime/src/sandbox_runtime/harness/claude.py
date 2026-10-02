"""``AgentHarness`` over the Claude Agent SDK.

The SDK spawns the ``claude`` binary as a child of the bridge process. This
module owns that child: it launches it through the clean-environment wrapper
(``claude_env.py``), holds the one credential in memory, delivers translated
bridge events, and reconnects with ``resume=`` when the transport drops. It
never emits ``execution_complete``; the bridge terminalises every turn from
the ``TurnOutcome`` returned here.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Final, Protocol

from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

from ..attachment_processor import (
    MAX_SESSION_ATTACHMENTS_PER_MESSAGE,
    AttachmentProcessor,
)
from ..credentials.provider_credential_client import (
    RuntimeCredentialClient,
    RuntimeCredentialDenied,
    RuntimeCredentialUnavailable,
)
from .base import (
    EventSink,
    HarnessId,
    HarnessPrompt,
    HarnessStartError,
    PromptLimits,
    TurnOutcome,
)
from .claude_env import (
    CLAUDE_POLICY_SETTINGS,
    ClaudeCredential,
    bundled_claude_binary,
    harness_env,
    resolve_api_key_credential,
    write_clean_env_wrapper,
)
from .claude_logging import ClaudeTrajectoryLogger
from .claude_tools import OI_TOOL_SERVER_NAME, ControlPlaneToolClient, ToolServerConfig
from .claude_translate import ClaudeTranslator, ClaudeTurnState

if TYPE_CHECKING:
    from pathlib import Path

    from claude_agent_sdk import Message

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
MAX_RECONNECTS_PER_SESSION: Final = 3
# The CLI writes one NDJSON message per stdout line, and the SDK transport
# fails the turn when a single line outgrows its buffer, so the ceiling has to
# cover the largest line the runtime can produce. ``_user_messages`` inlines
# every attachment on a prompt as base64 and the CLI echoes that message back,
# which makes the whole per-message attachment budget one line. Derive the
# ceiling from that budget rather than pick a round number: the SDK's 1MiB
# default breaks on an ordinary screenshot, and any fixed value silently
# falls behind when the attachment limits move.
# Each attachment is encoded on its own, so the padding is per attachment too.
_ATTACHMENT_BASE64_BYTES: Final = MAX_SESSION_ATTACHMENTS_PER_MESSAGE * (
    (AttachmentProcessor.MAX_IMAGE_BYTES + 2) // 3 * 4
)
# Room for the JSON envelope, the prompt text beside the image blocks, and
# tool-result lines that carry images the runtime never sized.
_STDOUT_MESSAGE_HEADROOM_BYTES: Final = 16 * 1024 * 1024
# Bounds one line; the transport only buffers what actually arrives.
MAX_STDOUT_MESSAGE_BYTES: Final = _ATTACHMENT_BASE64_BYTES + _STDOUT_MESSAGE_HEADROOM_BYTES


class SdkClient(Protocol):
    """The slice of ``ClaudeSDKClient`` the harness uses (a fake stands in for tests)."""

    async def connect(self) -> None: ...

    async def disconnect(self) -> None: ...

    async def query(self, prompt: Any, session_id: str = "default") -> None: ...

    async def interrupt(self) -> None: ...

    def receive_messages(self) -> AsyncIterator[Message]: ...


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
        self._translator = ClaudeTranslator()
        self._trajectory = ClaudeTrajectoryLogger(
            log,
            self.environ,
            config.mcp_servers,
            config.tools.auth_token if config.tools else None,
        )
        self._client_factory = client_factory
        self._options_factory = options_factory
        self._tool_server_factory = tool_server_factory
        self._transcript_exists = transcript_exists or _default_transcript_exists
        self._binary = binary

        self.credential: ClaudeCredential | None = None
        self.wrapper_path: Path | None = None
        self._client: SdkClient | None = None
        self._client_lifecycle_lock = asyncio.Lock()
        self._connected_model: str | None = None
        self._connected_effort: str | None = None
        self._resume_on_connect = False
        self._needs_reconnect = False
        self._reconnects = 0
        self._interrupted = False
        self._tool_client: ControlPlaneToolClient | None = None
        self._tool_server: Any = None

    @property
    def session_id(self) -> str | None:
        return self._translator.session_id

    @session_id.setter
    def session_id(self, value: str | None) -> None:
        self._translator.session_id = value

    @property
    def init_info(self) -> dict[str, Any] | None:
        return self._translator.init_info

    # --- lifecycle -----------------------------------------------------------

    async def open(self) -> None:
        """Resolve the credential and generate the clean-env wrapper.

        A credential denial is deterministic (``HarnessStartError``); a
        transient control-plane failure is an ordinary error the supervisor's
        bridge restart budget covers.
        """
        self.credential = await self._resolve_credential()
        self._trajectory.add_credentials(self.credential.env.values())
        binary = self._binary or bundled_claude_binary()
        self.wrapper_path = write_clean_env_wrapper(
            self.config.config_dir / "bin", mode=self.credential.mode, binary=binary
        )
        if self.config.tools is not None and self._tool_client is None:
            self._tool_client = ControlPlaneToolClient(self.config.tools, self.log)
        self._trajectory.diagnostic(
            "claude.open",
            content_logging=self._trajectory.content_logging,
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
            self._trajectory.diagnostic("claude.session.invalid", agent_session_id=persisted_id)
            return False
        self.session_id = persisted_id
        self._trajectory.reset_session(persisted_id)
        self._translator.reset_tracking()
        self._resume_on_connect = True
        self._trajectory.diagnostic(
            "claude.session.ensure", agent_session_id=persisted_id, action="loaded"
        )
        return True

    async def create_session(self) -> None:
        self.session_id = str(uuid.uuid4())
        self._trajectory.reset_session(self.session_id)
        self._translator.reset_tracking()
        self._resume_on_connect = False
        self._trajectory.diagnostic(
            "claude.session.ensure", agent_session_id=self.session_id, action="created"
        )

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
            "settings": CLAUDE_POLICY_SETTINGS,
            "setting_sources": ["user", "project"],
            "include_partial_messages": True,
            "forward_subagent_text": False,
            "max_buffer_size": MAX_STDOUT_MESSAGE_BYTES,
            "stderr": self._trajectory.stderr,
            **reasoning_options(model, reasoning_effort),
        }
        if self._resume_on_connect:
            kwargs["resume"] = self.session_id
        else:
            kwargs["session_id"] = self.session_id
        build_options = self._options_factory or _default_options_factory
        return build_options(**kwargs)

    async def _ensure_client(self, model: str, reasoning_effort: str | None) -> SdkClient:
        async with self._client_lifecycle_lock:
            return await self._ensure_client_locked(model, reasoning_effort)

    async def _ensure_client_locked(self, model: str, reasoning_effort: str | None) -> SdkClient:
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
        if not await self._disconnect_locked():
            raise RuntimeError("The previous Claude agent process could not be disconnected.")
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
        self._translator.cost_baseline = 0.0
        self._trajectory.diagnostic(
            "claude.connected",
            model=model,
            reasoning_effort=reasoning_effort,
            resume=self._resume_on_connect,
        )
        # Every later (re)connect resumes the transcript this child writes.
        self._resume_on_connect = True
        return client

    async def _disconnect(self) -> None:
        async with self._client_lifecycle_lock:
            await self._disconnect_locked()

    async def _disconnect_locked(self) -> bool:
        client = self._client
        if client is None:
            return True
        try:
            await client.disconnect()
        except Exception as error:
            self._trajectory.diagnostic("claude.disconnect_error", level="warn", exc=error)
            return False
        if self._client is client:
            self._client = None
        self._trajectory.reset_session(self.session_id)
        self._translator.reset_tracking()
        return True

    # --- prompt ------------------------------------------------------------

    async def run_prompt(self, prompt: HarnessPrompt, emit: EventSink) -> TurnOutcome:
        log_token = self._trajectory.begin(prompt.message_id, self.session_id)
        outcome = None
        try:
            outcome = await self._run_prompt(prompt, emit)
            return outcome
        except asyncio.CancelledError:
            outcome = TurnOutcome(success=False, error="Task was cancelled", cancelled=True)
            raise
        except Exception as error:
            outcome = TurnOutcome.failed(str(error) or type(error).__name__)
            raise
        finally:
            self._trajectory.finish(outcome, log_token)

    async def _run_prompt(self, prompt: HarnessPrompt, emit: EventSink) -> TurnOutcome:
        try:
            model = bare_model_id(prompt.model, self.config.default_model)
        except ValueError as error:
            return TurnOutcome.failed(str(error))
        # One budget covers the whole turn: connect, submit, every read and
        # every emit. The inactivity budget applies to each read alone, and
        # cleanup after either has its own budget, so a hung SDK call can
        # never eat the snapshot reserve. A prompt that carries its own
        # remaining budget spends that instead of the configured maximum.
        max_duration = (
            self.limits.prompt_max_duration_seconds
            if prompt.max_duration_seconds is None
            else prompt.max_duration_seconds
        )
        loop = asyncio.get_running_loop()
        deadline = loop.time() + max_duration
        try:
            async with asyncio.timeout_at(deadline):
                client = await self._ensure_client(model, prompt.reasoning_effort)
        except HarnessStartError:
            raise
        except TimeoutError:
            self._trajectory.diagnostic("claude.connect_timeout", level="error")
            self._needs_reconnect = True
            await self._interrupt_within_budget()
            return TurnOutcome.failed(f"Claude agent did not start within {max_duration:.0f}s.")
        except Exception as error:
            self._trajectory.diagnostic("claude.connect_error", level="error", exc=error)
            self._needs_reconnect = True
            return TurnOutcome.failed(f"Claude agent failed to start: {error}")

        self._interrupted = False
        state = ClaudeTurnState(
            message_id=prompt.message_id, cost_baseline=self._translator.cost_baseline
        )
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
                    translation = self._translator.translate(
                        state, message, interrupted=self._interrupted
                    )
                    self._trajectory.emit(translation)
                    for event in translation.events:
                        await emit(event)
                    if translation.outcome is not None:
                        return translation.outcome
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
            return TurnOutcome.failed(f"Prompt exceeded max duration of {max_duration:.0f}s.")
        except _InactivityTimeout:
            timeout_seconds = self.limits.inactivity_timeout_seconds
            self._trajectory.diagnostic(
                "claude.inactivity_timeout",
                level="error",
                timeout_s=timeout_seconds,
            )
            await self._interrupt_within_budget()
            self._needs_reconnect = True
            return TurnOutcome.failed(
                f"Claude agent produced no output for {timeout_seconds:.0f}s."
            )
        except Exception as error:
            self._trajectory.diagnostic("claude.turn_error", level="error", exc=error)
            self._needs_reconnect = True
            return TurnOutcome.failed(f"Claude agent transport failed: {error}")

    async def _interrupt_within_budget(self) -> bool:
        """Interrupt within the cleanup budget; drop the child if that hangs too.

        True when the child acknowledged the interrupt.
        """
        budget = self.limits.prompt_cleanup_timeout_seconds
        try:
            async with asyncio.timeout(budget):
                return await self._interrupt_quietly()
        except TimeoutError:
            self._trajectory.diagnostic("claude.interrupt_timeout", level="warn", timeout_s=budget)
        try:
            async with asyncio.timeout(budget):
                await self._disconnect()
        except TimeoutError:
            self._trajectory.diagnostic("claude.disconnect_timeout", level="warn", timeout_s=budget)
        return False

    async def _interrupt_quietly(self) -> bool:
        if self._client is None:
            return False
        try:
            await self._client.interrupt()
        except Exception as error:
            self._trajectory.diagnostic("claude.interrupt_error", level="warn", exc=error)
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

    async def stop_execution(self, timeout_seconds: float) -> bool:
        """Contain the SDK-owned Claude child, escalating to disconnect.

        An interrupt acknowledgement is only a request, so shutdown preparation also
        disconnects the client. The SDK transport owns and reaps the Claude
        subprocess; unrelated sandbox services are left running.
        """
        self._interrupted = True
        self._needs_reconnect = True
        loop = asyncio.get_running_loop()
        deadline = loop.time() + max(timeout_seconds, 0.0)
        interrupt_deadline = min(
            deadline,
            loop.time() + max(timeout_seconds / 2, 0.0),
        )
        try:
            async with asyncio.timeout_at(deadline), self._client_lifecycle_lock:
                client = self._client
                if client is None:
                    return True
                try:
                    async with asyncio.timeout_at(interrupt_deadline):
                        await client.interrupt()
                except TimeoutError:
                    self._trajectory.diagnostic(
                        "claude.preservation_interrupt_timeout",
                        level="warn",
                        timeout_s=timeout_seconds / 2,
                    )
                except Exception as error:
                    self._trajectory.diagnostic("claude.interrupt_error", level="warn", exc=error)
                await client.disconnect()
                if self._client is client:
                    self._client = None
                self._trajectory.reset_session(self.session_id)
                self._translator.reset_tracking()
                return True
        except TimeoutError:
            self._trajectory.diagnostic(
                "claude.preservation_stop_timeout", level="warn", timeout_s=timeout_seconds
            )
            return False
        except Exception as error:
            self._trajectory.diagnostic(
                "claude.preservation_disconnect_error", level="warn", exc=error
            )
            return False

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

"""ClaudeHarness against a scripted fake of the SDK client.

Covers the §5.2 translation table, the §5.3 cost-baseline rule, the
credential-at-open contract, the reconnect policy, and terminalisation
ownership (the harness returns a TurnOutcome and never emits
execution_complete).
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock

import pytest
from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ConversationResetMessage,
    RateLimitEvent,
    RateLimitInfo,
    ResultMessage,
    StreamEvent,
    SystemMessage,
    TaskNotificationMessage,
    TaskProgressMessage,
    TaskStartedMessage,
    TaskUpdatedMessage,
    TextBlock,
    ThinkingBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from sandbox_runtime.attachment_processor import (
    MAX_SESSION_ATTACHMENTS_PER_MESSAGE,
    AttachmentProcessor,
)
from sandbox_runtime.credentials.provider_credential_client import (
    RuntimeCredentialDenied,
    RuntimeCredentialUnavailable,
)
from sandbox_runtime.harness import AgentHarness, HarnessPrompt, HarnessStartError, PromptLimits
from sandbox_runtime.harness.claude import (
    AUTHENTICATION_FAILED_MESSAGE,
    MAX_STDOUT_MESSAGE_BYTES,
    ClaudeHarness,
    ClaudeHarnessConfig,
    bare_model_id,
    mcp_server_options,
    reasoning_options,
)
from sandbox_runtime.harness.claude_env import ClaudeAuthMode
from sandbox_runtime.harness.claude_logging import PREVIEW_MAX_BYTES, REDACTED, TRUNCATED
from sandbox_runtime.log_config import JSONFormatter, get_logger

if TYPE_CHECKING:
    from collections.abc import AsyncIterator
    from pathlib import Path

LIMITS = PromptLimits(
    inactivity_timeout_seconds=5.0,
    prompt_max_duration_seconds=30.0,
    prompt_cleanup_timeout_seconds=1.0,
)


def _result(
    total_cost: float | None,
    *,
    subtype: str = "success",
    is_error: bool = False,
    session_id: str = "sess",
    **extra,
):
    return ResultMessage(
        subtype=subtype,
        duration_ms=10,
        duration_api_ms=5,
        is_error=is_error,
        num_turns=1,
        session_id=session_id,
        total_cost_usd=total_cost,
        **extra,
    )


def _stream(kind: str, **event: Any) -> StreamEvent:
    return StreamEvent(uuid="u", session_id="sess", event={"type": kind, **event})


def _text_delta(text: str) -> StreamEvent:
    return _stream("content_block_delta", delta={"type": "text_delta", "text": text})


@dataclass
class FakeSdkClient:
    """Replays scripted turns; records what the harness asked of it."""

    options: Any
    turns: list[list[Any]]
    connected: bool = False
    disconnected: bool = False
    interrupts: int = 0
    queries: list[list[dict[str, Any]]] = field(default_factory=list)
    hang: bool = False
    hang_connect: bool = False
    hang_interrupt: bool = False
    hang_disconnect: bool = False
    fail_disconnect: bool = False
    fail_connect: bool = False
    stderr_on_connect: str | None = None

    async def connect(self) -> None:
        if self.stderr_on_connect:
            self.options["stderr"](self.stderr_on_connect)
        if self.fail_connect:
            raise RuntimeError("spawn failed")
        if self.hang_connect:
            await asyncio.Event().wait()
        self.connected = True

    async def disconnect(self) -> None:
        if self.fail_disconnect:
            raise RuntimeError("disconnect failed")
        if self.hang_disconnect:
            await asyncio.Event().wait()
        self.disconnected = True

    async def query(self, prompt: Any, session_id: str = "default") -> None:
        messages = [message async for message in prompt]
        self.queries.append(messages)

    async def interrupt(self) -> None:
        self.interrupts += 1
        if self.hang_interrupt:
            await asyncio.Event().wait()

    async def receive_messages(self) -> AsyncIterator[Any]:
        if self.hang:
            await asyncio.Event().wait()
        turn = self.turns.pop(0) if self.turns else []
        for message in turn:
            yield message


class FakeCredentialClient:
    def __init__(self, outcome: Any) -> None:
        self.outcome = outcome
        self.calls = 0

    async def fetch(self, provider: str) -> Any:
        self.calls += 1
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome


@dataclass
class Issued:
    secret: str = "sk-ant-oat01-secret"


class Harness:
    """A ClaudeHarness wired to fakes; exposes the clients it created."""

    def __init__(self, tmp_path: Path, *, turns: list[list[Any]] | None = None, **overrides: Any):
        self.clients: list[FakeSdkClient] = []
        self.turns = turns or []
        self.client_kwargs: dict[str, Any] = overrides.pop("client_kwargs", {})
        oauth_managed = overrides.pop("oauth_managed", False)
        credential_client = overrides.pop("credential_client", None)
        environ = overrides.pop("environ", {"ANTHROPIC_API_KEY": "sk-ant-key", "PATH": "/bin"})
        transcript_exists = overrides.pop("transcript_exists", lambda _id, _dir, _cfg: False)
        self.config = ClaudeHarnessConfig(
            workdir=tmp_path / "repo",
            config_dir=tmp_path / "claude",
            mcp_servers=overrides.pop("mcp_servers", ()),
            default_model="claude-sonnet-4-6",
            oauth_managed=oauth_managed,
            system_prompt_append=overrides.pop("system_prompt_append", None),
            tools=None,
        )
        binary = tmp_path / "claude-bin"
        binary.write_text("#!/bin/sh\n")

        def client_factory(options: Any) -> FakeSdkClient:
            client = FakeSdkClient(options=options, turns=self.turns, **self.client_kwargs)
            self.clients.append(client)
            return client

        self.harness = ClaudeHarness(
            config=self.config,
            log=overrides.pop("log", MagicMock()),
            limits=overrides.pop("limits", LIMITS),
            credential_client=credential_client,
            environ=environ,
            client_factory=client_factory,
            options_factory=lambda **kwargs: kwargs,
            transcript_exists=transcript_exists,
            binary=binary,
        )

    @property
    def client(self) -> FakeSdkClient:
        return self.clients[-1]


async def _run(harness: ClaudeHarness, prompt: HarnessPrompt | None = None):
    events: list[dict[str, Any]] = []

    async def emit(event: dict[str, Any]) -> None:
        events.append(event)

    outcome = await harness.run_prompt(prompt or HarnessPrompt(message_id="m1", text="hi"), emit)
    return events, outcome


class TestOpen:
    def test_conforms_to_the_protocol(self, tmp_path: Path) -> None:
        assert isinstance(Harness(tmp_path).harness, AgentHarness)

    @pytest.mark.asyncio
    async def test_api_key_mode_adopts_the_bridge_key_and_writes_the_wrapper(self, tmp_path: Path):
        h = Harness(tmp_path)
        await h.harness.open()
        assert h.harness.credential is not None
        assert h.harness.credential.mode is ClaudeAuthMode.API_KEY
        assert h.harness.wrapper_path is not None and h.harness.wrapper_path.exists()
        assert "sk-ant-key" not in h.harness.wrapper_path.read_text()

    @pytest.mark.asyncio
    async def test_no_credential_is_a_deterministic_failure(self, tmp_path: Path) -> None:
        h = Harness(tmp_path, environ={"PATH": "/bin"})
        with pytest.raises(HarnessStartError, match="ANTHROPIC_API_KEY"):
            await h.harness.open()

    @pytest.mark.asyncio
    async def test_oauth_mode_fetches_the_setup_token_on_open(self, tmp_path: Path) -> None:
        credential_client = FakeCredentialClient(Issued())
        h = Harness(
            tmp_path,
            oauth_managed=True,
            credential_client=credential_client,
            environ={
                "ANTHROPIC_API_KEY": "sk-ant-platform-key-must-not-leak",
            },
        )
        await h.harness.open()
        assert credential_client.calls == 1
        assert h.harness.credential is not None
        assert h.harness.credential.mode is ClaudeAuthMode.OAUTH_TOKEN
        assert dict(h.harness.credential.env) == {"CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-secret"}

    @pytest.mark.asyncio
    async def test_oauth_denial_is_deterministic_and_unavailable_is_transient(self, tmp_path: Path):
        denied = Harness(
            tmp_path,
            oauth_managed=True,
            credential_client=FakeCredentialClient(RuntimeCredentialDenied("account disabled")),
        )
        with pytest.raises(HarnessStartError, match="account disabled"):
            await denied.harness.open()

        transient = Harness(
            tmp_path,
            oauth_managed=True,
            credential_client=FakeCredentialClient(RuntimeCredentialUnavailable("503")),
        )
        with pytest.raises(RuntimeError, match="unavailable"):
            await transient.harness.open()

    @pytest.mark.asyncio
    async def test_oauth_mode_without_a_client_is_deterministic(self, tmp_path: Path) -> None:
        h = Harness(tmp_path, oauth_managed=True)
        with pytest.raises(HarnessStartError):
            await h.harness.open()


class TestSession:
    @pytest.mark.asyncio
    async def test_fresh_session_gets_a_new_id_and_connects_with_session_id(self, tmp_path: Path):
        h = Harness(tmp_path, turns=[[_result(0.1)]])
        await h.harness.open()
        await h.harness.create_session()
        session_id = h.harness.session_id
        assert session_id
        await _run(h.harness)
        assert h.client.options["session_id"] == session_id
        assert "resume" not in h.client.options

    @pytest.mark.asyncio
    async def test_persisted_session_resumes_when_the_transcript_exists(self, tmp_path: Path):
        h = Harness(
            tmp_path, turns=[[_result(0.1)]], transcript_exists=lambda sid, _d, _c: sid == "old"
        )
        await h.harness.open()
        assert await h.harness.resume_session("old") is True
        assert h.harness.session_id == "old"
        await _run(h.harness)
        assert h.client.options["resume"] == "old"

    @pytest.mark.asyncio
    async def test_persisted_session_without_a_transcript_starts_fresh(self, tmp_path: Path):
        h = Harness(tmp_path)
        await h.harness.open()
        assert await h.harness.resume_session("gone") is False
        assert h.harness.session_id is None


class TestOptions:
    @pytest.mark.asyncio
    async def test_options_follow_the_design_mapping(self, tmp_path: Path) -> None:
        h = Harness(
            tmp_path,
            turns=[[_result(0.1)]],
            mcp_servers=(
                {
                    "name": "linear",
                    "type": "remote",
                    "url": "https://mcp.linear",
                    "headers": {"A": "b"},
                },
                {"name": "local", "type": "local", "command": ["npx", "server"], "env": {"K": "v"}},
                {"name": "off", "type": "remote", "url": "u", "enabled": False},
            ),
            system_prompt_append="Workspace guidance",
        )
        await h.harness.open()
        await h.harness.create_session()
        await _run(
            h.harness,
            HarnessPrompt(
                message_id="m1",
                text="hi",
                model="anthropic/claude-sonnet-5-5",
                reasoning_effort="high",
            ),
        )
        options = h.client.options
        assert options["cwd"] == str(tmp_path / "repo")
        assert options["cli_path"] == str(h.harness.wrapper_path)
        assert options["model"] == "claude-sonnet-5-5"
        assert options["effort"] == "high"
        assert options["permission_mode"] == "dontAsk"
        assert options["disallowed_tools"] == ["AskUserQuestion"]
        assert json.loads(options["settings"]) == {
            "attribution": {"commit": "", "pr": "", "sessionUrl": False},
            "feedbackDrafts": "off",
            "feedbackSurveyRate": 0,
        }
        assert options["setting_sources"] == ["user", "project"]
        assert options["include_partial_messages"] is True
        assert options["forward_subagent_text"] is False
        assert options["max_buffer_size"] == MAX_STDOUT_MESSAGE_BYTES
        assert options["system_prompt"] == {
            "type": "preset",
            "preset": "claude_code",
            "append": "Workspace guidance",
        }
        assert options["env"]["CLAUDE_CONFIG_DIR"] == str(tmp_path / "claude")
        assert options["env"]["ANTHROPIC_API_KEY"] == "sk-ant-key"
        assert options["mcp_servers"] == {
            "linear": {"type": "http", "url": "https://mcp.linear", "headers": {"A": "b"}},
            "local": {"type": "stdio", "command": "npx", "args": ["server"], "env": {"K": "v"}},
        }
        assert "mcp__linear__*" in options["allowed_tools"]
        assert "mcp__local__*" in options["allowed_tools"]
        assert "Bash" in options["allowed_tools"]

    async def test_stdout_ceiling_clears_the_whole_attachment_budget(self, tmp_path: Path) -> None:
        """One NDJSON line carries every attachment the runtime accepts.

        ``_user_messages`` inlines them all into a single message the CLI
        echoes back, so a prompt at the top of the budget -- not just one
        large image -- has to fit under the ceiling. Measure the JSON
        envelope from the real message instead of trusting the headroom, and
        stand small payloads in for the images so the check stays cheap.
        """
        h = Harness(tmp_path)
        await h.harness.open()
        await h.harness.create_session()
        attachments = [
            {"name": f"shot-{index}.png", "mimeType": "image/png", "content": "AAAA"}
            for index in range(MAX_SESSION_ATTACHMENTS_PER_MESSAGE)
        ]
        messages = [
            message
            async for message in h.harness._user_messages(
                HarnessPrompt(message_id="m1", text="hi", attachments=attachments)
            )
        ]
        assert len(messages) == 1
        envelope_bytes = len(json.dumps(messages[0])) - sum(
            len(attachment["content"]) for attachment in attachments
        )
        # Encoded one attachment at a time, as the processor does, so the
        # base64 padding lands once per image rather than once per batch.
        per_attachment = ((AttachmentProcessor.MAX_IMAGE_BYTES + 2) // 3) * 4
        base64_bytes = MAX_SESSION_ATTACHMENTS_PER_MESSAGE * per_attachment
        assert base64_bytes + envelope_bytes < MAX_STDOUT_MESSAGE_BYTES

    def test_reasoning_controls_are_per_model(self) -> None:
        assert reasoning_options("claude-sonnet-4-5", "max") == {
            "thinking": {"type": "enabled", "budget_tokens": 31_999}
        }
        assert reasoning_options("claude-sonnet-4-5", "low") == {}
        assert reasoning_options("claude-opus-4-6", "xhigh") == {"effort": "xhigh"}
        assert reasoning_options("claude-opus-4-6", "none") == {}
        assert reasoning_options("claude-opus-4-6", None) == {}

    def test_bare_model_ids(self) -> None:
        assert bare_model_id("anthropic/claude-x", "d") == "claude-x"
        assert bare_model_id("claude-x", "d") == "claude-x"
        assert bare_model_id(None, "d") == "d"
        with pytest.raises(ValueError, match="openai"):
            bare_model_id("openai/gpt-5", "d")

    def test_mcp_options_skip_disabled_and_empty(self) -> None:
        assert mcp_server_options(({"name": "x", "type": "local", "command": []},)) == {}


class TestTranslation:
    @pytest.mark.asyncio
    async def test_step_ids_match_each_turn_and_are_unique(self, tmp_path: Path) -> None:
        h = Harness(
            tmp_path,
            turns=[
                [_stream("message_start", message={"id": "msg_1"}), _result(0.1)],
                [AssistantMessage(content=[], model="m", message_id="msg_2"), _result(0.2)],
                [_result(0.3)],
            ],
        )
        await h.harness.open()
        await h.harness.create_session()

        first, _ = await _run(h.harness, HarnessPrompt(message_id="m1", text="one"))
        second, _ = await _run(h.harness, HarnessPrompt(message_id="m2", text="two"))
        unmatched, _ = await _run(h.harness, HarnessPrompt(message_id="m3", text="three"))

        first_start, first_finish = (e for e in first if e["type"] in ("step_start", "step_finish"))
        second_start, second_finish = (
            e for e in second if e["type"] in ("step_start", "step_finish")
        )
        assert first_start["stepId"] == first_finish["stepId"]
        assert second_start["stepId"] == second_finish["stepId"]
        assert first_start["stepId"] != second_start["stepId"]
        assert next(e for e in unmatched if e["type"] == "step_finish")["stepId"]

    @pytest.mark.asyncio
    async def test_a_turn_with_text_and_a_tool_call(self, tmp_path: Path) -> None:
        turn = [
            SystemMessage(subtype="init", data={"model": "claude-sonnet-4-6", "tools": ["Bash"]}),
            _stream("message_start", message={"id": "msg_1"}),
            _text_delta("Hel"),
            _text_delta("lo"),
            AssistantMessage(
                content=[
                    TextBlock("Hello"),
                    ToolUseBlock(id="tu_1", name="Bash", input={"command": "ls"}),
                ],
                model="claude-sonnet-4-6",
                message_id="msg_1",
            ),
            UserMessage(content=[ToolResultBlock(tool_use_id="tu_1", content="a.txt\nb.txt")]),
            _stream("message_start", message={"id": "msg_2"}),
            _text_delta("Done."),
            AssistantMessage(
                content=[TextBlock("Done.")], model="claude-sonnet-4-6", message_id="msg_2"
            ),
            _result(
                0.25, usage={"input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 2}
            ),
        ]
        h = Harness(tmp_path, turns=[turn])
        await h.harness.open()
        await h.harness.create_session()
        events, outcome = await _run(h.harness)

        assert [e["type"] for e in events] == [
            "step_start",
            "token",
            "token",
            "tool_call",
            "tool_call",
            "token",
            "step_finish",
        ]
        assert events[1]["content"] == "Hel" and events[2]["content"] == "Hello"
        assert events[3] == {
            "type": "tool_call",
            "tool": "Bash",
            "args": {"command": "ls"},
            "callId": "tu_1",
            "status": "running",
            "output": "",
            "messageId": "m1",
        }
        assert events[4]["status"] == "completed" and events[4]["output"] == "a.txt\nb.txt"
        assert events[4]["tool"] == "Bash" and events[4]["args"] == {"command": "ls"}
        assert events[5]["content"] == "Hello\n\nDone."
        assert events[6]["messageCostUsd"] == 0.25
        assert events[6]["tokens"] == {"input": 10, "output": 5, "cache": {"read": 2}}
        assert all(e["messageId"] == "m1" for e in events)
        assert "execution_complete" not in {e["type"] for e in events}
        assert outcome.success is True and outcome.message_cost_usd == 0.25
        assert h.harness.init_info == {"model": "claude-sonnet-4-6", "tools": ["Bash"]}
        # The prompt went out as a streaming-input user message bound to the session.
        sent = h.client.queries[0][0]
        assert sent["type"] == "user"
        assert sent["message"]["content"] == [{"type": "text", "text": "hi"}]
        assert sent["session_id"] == h.harness.session_id

    @pytest.mark.asyncio
    async def test_attachments_become_image_blocks(self, tmp_path: Path) -> None:
        h = Harness(tmp_path, turns=[[_result(0.0)]])
        await h.harness.open()
        await h.harness.create_session()
        await _run(
            h.harness,
            HarnessPrompt(
                message_id="m1",
                text="look",
                attachments=({"name": "a.png", "mimeType": "image/png", "content": "QUJD"},),
            ),
        )
        content = h.client.queries[0][0]["message"]["content"]
        assert content[1] == {
            "type": "image",
            "source": {"type": "base64", "media_type": "image/png", "data": "QUJD"},
        }

    @pytest.mark.asyncio
    async def test_subagent_activity_is_nested_and_its_text_dropped(self, tmp_path: Path) -> None:
        turn = [
            AssistantMessage(
                content=[ToolUseBlock(id="agent_1", name="Agent", input={"prompt": "x"})],
                model="m",
                message_id="msg_1",
            ),
            StreamEvent(
                uuid="u",
                session_id="s",
                parent_tool_use_id="agent_1",
                event={
                    "type": "content_block_delta",
                    "delta": {"type": "text_delta", "text": "child"},
                },
            ),
            AssistantMessage(
                content=[
                    TextBlock("child text"),
                    ToolUseBlock(id="tu_c", name="Read", input={"file_path": "f"}),
                ],
                model="m",
                message_id="msg_c",
                parent_tool_use_id="agent_1",
            ),
            UserMessage(
                content=[
                    ToolResultBlock(
                        tool_use_id="tu_c", content=[{"type": "text", "text": "ok"}], is_error=True
                    )
                ],
                parent_tool_use_id="agent_1",
            ),
            _result(0.1),
        ]
        h = Harness(tmp_path, turns=[turn])
        await h.harness.open()
        await h.harness.create_session()
        events, _ = await _run(h.harness)
        tool_events = [e for e in events if e["type"] == "tool_call"]
        # The vendor name is normalised to the task tool the timeline groups under.
        assert tool_events[0]["tool"] == "task" and "isSubtask" not in tool_events[0]
        assert tool_events[1]["tool"] == "Read"
        assert tool_events[1]["isSubtask"] is True and tool_events[1]["taskCallId"] == "agent_1"
        assert tool_events[2]["status"] == "error" and tool_events[2]["output"] == "ok"
        assert [e for e in events if e["type"] == "token"] == []

    @pytest.mark.asyncio
    async def test_first_party_tools_drop_their_mcp_qualification(self, tmp_path: Path) -> None:
        turn = [
            AssistantMessage(
                content=[
                    ToolUseBlock(
                        id="tu_pr",
                        name="mcp__oi__create-pull-request",
                        input={"title": "t", "body": "b"},
                    ),
                    ToolUseBlock(
                        id="tu_ext",
                        name="mcp__linear__create_issue",
                        input={"title": "bug"},
                    ),
                ],
                model="m",
                message_id="msg_1",
            ),
            _result(0.1),
        ]
        h = Harness(tmp_path, turns=[turn])
        await h.harness.open()
        await h.harness.create_session()
        events, _ = await _run(h.harness)
        tools = [e["tool"] for e in events if e["type"] == "tool_call"]
        # First-party tools carry the ids OpenCode emits; external MCP tools
        # keep their server-qualified names.
        assert tools == ["create-pull-request", "mcp__linear__create_issue"]

    @pytest.mark.asyncio
    async def test_compaction_and_provider_warnings(self, tmp_path: Path) -> None:
        turn = [
            SystemMessage(subtype="compact_boundary", data={}),
            RateLimitEvent(
                rate_limit_info=RateLimitInfo(
                    status="allowed_warning", rate_limit_type="five_hour", resets_at=123
                ),
                uuid="u",
                session_id="s",
            ),
            AssistantMessage(content=[], model="m", message_id="msg_1", error="rate_limit"),
            _result(0.0),
        ]
        h = Harness(tmp_path, turns=[turn])
        await h.harness.open()
        await h.harness.create_session()
        events, outcome = await _run(h.harness)
        assert events[0] == {"type": "context_compacted", "messageId": "m1"}
        warnings = [e for e in events if e["type"] == "warning"]
        assert all(w["scope"] == "provider" for w in warnings)
        assert "allowed_warning" in warnings[0]["message"] and "five_hour" in warnings[0]["message"]
        assert "rate limit" in warnings[1]["message"]
        assert outcome.success is True

    @pytest.mark.asyncio
    async def test_authentication_failure_is_an_error_with_reconnect_guidance(self, tmp_path: Path):
        turn = [
            AssistantMessage(
                content=[], model="m", message_id="msg_1", error="authentication_failed"
            ),
            _result(0.0, subtype="error_during_execution", is_error=True, result="401"),
        ]
        h = Harness(tmp_path, turns=[turn])
        await h.harness.open()
        await h.harness.create_session()
        events, outcome = await _run(h.harness)
        errors = [e for e in events if e["type"] == "error"]
        assert errors == [
            {"type": "error", "error": AUTHENTICATION_FAILED_MESSAGE, "messageId": "m1"}
        ]
        assert outcome.success is False

    @pytest.mark.asyncio
    async def test_result_error_fails_the_turn(self, tmp_path: Path) -> None:
        h = Harness(
            tmp_path,
            turns=[[_result(0.2, subtype="error_max_turns", is_error=True, errors=["too many"])]],
        )
        await h.harness.open()
        await h.harness.create_session()
        events, outcome = await _run(h.harness)
        assert outcome == outcome.__class__(success=False, error="too many", message_cost_usd=0.2)
        assert next(e for e in events if e["type"] == "error")["error"] == "too many"

    @pytest.mark.asyncio
    async def test_missing_cost_is_zero_with_a_warning(self, tmp_path: Path) -> None:
        h = Harness(tmp_path, turns=[[_result(None)]])
        await h.harness.open()
        await h.harness.create_session()
        events, outcome = await _run(h.harness)
        assert outcome.message_cost_usd == 0.0
        assert any(e["type"] == "warning" and "no cost" in e["message"] for e in events)

    @pytest.mark.asyncio
    async def test_prompts_are_stamped_human_and_injected_results_are_skipped(
        self, tmp_path: Path
    ) -> None:
        # A background task's whole turn arrives on the same connection first:
        # its user message and result carry the origin, the assistant output,
        # stream events and tool results between them do not. None of it is
        # ours, and its result ends that turn, not ours.
        injected_turn = [
            UserMessage(content="task finished", origin={"kind": "task-notification"}),
            _text_delta("injected"),
            AssistantMessage(
                content=[
                    TextBlock("injected answer"),
                    ToolUseBlock(id="call_bg", name="Bash", input={"command": "ls"}),
                ],
                model="m",
                message_id="msg_bg",
            ),
            UserMessage(
                content=[ToolResultBlock(tool_use_id="call_bg", content="x", is_error=False)]
            ),
            _result(0.1, origin={"kind": "task-notification"}),
        ]
        our_turn = [
            AssistantMessage(content=[TextBlock("real answer")], model="m", message_id="msg_1"),
            _result(0.3, origin={"kind": "human"}),
        ]
        h = Harness(tmp_path, turns=[injected_turn + our_turn])
        await h.harness.open()
        await h.harness.create_session()
        events, outcome = await _run(h.harness)
        assert h.client.queries[0][0]["origin"] == {"kind": "human"}
        # The injected turn's spend stays in the running total and lands here,
        # so the session's cost still adds up.
        assert outcome.success is True and outcome.message_cost_usd == pytest.approx(0.3)
        assert [e["content"] for e in events if e["type"] == "token"] == ["real answer"]
        assert [e for e in events if e["type"] == "tool"] == []
        assert len([e for e in events if e["type"] == "step_finish"]) == 1


class TestCostBaseline:
    """§5.3: messageCostUsd = running total at turn end - baseline."""

    @pytest.mark.asyncio
    async def test_two_turns_then_restart_then_a_third(self, tmp_path: Path) -> None:
        h = Harness(tmp_path, turns=[[_result(0.10)], [_result(0.35)], [_result(0.05)]])
        await h.harness.open()
        await h.harness.create_session()
        _, first = await _run(h.harness, HarnessPrompt(message_id="m1", text="a"))
        _, second = await _run(h.harness, HarnessPrompt(message_id="m2", text="b"))
        assert first.message_cost_usd == pytest.approx(0.10)
        assert second.message_cost_usd == pytest.approx(0.25)
        assert len(h.clients) == 1

        # A transport drop forces a reconnect: the new child restarts its total.
        h.harness._needs_reconnect = True
        _, third = await _run(h.harness, HarnessPrompt(message_id="m3", text="c"))
        assert third.message_cost_usd == pytest.approx(0.05)
        assert len(h.clients) == 2
        assert h.clients[0].disconnected is True
        assert h.clients[1].options["resume"] == h.harness.session_id

    @pytest.mark.asyncio
    async def test_conversation_reset_zeroes_the_baseline(self, tmp_path: Path) -> None:
        turns = [
            [_result(0.5)],
            [
                ConversationResetMessage(new_conversation_id="c2", uuid="u", session_id="s"),
                _result(0.2),
            ],
        ]
        h = Harness(tmp_path, turns=turns)
        await h.harness.open()
        await h.harness.create_session()
        await _run(h.harness, HarnessPrompt(message_id="m1", text="a"))
        _, second = await _run(h.harness, HarnessPrompt(message_id="m2", text="b"))
        assert second.message_cost_usd == pytest.approx(0.2)

    @pytest.mark.asyncio
    async def test_conversation_reset_rotates_the_session_id(self, tmp_path: Path) -> None:
        # After a reset the messages carry a new session id; the next resume
        # and the persisted id must follow it, or the post-reset conversation
        # is lost on the next reconnect.
        turns = [
            [_result(0.5)],
            [
                ConversationResetMessage(new_conversation_id="c2", uuid="u", session_id="s"),
                _result(0.2, session_id="rotated-id"),
            ],
            [_result(0.1)],
        ]
        h = Harness(tmp_path, turns=turns)
        await h.harness.open()
        await h.harness.create_session()
        original = h.harness.session_id
        await _run(h.harness, HarnessPrompt(message_id="m1", text="a"))
        assert h.harness.session_id == original
        await _run(h.harness, HarnessPrompt(message_id="m2", text="b"))
        assert h.harness.session_id == "rotated-id"
        h.harness._needs_reconnect = True
        await _run(h.harness, HarnessPrompt(message_id="m3", text="c"))
        assert h.clients[1].options["resume"] == "rotated-id"

    @pytest.mark.asyncio
    async def test_an_unknown_total_never_charges_a_later_turn(self, tmp_path: Path) -> None:
        # 0.10 -> None -> 0.40: the third turn's true cost is unknowable, so it
        # is 0 with a warning, not 0.30.
        h = Harness(tmp_path, turns=[[_result(0.10)], [_result(None)], [_result(0.40)]])
        await h.harness.open()
        await h.harness.create_session()
        _, first = await _run(h.harness, HarnessPrompt(message_id="m1", text="a"))
        _, second = await _run(h.harness, HarnessPrompt(message_id="m2", text="b"))
        events, third = await _run(h.harness, HarnessPrompt(message_id="m3", text="c"))
        assert first.message_cost_usd == pytest.approx(0.10)
        assert second.message_cost_usd == 0.0
        assert third.message_cost_usd == 0.0
        assert any("previous turn" in e.get("message", "") for e in events)
        _, fourth = await _run(h.harness, HarnessPrompt(message_id="m4", text="d"))
        assert fourth.success is False  # no scripted turn left; baseline is re-anchored at 0.40


class TestReconnectPolicy:
    @pytest.mark.asyncio
    async def test_model_or_effort_change_reconnects_with_resume(self, tmp_path: Path) -> None:
        h = Harness(tmp_path, turns=[[_result(0.1)], [_result(0.1)]])
        await h.harness.open()
        await h.harness.create_session()
        await _run(
            h.harness, HarnessPrompt(message_id="m1", text="a", model="anthropic/claude-sonnet-4-6")
        )
        await _run(
            h.harness, HarnessPrompt(message_id="m2", text="b", model="anthropic/claude-opus-4-6")
        )
        assert len(h.clients) == 2
        assert h.clients[1].options["model"] == "claude-opus-4-6"
        assert h.clients[1].options["resume"] == h.harness.session_id

    @pytest.mark.asyncio
    async def test_reconnect_budget_is_three_per_session(self, tmp_path: Path) -> None:
        h = Harness(tmp_path, turns=[[_result(0.1)] for _ in range(6)])
        await h.harness.open()
        await h.harness.create_session()
        await _run(h.harness)
        for _ in range(3):
            h.harness._needs_reconnect = True
            _, outcome = await _run(h.harness)
            assert outcome.success is True
        h.harness._needs_reconnect = True
        _, outcome = await _run(h.harness)
        assert outcome.success is False
        assert "repeatedly" in (outcome.error or "")

    @pytest.mark.asyncio
    async def test_failed_connects_spend_the_reconnect_budget(self, tmp_path: Path) -> None:
        h = Harness(tmp_path, turns=[], client_kwargs={"fail_connect": True})
        await h.harness.open()
        await h.harness.create_session()
        outcomes = [(await _run(h.harness))[1] for _ in range(5)]
        assert all(outcome.success is False for outcome in outcomes)
        assert all("failed to start" in (o.error or "") for o in outcomes[:4])
        assert "repeatedly" in (outcomes[4].error or "")
        assert len(h.clients) == 4

    @pytest.mark.asyncio
    async def test_abort_interrupts_and_forces_a_fresh_stream_next_time(self, tmp_path: Path):
        h = Harness(tmp_path, turns=[[_result(0.1)], [_result(0.1)]])
        await h.harness.open()
        await h.harness.create_session()
        await _run(h.harness)
        assert await h.harness.abort() is True
        assert h.client.interrupts == 1
        await _run(h.harness)
        assert len(h.clients) == 2

    @pytest.mark.asyncio
    async def test_abort_is_bounded_when_interrupt_hangs(self, tmp_path: Path) -> None:
        # The bridge awaits abort() inline on its command loop.
        limits = PromptLimits(
            inactivity_timeout_seconds=5.0,
            prompt_max_duration_seconds=5.0,
            prompt_cleanup_timeout_seconds=0.05,
        )
        h = Harness(tmp_path, turns=[[]], limits=limits, client_kwargs={"hang_interrupt": True})
        await h.harness.open()
        await h.harness.create_session()
        await h.harness._ensure_client("claude-sonnet-4-6", None)
        assert await asyncio.wait_for(h.harness.abort(), timeout=2.0) is False
        assert h.client.interrupts == 1
        assert h.client.disconnected is True

    @pytest.mark.asyncio
    async def test_cancellation_propagates_to_the_bridge(self, tmp_path: Path) -> None:
        h = Harness(tmp_path, turns=[[]])
        await h.harness.open()
        await h.harness.create_session()

        async def emit(_event: dict[str, Any]) -> None:
            pass

        async def run() -> None:
            h.clients[-1].hang = True if h.clients else None
            await h.harness.run_prompt(HarnessPrompt(message_id="m1", text="x"), emit)

        # Connect first so the hang flag lands on the live client.
        await h.harness._ensure_client("claude-sonnet-4-6", None)
        h.client.hang = True
        task = asyncio.create_task(
            h.harness.run_prompt(HarnessPrompt(message_id="m1", text="x"), emit)
        )
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    @pytest.mark.asyncio
    async def test_inactivity_timeout_fails_the_turn_and_interrupts(self, tmp_path: Path) -> None:
        limits = PromptLimits(
            inactivity_timeout_seconds=0.05,
            prompt_max_duration_seconds=5.0,
            prompt_cleanup_timeout_seconds=1.0,
        )
        h = Harness(tmp_path, turns=[[]], limits=limits)
        await h.harness.open()
        await h.harness.create_session()
        await h.harness._ensure_client("claude-sonnet-4-6", None)
        h.client.hang = True
        _, outcome = await _run(h.harness)
        assert outcome.success is False and "no output" in (outcome.error or "")
        assert h.client.interrupts == 1

    @pytest.mark.asyncio
    async def test_a_hung_connect_is_cut_by_the_prompt_budget(self, tmp_path: Path) -> None:
        limits = PromptLimits(
            inactivity_timeout_seconds=5.0,
            prompt_max_duration_seconds=0.05,
            prompt_cleanup_timeout_seconds=0.05,
        )
        h = Harness(tmp_path, turns=[], limits=limits, client_kwargs={"hang_connect": True})
        await h.harness.open()
        await h.harness.create_session()
        _, outcome = await asyncio.wait_for(_run(h.harness), timeout=2.0)
        assert outcome.success is False and "did not start" in (outcome.error or "")

    @pytest.mark.asyncio
    async def test_cleanup_after_a_timeout_is_bounded_even_when_interrupt_hangs(
        self, tmp_path: Path
    ) -> None:
        limits = PromptLimits(
            inactivity_timeout_seconds=0.05,
            prompt_max_duration_seconds=5.0,
            prompt_cleanup_timeout_seconds=0.05,
        )
        h = Harness(tmp_path, turns=[[]], limits=limits, client_kwargs={"hang_interrupt": True})
        await h.harness.open()
        await h.harness.create_session()
        await h.harness._ensure_client("claude-sonnet-4-6", None)
        h.client.hang = True
        _, outcome = await asyncio.wait_for(_run(h.harness), timeout=2.0)
        assert outcome.success is False and "no output" in (outcome.error or "")
        assert h.client.interrupts == 1
        # Interrupt never settled, so the child was dropped instead.
        assert h.client.disconnected is True

    @pytest.mark.asyncio
    async def test_close_disconnects_the_child(self, tmp_path: Path) -> None:
        h = Harness(tmp_path, turns=[[_result(0.1)]])
        await h.harness.open()
        await h.harness.create_session()
        await _run(h.harness)
        await h.harness.close()
        assert h.client.disconnected is True


def _trajectory_records(caplog, event: str | None = None) -> list[dict[str, Any]]:
    formatter = JSONFormatter()
    return [
        json.loads(formatter.format(record))
        for record in caplog.records
        if record.name == "claude-trajectory-test"
        and (event is None or record.getMessage() == event)
    ]


@pytest.fixture
def trajectory_log(caplog):
    caplog.set_level(logging.INFO, logger="claude-trajectory-test")
    return get_logger("claude-trajectory-test", sandbox_id="sb-test", session_id="oi-session")


class TestTrajectoryLogging:
    async def test_tool_logs_are_correlated_without_changing_wire_payloads(
        self, tmp_path: Path, trajectory_log, caplog
    ) -> None:
        args = {"command": "ls", "nested": {"apiKey": "private-value"}}
        turn = [
            AssistantMessage(
                content=[
                    ToolUseBlock(id="tu_ok", name="Bash", input=args),
                    ToolUseBlock(id="tu_error", name="Read", input={"file_path": "missing"}),
                ],
                model="m",
                session_id="native-session",
            ),
            UserMessage(content=[ToolResultBlock(tool_use_id="tu_ok", content="a.txt\nb.txt")]),
            UserMessage(
                content=[ToolResultBlock(tool_use_id="tu_error", content="missing", is_error=True)]
            ),
            _result(0.2, session_id="native-session"),
        ]
        h = Harness(tmp_path, turns=[turn], log=trajectory_log)
        await h.harness.open()
        await h.harness.create_session()
        events, outcome = await _run(h.harness)
        assert outcome.success
        tools = [event for event in events if event["type"] == "tool_call"]
        assert tools == [
            {
                "type": "tool_call",
                "tool": "Bash",
                "args": args,
                "callId": "tu_ok",
                "status": "running",
                "output": "",
                "messageId": "m1",
            },
            {
                "type": "tool_call",
                "tool": "Read",
                "args": {"file_path": "missing"},
                "callId": "tu_error",
                "status": "running",
                "output": "",
                "messageId": "m1",
            },
            {
                "type": "tool_call",
                "tool": "Bash",
                "args": args,
                "callId": "tu_ok",
                "status": "completed",
                "output": "a.txt\nb.txt",
                "messageId": "m1",
            },
            {
                "type": "tool_call",
                "tool": "Read",
                "args": {"file_path": "missing"},
                "callId": "tu_error",
                "status": "error",
                "output": "missing",
                "messageId": "m1",
            },
        ]
        starts = _trajectory_records(caplog, "claude.tool.started")
        (completed,) = _trajectory_records(caplog, "claude.tool.completed")
        (failed,) = _trajectory_records(caplog, "claude.tool.failed")
        assert [record["call_id"] for record in starts] == ["tu_ok", "tu_error"]
        assert json.loads(starts[0]["args_preview"])["nested"]["apiKey"] == REDACTED
        assert completed["call_id"] == "tu_ok" and completed["output_preview"] == "a.txt\nb.txt"
        assert failed["call_id"] == "tu_error" and failed["status"] == "error"
        for record in [*starts, completed, failed]:
            assert record["level"] == "info"
            assert record["sandbox_id"] == "sb-test" and record["session_id"] == "oi-session"
            assert record["agent_session_id"] == "native-session" and record["message_id"] == "m1"

    async def test_subagent_tools_and_lifecycle_keep_parent_ids_without_collecting_text(
        self, tmp_path: Path, trajectory_log, caplog
    ) -> None:
        usage = {"total_tokens": 25, "tool_uses": 2, "duration_ms": 100}
        turn = [
            AssistantMessage(
                content=[ToolUseBlock(id="parent", name="Agent", input={"prompt": "inspect"})],
                model="m",
            ),
            TaskStartedMessage(
                subtype="task_started",
                data={"uncollected": "raw-data"},
                task_id="task-1",
                description="Inspect files",
                uuid="u",
                session_id="native",
                tool_use_id="parent",
                task_type="local_agent",
            ),
            AssistantMessage(
                content=[
                    TextBlock("uncollected-child-text"),
                    ThinkingBlock(thinking="uncollected-reasoning", signature="sig"),
                    ToolUseBlock(id="child", name="Read", input={"file_path": "f"}),
                ],
                model="m",
                parent_tool_use_id="parent",
                session_id="native",
            ),
            UserMessage(
                content=[ToolResultBlock(tool_use_id="child", content="ok")],
                parent_tool_use_id="parent",
            ),
            TaskProgressMessage(
                subtype="task_progress",
                data={},
                task_id="task-1",
                description="uncollected-progress-text",
                usage=usage,
                uuid="p",
                session_id="native",
                last_tool_name="Read",
            ),
            TaskUpdatedMessage(
                subtype="task_updated",
                data={},
                task_id="task-1",
                status="failed",
                patch={"error": "read failed", "result": "uncollected-task-result"},
            ),
            TaskNotificationMessage(
                subtype="task_notification",
                data={},
                task_id="task-1",
                status="completed",
                output_file="/tmp/result",
                summary="uncollected-summary",
                uuid="n",
                session_id="native",
                tool_use_id="parent",
                usage=usage,
            ),
            _result(0.1, session_id="native"),
        ]
        h = Harness(tmp_path, turns=[turn], log=trajectory_log)
        await h.harness.open()
        await h.harness.create_session()
        events, outcome = await _run(h.harness)
        assert outcome.success
        tools = [event for event in events if event["type"] == "tool_call"]
        assert tools[0]["tool"] == "task"
        assert all(event["taskCallId"] == "parent" for event in tools[1:])
        records = _trajectory_records(caplog)
        nested = [record for record in records if record.get("call_id") == "child"]
        assert [record["status"] for record in nested] == ["running", "completed"]
        lifecycle = [record for record in records if record["event"].startswith("claude.task.")]
        assert len(lifecycle) == 4
        assert all(record["parent_tool_use_id"] == "parent" for record in nested + lifecycle)
        assert all(record["task_id"] == "task-1" for record in lifecycle)
        assert lifecycle[1]["total_tokens"] == 25 and lifecycle[1]["tool_uses"] == 2
        assert lifecycle[2]["status"] == "failed" and lifecycle[2]["error_preview"] == "read failed"
        assert lifecycle[3]["status"] == "completed" and lifecycle[3]["duration_ms"] == 100
        assert "uncollected" not in json.dumps(records)
        assert not any(event["type"] == "token" for event in events)

    async def test_completed_assistant_text_is_logged_once_not_per_delta(
        self, tmp_path: Path, trajectory_log, caplog
    ) -> None:
        message = AssistantMessage(
            content=[
                TextBlock("Hello"),
                ThinkingBlock(thinking="private-thought", signature="sig"),
            ],
            model="m",
            message_id="msg-1",
        )
        h = Harness(
            tmp_path,
            turns=[
                [
                    _stream("message_start", message={"id": "msg-1"}),
                    _text_delta("Hel"),
                    _text_delta("lo"),
                    message,
                    message,
                    _result(0.0),
                ]
            ],
            log=trajectory_log,
        )
        await h.harness.open()
        await h.harness.create_session()
        events, _ = await _run(h.harness)
        assert [event["content"] for event in events if event["type"] == "token"] == [
            "Hel",
            "Hello",
        ]
        (record,) = _trajectory_records(caplog, "claude.assistant.message")
        assert record["text_preview"] == "Hello" and record["assistant_message_id"] == "msg-1"
        assert "private-thought" not in json.dumps(_trajectory_records(caplog))

    @pytest.mark.parametrize("subtype,is_error", [("success", False), ("error_max_turns", True)])
    async def test_turn_outcome_duration_usage_and_cost(
        self, tmp_path: Path, trajectory_log, caplog, subtype, is_error
    ) -> None:
        h = Harness(
            tmp_path,
            turns=[
                [_result(0.1)],
                [
                    _result(
                        0.35,
                        subtype=subtype,
                        is_error=is_error,
                        errors=["turn failed"] if is_error else None,
                        usage={
                            "input_tokens": 10,
                            "output_tokens": 5,
                            "cache_creation_input_tokens": 3,
                            "uncollected": "raw-usage",
                        },
                    )
                ],
            ],
            log=trajectory_log,
        )
        await h.harness.open()
        await h.harness.create_session()
        await _run(h.harness)
        events, outcome = await _run(h.harness, HarnessPrompt(message_id="m2", text="next"))
        records = [
            record
            for record in _trajectory_records(caplog)
            if record["event"].startswith("claude.turn.")
        ]
        assert len(records) == 2
        record = records[-1]
        assert record["status"] == ("failed" if is_error else "completed")
        assert record["message_id"] == "m2" and record["agent_session_id"] == "sess"
        assert record["duration_s"] >= 0
        assert record["sdk_duration_ms"] == 10 and record["sdk_duration_api_ms"] == 5
        assert record["num_turns"] == 1 and record["sdk_status"] == subtype
        assert record["message_cost_usd"] == pytest.approx(0.25)
        assert record["total_cost_usd"] == 0.35
        assert record["tokens"] == {"input": 10, "output": 5, "cache": {"write": 3}}
        assert outcome.success is not is_error
        assert next(event for event in events if event["type"] == "step_finish")[
            "messageCostUsd"
        ] == pytest.approx(0.25)
        assert "uncollected" not in json.dumps(records)

    async def test_stderr_callback_is_supported_and_stays_session_scoped_on_reused_client(
        self, tmp_path: Path, trajectory_log, caplog
    ) -> None:
        h = Harness(
            tmp_path,
            turns=[[_result(0.1)], [_result(0.2)]],
            log=trajectory_log,
            client_kwargs={"stderr_on_connect": "startup diagnostic"},
        )
        await h.harness.open()
        await h.harness.create_session()
        native_id = h.harness.session_id
        await _run(h.harness)
        assert callable(ClaudeAgentOptions(**h.client.options).stderr)

        async def emit(_event):
            h.client.options["stderr"]("second prompt diagnostic")

        await h.harness.run_prompt(HarnessPrompt(message_id="m2", text="next"), emit)
        records = _trajectory_records(caplog, "claude.sdk.stderr")
        assert len(h.clients) == 1
        assert all("message_id" not in record for record in records)
        assert [record["diagnostic_preview"] for record in records] == [
            "startup diagnostic",
            "second prompt diagnostic",
        ]
        assert records[0]["agent_session_id"] == native_id
        assert records[1]["agent_session_id"] == "sess"

    async def test_redaction_truncation_and_unicode_leave_session_events_untouched(
        self, tmp_path: Path, trajectory_log, caplog
    ) -> None:
        secrets = [
            "platform-api-secret",
            "oauth-memory-secret",
            "sandbox-bearer-secret",
            "mcp-custom-header-secret",
            "mcp-custom-env-secret",
            "private-key-line-one\nprivate-key-line-two",
            "unknown-sensitive-value",
        ]
        text = (
            "\n".join(secrets[:-1])
            + "\n"
            + json.dumps({"api_key": secrets[-1]})
            + "\n"
            + "\u00e9\U0001f680" * PREVIEW_MAX_BYTES
        )
        args = {
            "command": text,
            "nested": [{"password": secrets[-1], "accessToken": secrets[-1]}],
            "env": {"innocent": "uncollected-environment"},
        }
        h = Harness(
            tmp_path,
            turns=[
                [
                    AssistantMessage(
                        content=[TextBlock(text), ToolUseBlock(id="tu", name="Bash", input=args)],
                        model="m",
                    ),
                    UserMessage(content=[ToolResultBlock(tool_use_id="tu", content=text)]),
                    _result(0.1),
                ]
            ],
            log=trajectory_log,
            oauth_managed=True,
            credential_client=FakeCredentialClient(Issued(secret=secrets[1])),
            environ={
                "ANTHROPIC_API_KEY": secrets[0],
                "SANDBOX_AUTH_TOKEN": secrets[2],
                "PRIVATE_KEY": secrets[5],
            },
            mcp_servers=(
                {
                    "name": "external",
                    "type": "remote",
                    "url": "https://mcp",
                    "headers": {"X-Custom": secrets[3]},
                    "env": {"CUSTOM": secrets[4]},
                },
            ),
            client_kwargs={"stderr_on_connect": text},
        )
        await h.harness.open()
        await h.harness.create_session()
        events, outcome = await _run(h.harness)
        assert outcome.success
        assert next(event for event in events if event["type"] == "tool_call")["args"] == args
        assert (
            next(event for event in events if event.get("status") == "completed")["output"] == text
        )
        assert next(event for event in events if event["type"] == "token")["content"] == text
        records = _trajectory_records(caplog)
        serialized = json.dumps(records)
        for secret in [*secrets, *secrets[5].splitlines(), "uncollected-environment"]:
            assert secret not in serialized
        previews = [
            value for record in records for key, value in record.items() if key.endswith("_preview")
        ]
        assert len(previews) == 4
        assert all(len(preview.encode("utf-8")) <= PREVIEW_MAX_BYTES for preview in previews)
        assert all(preview.endswith(TRUNCATED) for preview in previews)
        assert all(REDACTED in preview for preview in previews)
        for record in caplog.records:
            line = JSONFormatter().format(record)
            assert "\n" not in line
            json.loads(line)

    async def test_compaction_and_provider_diagnostics_are_allowlisted(
        self, tmp_path: Path, trajectory_log, caplog
    ) -> None:
        h = Harness(
            tmp_path,
            turns=[
                [
                    SystemMessage(
                        subtype="compact_boundary",
                        data={
                            "compact_metadata": {
                                "trigger": "auto",
                                "pre_tokens": 5000,
                                "uncollected": "configuration",
                            }
                        },
                    ),
                    RateLimitEvent(
                        rate_limit_info=RateLimitInfo(
                            status="rejected", rate_limit_type="five_hour"
                        ),
                        uuid="u",
                        session_id="native",
                    ),
                    _result(None),
                ]
            ],
            log=trajectory_log,
        )
        await h.harness.open()
        await h.harness.create_session()
        events, _ = await _run(h.harness)
        (record,) = _trajectory_records(caplog, "claude.context.compacted")
        assert record["trigger"] == "auto" and record["pre_tokens"] == 5000
        warnings = _trajectory_records(caplog, "claude.provider.warning")
        assert len(warnings) == 2 and "rejected" in warnings[0]["diagnostic_preview"]
        assert "no cost" in warnings[1]["diagnostic_preview"]
        assert "uncollected" not in json.dumps(_trajectory_records(caplog))
        assert events[0] == {"type": "context_compacted", "messageId": "m1"}

    async def test_task_parent_ids_survive_prompt_boundaries(
        self, tmp_path: Path, trajectory_log, caplog
    ) -> None:
        h = Harness(
            tmp_path,
            turns=[
                [
                    TaskStartedMessage(
                        subtype="task_started",
                        data={},
                        task_id="task-late",
                        description="Inspect",
                        uuid="u",
                        session_id="sess",
                        tool_use_id="parent-late",
                    ),
                    _result(0.1),
                ],
                [
                    TaskUpdatedMessage(
                        subtype="task_updated",
                        data={},
                        task_id="task-late",
                        patch={"status": "completed"},
                        status="completed",
                    ),
                    _result(0.2),
                ],
            ],
            log=trajectory_log,
        )
        await h.harness.open()
        await h.harness.create_session()
        await _run(h.harness)
        await _run(h.harness, HarnessPrompt(message_id="m2", text="next"))
        (record,) = _trajectory_records(caplog, "claude.task.updated")
        assert record["parent_tool_use_id"] == "parent-late" and record["message_id"] == "m2"

    @pytest.mark.parametrize("kind", ["notification", "updated"])
    async def test_injected_terminal_task_messages_still_evict_parent_mappings(
        self, tmp_path: Path, trajectory_log, caplog, kind
    ) -> None:
        if kind == "notification":
            terminal = TaskNotificationMessage(
                subtype="task_notification",
                data={},
                task_id="task",
                status="completed",
                output_file="file",
                summary="injected-summary",
                uuid="n",
                session_id="sess",
            )
        else:
            terminal = TaskUpdatedMessage(
                subtype="task_updated",
                data={},
                task_id="task",
                patch={"status": "completed"},
                status="completed",
            )
        h = Harness(
            tmp_path,
            log=trajectory_log,
            turns=[
                [
                    TaskStartedMessage(
                        subtype="task_started",
                        data={},
                        task_id="task",
                        description="inspect",
                        uuid="u",
                        session_id="sess",
                        tool_use_id="parent",
                    ),
                    _result(0.1),
                ],
                [
                    UserMessage(content="injected content", origin={"kind": "task-notification"}),
                    terminal,
                    _result(0.15, origin={"kind": "task-notification"}),
                    _result(0.2),
                ],
            ],
        )
        await h.harness.open()
        await h.harness.create_session()
        await _run(h.harness)
        assert h.harness._trajectory._task_parents == {"task": "parent"}
        events, outcome = await _run(h.harness, HarnessPrompt(message_id="m2", text="next"))
        assert outcome.success and not h.harness._trajectory._task_parents
        assert [event["type"] for event in events] == ["step_finish"]
        assert not _trajectory_records(caplog, "claude.task." + kind)
        assert "injected-summary" not in json.dumps(_trajectory_records(caplog))

    @pytest.mark.parametrize("failure", ["logger", "serialization"])
    async def test_logging_failures_do_not_fail_the_turn(
        self, tmp_path: Path, monkeypatch, failure
    ) -> None:
        log = MagicMock()
        if failure == "logger":
            log.info.side_effect = RuntimeError("logging handler failed")
        h = Harness(
            tmp_path,
            turns=[
                [
                    SystemMessage(subtype="init", data={}),
                    AssistantMessage(
                        content=[
                            TextBlock("hello"),
                            ToolUseBlock(id="tu", name="Bash", input={"command": "ls"}),
                        ],
                        model="m",
                    ),
                    UserMessage(content=[ToolResultBlock(tool_use_id="tu", content="ok")]),
                    _result(0.1),
                ]
            ],
            log=log,
            client_kwargs={"stderr_on_connect": "diagnostic"},
        )
        if failure == "serialization":
            monkeypatch.setattr(
                h.harness._trajectory,
                "_preview",
                MagicMock(side_effect=ValueError("serialization failed")),
            )
        await h.harness.open()
        await h.harness.create_session()
        events, outcome = await _run(h.harness)
        assert outcome.success and outcome.message_cost_usd == 0.1
        assert [event["type"] for event in events] == [
            "step_start",
            "token",
            "tool_call",
            "tool_call",
            "step_finish",
        ]

    async def test_tool_logs_precede_failed_delivery(
        self, tmp_path: Path, trajectory_log, caplog
    ) -> None:
        h = Harness(
            tmp_path,
            turns=[
                [
                    AssistantMessage(
                        content=[
                            ToolUseBlock(id="one", name="Read", input={"file_path": "a"}),
                            ToolUseBlock(id="two", name="Read", input={"file_path": "b"}),
                        ],
                        model="m",
                    )
                ]
            ],
            log=trajectory_log,
        )
        await h.harness.open()
        await h.harness.create_session()

        async def emit(_event):
            assert [
                record["call_id"] for record in _trajectory_records(caplog, "claude.tool.started")
            ] == ["one", "two"]
            raise RuntimeError("control plane disconnected")

        outcome = await h.harness.run_prompt(HarnessPrompt(message_id="m1", text="hi"), emit)
        assert not outcome.success
        (record,) = _trajectory_records(caplog, "claude.turn.failed")
        assert "control plane disconnected" in record["error_preview"]

    @pytest.mark.parametrize(
        "failure", ["stream_end", "connect_error", "invalid_model", "inactivity"]
    )
    async def test_failures_without_sdk_results_are_logged(
        self, tmp_path: Path, trajectory_log, caplog, failure
    ) -> None:
        h = Harness(
            tmp_path,
            turns=[[]],
            log=trajectory_log,
            client_kwargs={
                "fail_connect": failure == "connect_error",
                "hang": failure == "inactivity",
            },
            limits=PromptLimits(
                inactivity_timeout_seconds=0.01,
                prompt_max_duration_seconds=5.0,
                prompt_cleanup_timeout_seconds=1.0,
            ),
        )
        await h.harness.open()
        await h.harness.create_session()
        _, outcome = await _run(
            h.harness,
            HarnessPrompt(
                message_id="m1",
                text="hi",
                model="openai/gpt-5" if failure == "invalid_model" else None,
            ),
        )
        assert not outcome.success
        (record,) = _trajectory_records(caplog, "claude.turn.failed")
        assert record["error_preview"] == outcome.error
        assert record["message_id"] == "m1" and record["duration_s"] >= 0
        assert "sdk_status" not in record

    async def test_cancellation_is_logged_and_still_propagates(
        self, tmp_path: Path, trajectory_log, caplog
    ) -> None:
        h = Harness(tmp_path, turns=[[]], log=trajectory_log, client_kwargs={"hang": True})
        await h.harness.open()
        await h.harness.create_session()
        task = asyncio.create_task(_run(h.harness))
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        (record,) = _trajectory_records(caplog, "claude.turn.cancelled")
        assert record["status"] == "cancelled" and record["message_id"] == "m1"


class TestDefaultTranscriptLookup:
    """The transcript lives under the child's config dir, not the bridge's."""

    def test_finds_the_transcript_under_the_config_dir(self, tmp_path: Path) -> None:
        from sandbox_runtime.harness.claude import _default_transcript_exists

        config_dir = tmp_path / "claude-config"
        session_id = "617347e9-9ff5-4205-9efe-c185b3459127"
        project_dir = config_dir / "projects" / "-private-tmp-repo"
        project_dir.mkdir(parents=True)
        (project_dir / f"{session_id}.jsonl").write_text("{}\n")

        # The workdir spelling need not match the child's canonical project key.
        assert _default_transcript_exists(session_id, tmp_path / "repo", config_dir)
        assert not _default_transcript_exists(
            "00000000-0000-4000-8000-000000000000", tmp_path / "repo", config_dir
        )
        assert not _default_transcript_exists("not-a-uuid", tmp_path / "repo", config_dir)
        assert not _default_transcript_exists(session_id, tmp_path / "repo", tmp_path / "missing")

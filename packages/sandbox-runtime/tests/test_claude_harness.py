"""ClaudeHarness against a scripted fake of the SDK client.

Covers the §5.2 translation table, the §5.3 cost-baseline rule, the
credential-at-open contract, the reconnect policy, and terminalisation
ownership (the harness returns a TurnOutcome and never emits
execution_complete).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock

import pytest
from claude_agent_sdk import (
    AssistantMessage,
    ConversationResetMessage,
    RateLimitEvent,
    RateLimitInfo,
    ResultMessage,
    StreamEvent,
    SystemMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from sandbox_runtime.credentials.provider_credential_client import (
    RuntimeCredentialDenied,
    RuntimeCredentialUnavailable,
)
from sandbox_runtime.harness import AgentHarness, HarnessPrompt, HarnessStartError, PromptLimits
from sandbox_runtime.harness.claude import (
    AUTHENTICATION_FAILED_MESSAGE,
    ClaudeHarness,
    ClaudeHarnessConfig,
    bare_model_id,
    mcp_server_options,
    reasoning_options,
)
from sandbox_runtime.harness.claude_env import ClaudeAuthMode

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
    fail_connect: bool = False

    async def connect(self) -> None:
        if self.fail_connect:
            raise RuntimeError("spawn failed")
        if self.hang_connect:
            await asyncio.Event().wait()
        self.connected = True

    async def disconnect(self) -> None:
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
            log=MagicMock(),
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
                model="anthropic/claude-opus-4-6",
                reasoning_effort="high",
            ),
        )
        options = h.client.options
        assert options["cwd"] == str(tmp_path / "repo")
        assert options["cli_path"] == str(h.harness.wrapper_path)
        assert options["model"] == "claude-opus-4-6"
        assert options["effort"] == "high"
        assert options["permission_mode"] == "dontAsk"
        assert options["disallowed_tools"] == ["AskUserQuestion"]
        assert options["setting_sources"] == ["user", "project"]
        assert options["include_partial_messages"] is True
        assert options["forward_subagent_text"] is False
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

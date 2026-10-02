"""Reusable scripted SDK and credential fakes for Claude harness tests."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock

from claude_agent_sdk import ResultMessage, StreamEvent

from sandbox_runtime.constants import USER_SECRET_KEYS_ENV_VAR
from sandbox_runtime.harness import HarnessPrompt, PromptLimits
from sandbox_runtime.harness.claude import ClaudeHarness, ClaudeHarnessConfig

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
        environ = {USER_SECRET_KEYS_ENV_VAR: "[]", **environ}
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

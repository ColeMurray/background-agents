"""Shared test fixtures and utilities for sandbox-runtime tests."""

from typing import TYPE_CHECKING, Any

import httpx
import pytest

from sandbox_runtime.harness import EventSink, HarnessPrompt, PromptLimits, TurnOutcome
from sandbox_runtime.harness.opencode import OpencodeHarness
from sandbox_runtime.harness.opencode_client import OpenCodeClient

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Callable

    from sandbox_runtime.bridge import AgentBridge


@pytest.fixture(autouse=True)
def isolate_runtime_file_paths(tmp_path, monkeypatch):
    """Redirect the runtime's fixed file paths to per-test locations.

    This suite routinely runs inside a live Open-Inspect sandbox (agents
    dogfooding on this repo), where /tmp/oi-repo-manifest.json is the running
    session's real manifest. A test that drives a real SandboxSupervisor
    (e.g. ``await sup.run()``) would otherwise overwrite it with fixture
    repos, which breaks push targeting and PR creation for the live session —
    and likewise delete the live boot-warnings file or read the live
    tunnel-env file. Tests that care about a specific path still patch it
    themselves; this fixture is the backstop that keeps every other test off
    the real files.
    """
    manifest_path = str(tmp_path / "oi-repo-manifest.json")
    boot_warnings_path = str(tmp_path / "oi-boot-warnings.jsonl")
    tunnel_env_path = str(tmp_path / ".tunnels.env")
    monkeypatch.setattr("sandbox_runtime.repository_boot.REPO_MANIFEST_FILE_PATH", manifest_path)
    monkeypatch.setattr("sandbox_runtime.bridge.REPO_MANIFEST_FILE_PATH", manifest_path)
    monkeypatch.setattr("sandbox_runtime.boot_warnings.BOOT_WARNINGS_FILE_PATH", boot_warnings_path)
    monkeypatch.setattr("sandbox_runtime.supervisor.BOOT_WARNINGS_FILE_PATH", boot_warnings_path)
    monkeypatch.setattr("sandbox_runtime.bridge.BOOT_WARNINGS_FILE_PATH", boot_warnings_path)
    monkeypatch.setattr("sandbox_runtime.tunnel_environment.TUNNEL_ENV_FILE_PATH", tunnel_env_path)
    monkeypatch.setattr("sandbox_runtime.hook_logs.HOOK_LOG_ROOT", tmp_path / "runtime-hook-logs")


def wire_opencode_transport(bridge: "AgentBridge", http_client: Any) -> Any:
    """Point a bridge's OpenCode harness at a fake HTTP transport (test seam).

    Rebuilds ``bridge.harness`` around the fake (carrying the vendor session
    id over), so the lazily built prompt stream rebinds to the new client,
    and stashes the fake on ``bridge.http_client`` so tests can read it back
    to script responses. Returns the fake for convenience.
    """
    previous = bridge.harness
    assert isinstance(previous, OpencodeHarness)
    harness = OpencodeHarness(
        client=OpenCodeClient(
            base_url=f"http://localhost:{bridge.opencode_port}",
            log=bridge.log,
            http_client=http_client,
        ),
        attachment_processor=bridge.attachment_processor,
        log=bridge.log,
        limits=previous.limits,
    )
    harness.session_id = previous.session_id
    bridge.harness = harness
    bridge.http_client = http_client
    return http_client


def set_prompt_limits(bridge: "AgentBridge", **overrides: float) -> None:
    """Adjust per-prompt budgets before the harness builds its prompt stream."""
    from dataclasses import replace

    assert isinstance(bridge.harness, OpencodeHarness)
    bridge.prompt_limits = replace(bridge.prompt_limits, **overrides)
    bridge.harness.limits = bridge.prompt_limits


def stream_opencode_events(
    bridge: "AgentBridge",
    message_id: str,
    content: str,
    *,
    model: str | None = None,
    reasoning_effort: str | None = None,
    attachments: list[Any] | None = None,
) -> "AsyncIterator[dict[str, Any]]":
    """The raw translated event stream of one OpenCode prompt (what run_prompt drains)."""
    assert isinstance(bridge.harness, OpencodeHarness)
    return bridge.harness.stream_events(
        HarnessPrompt(
            message_id=message_id,
            text=content,
            model=model,
            reasoning_effort=reasoning_effort,
            attachments=tuple(attachments or ()),
        )
    )


class ScriptedHarness:
    """An ``AgentHarness`` that replays a scripted event stream (bridge tests).

    ``stream`` is an async-generator function; it is called once per prompt
    and its events are emitted verbatim. The outcome is derived exactly as
    the OpenCode harness derives it: an ``error`` event fails the turn, the
    last ``step_finish.messageCostUsd`` is the turn cost.
    """

    from sandbox_runtime.harness import HarnessId

    id = HarnessId.OPENCODE

    def __init__(
        self,
        stream: "Callable[..., AsyncIterator[dict[str, Any]]] | None" = None,
        *,
        session_id: str | None = "oc-session-123",
    ) -> None:
        self.stream = stream
        self.session_id = session_id
        self.prompts: list[HarnessPrompt] = []
        self.abort_calls = 0
        self.opened = False
        self.closed = False

    async def open(self) -> None:
        self.opened = True

    async def close(self) -> None:
        self.closed = True

    async def resume_session(self, persisted_id: str) -> bool:
        self.session_id = persisted_id
        return True

    async def create_session(self) -> None:
        self.session_id = self.session_id or "oc-session-new"

    async def run_prompt(self, prompt: HarnessPrompt, emit: EventSink) -> TurnOutcome:
        self.prompts.append(prompt)
        if self.stream is None:
            return TurnOutcome.ok()
        error: str | None = None
        cost: float | None = None
        async for event in self.stream(prompt.message_id, prompt.text):
            if event.get("type") == "error":
                error = str(event.get("error"))
            if event.get("type") == "step_finish" and "messageCostUsd" in event:
                cost = event["messageCostUsd"]
            await emit(event)
        if error is not None:
            return TurnOutcome.failed(error, message_cost_usd=cost)
        return TurnOutcome.ok(message_cost_usd=cost)

    async def abort(self) -> bool:
        self.abort_calls += 1
        return True

    async def stop(self, deadline_monotonic: float) -> bool:
        # This fixture owns only the consumed generator, not external tools.
        # Its prompt reader has already unwound when the bridge calls stop.
        self.abort_calls += 1
        return True


__all__ = [
    "MockResponse",
    "PromptLimits",
    "ScriptedHarness",
    "oc_message_id",
    "set_prompt_limits",
    "stream_opencode_events",
    "wire_opencode_transport",
]


class MockResponse:
    """Mock HTTP response for testing."""

    def __init__(self, status_code: int, json_data: Any = None, text: str = ""):
        self.status_code = status_code
        self._json_data = json_data
        self.text = text

    def json(self) -> Any:
        return self._json_data

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"HTTP {self.status_code}",
                request=httpx.Request("GET", "http://test"),
                response=httpx.Response(self.status_code),
            )


def oc_message_id(timestamp_ms: int, counter: int, suffix: str = "a") -> str:
    """Build a valid OpenCode ascending message ID at a chosen creation point.

    Mirrors OpenCodeIdentifier's format: ``msg_`` + 12 hex chars encoding
    ``timestamp_ms * 0x1000 + counter`` + 14 base62 chars. Deterministic
    inputs let boundary tests place IDs immediately before, at, or after a
    prompt's user message instead of relying on ad-hoc strings that happen
    to compare in the desired order.
    """
    encoded = (timestamp_ms * 0x1000 + counter) & 0xFFFFFFFFFFFF
    return "msg_" + encoded.to_bytes(6, byteorder="big").hex() + (suffix * 14)[:14]

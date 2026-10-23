"""Shared test fixtures and utilities for sandbox-runtime tests."""

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import TYPE_CHECKING, Any

import httpx
import pytest

from sandbox_runtime.harness import EventSink, HarnessPrompt, PromptLimits, TurnOutcome
from sandbox_runtime.harness.codex.client import CodexClient
from sandbox_runtime.harness.opencode import OpencodeHarness
from sandbox_runtime.harness.opencode_client import OpenCodeClient

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Callable

    from sandbox_runtime.bridge import AgentBridge


SANDBOX_SESSION_ENV_VARS = (
    "CONTROL_PLANE_URL",
    "SANDBOX_AUTH_TOKEN",
    "SESSION_CONFIG",
    "VCS_CLONE_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_APP_TOKEN",
)


@pytest.fixture(autouse=True)
def isolate_sandbox_credentials(monkeypatch):
    """Strip live-session credentials from the test environment.

    This suite routinely runs inside a live Open-Inspect sandbox, whose
    session credentials (control-plane URL, sandbox auth token, session
    config, SCM tokens) would otherwise route credential-helper tests to the
    real control plane and change which fallback paths they take. CI
    (GitHub Actions) likewise sets GITHUB_TOKEN. Tests that need any of these
    set them explicitly.
    """
    for key in SANDBOX_SESSION_ENV_VARS:
        monkeypatch.delenv(key, raising=False)


@pytest.fixture(autouse=True)
def isolate_runtime_file_paths(tmp_path, monkeypatch):
    """Redirect the runtime's fixed file paths to per-test locations.

    This suite routinely runs inside a live Open-Inspect sandbox (agents
    dogfooding on this repo), where /tmp/oi-repo-manifest.json is the running
    session's real manifest. A test that drives a real SandboxSupervisor
    (e.g. ``await sup.run()``) would otherwise overwrite it with fixture
    repos, which breaks push targeting and PR creation for the live session —
    and likewise truncate the live boot-events file or read the live
    tunnel-env file. ``build_supervisor()`` would also apply the image-baked
    runtime environment, overriding test-controlled ``HOME`` and
    ``XDG_CONFIG_HOME``; it gets an absent per-test file instead. Tests that
    care about a specific path still patch it themselves; this fixture is the
    backstop that keeps every other test off the real files.
    """
    manifest_path = str(tmp_path / "oi-repo-manifest.json")
    boot_events_path = str(tmp_path / "oi-boot-events.jsonl")
    tunnel_env_path = str(tmp_path / ".tunnels.env")
    image_environment_path = tmp_path / "openinspect-runtime-environment.json"
    monkeypatch.setattr("sandbox_runtime.repository_boot.REPO_MANIFEST_FILE_PATH", manifest_path)
    monkeypatch.setattr("sandbox_runtime.bridge.REPO_MANIFEST_FILE_PATH", manifest_path)
    monkeypatch.setattr("sandbox_runtime.boot_events.BOOT_EVENTS_FILE_PATH", boot_events_path)
    monkeypatch.setattr("sandbox_runtime.boot_attach.BOOT_EVENTS_FILE_PATH", boot_events_path)
    monkeypatch.setattr("sandbox_runtime.tunnel_environment.TUNNEL_ENV_FILE_PATH", tunnel_env_path)
    monkeypatch.setattr(
        "sandbox_runtime.image_environment.IMAGE_ENVIRONMENT_PATH", image_environment_path
    )
    # An image-build test would otherwise run the real OpenCode, which downloads
    # the model catalog into the live session's cache.
    monkeypatch.setattr("sandbox_runtime.supervisor.OPENCODE_MODELS_REFRESH_COMMAND", ("true",))


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
    bridge.boot_attach.harness = harness
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
    max_duration_seconds: float | None = None,
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
            max_duration_seconds=max_duration_seconds,
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


# Released-binary Codex fixtures. Synthetic auth; loopback Responses only.


@pytest.fixture
def responses():
    # A scripted entry {"subagent": item} answers the next sub-agent request;
    # every other entry answers the next parent request, in order.
    received, scripted_items = [], []
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            payload = json.dumps(
                {
                    "accounts": [
                        {
                            "id": "workspace-fixture",
                            "workspace_backend_origin": "https://fixture.invalid",
                            "account_routing_override": "NO_CONSTRAINT",
                        }
                    ]
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if not self.path.endswith("/responses"):
                self.send_error(404)
                return
            subagent = bool(self.headers.get("x-openai-subagent"))
            with lock:
                received.append(
                    {"body": body, "auth": self.headers.get("Authorization"), "subagent": subagent}
                )
                index = len(received)
                entry = next((e for e in scripted_items if ("subagent" in e) == subagent), None)
                if entry is not None:
                    scripted_items.remove(entry)
            if entry is not None and "http_status" in entry:
                body = b'{"error":{"message":"unauthorized"}}'
                self.send_response(entry["http_status"])
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            events = [
                {"type": "response.created", "response": {"id": f"r{index}"}},
                {
                    "type": "response.output_item.done",
                    "item": {
                        "type": "message",
                        "role": "assistant",
                        "id": f"m{index}",
                        "content": [{"type": "output_text", "text": f"answer {index}"}],
                    },
                },
                {
                    "type": "response.completed",
                    "response": {
                        "id": f"r{index}",
                        "usage": {
                            "input_tokens": 100,
                            "output_tokens": 20,
                            "total_tokens": 120,
                            "input_tokens_details": {"cached_tokens": 0},
                            "output_tokens_details": {"reasoning_tokens": 5},
                        },
                    },
                },
            ]
            if entry is not None:
                events[1]["item"] = entry.get("subagent", entry)
            for event in events:
                self.wfile.write(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n".encode())
            self.wfile.flush()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1", received, scripted_items
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.fixture
def native_factory(tmp_path, responses):
    endpoint, _, _ = responses

    class NativeFixtureClient(CodexClient):
        # Synthetic-only fixture diagnostics, never enabled in production.
        diagnostics = b""
        native_error = None
        auth_logins = 0

        async def request(self, method, params, **kwargs):
            if method == "account/login/start":
                self.auth_logins += 1
            return await super().request(method, params, **kwargs)

        async def next_notification(self):
            frame = await super().next_notification()
            if frame.get("method") == "turn/completed":
                self.native_error = frame.get("params", {}).get("turn", {}).get("error")
            return frame

        async def _drain_stderr(self):
            while chunk := await self._process.stderr.read(8192):
                self.diagnostics = (self.diagnostics + chunk)[-16384:]

        async def close(self, **kwargs):
            stopped = await super().close(**kwargs)
            assert stopped, (self._process.returncode, self.diagnostics.decode(errors="replace"))
            return stopped

    def factory(**kwargs):
        # Explicit test-only endpoint authority; production has no endpoint
        # injection option and always runs under the Linux ownership domain.
        args = kwargs["command"][3:]
        # Original tuple is python, owner, native, -c..., app-server...
        cut = args.index("app-server")
        provider = (
            'model_providers.fixture={name="OpenAI",base_url='
            + json.dumps(endpoint)
            + ',wire_api="responses",requires_openai_auth=true,request_max_retries=0,stream_max_retries=0}'
        )
        native_command = (
            os.environ["OI_TEST_CODEX_BINARY"],
            *args[:cut],
            "-c",
            'model_provider="fixture"',
            "-c",
            provider,
            "-c",
            "features.enable_request_compression=false",
            "-c",
            "chatgpt_base_url="
            + json.dumps(endpoint.replace("127.0.0.1", "localhost").removesuffix("/v1")),
            *args[cut:],
        )
        linux = sys.platform.startswith("linux")
        kwargs["command"] = (*kwargs["command"][:2], *native_command) if linux else native_command
        kwargs["containment_owner"] = linux
        kwargs["env"] = {**kwargs["env"], "HOME": str(tmp_path)}
        return NativeFixtureClient(**kwargs)

    return factory

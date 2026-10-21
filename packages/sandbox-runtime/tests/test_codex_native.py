"""Opt-in released-binary checks. Synthetic auth; loopback Responses only.

Run with OI_TEST_CODEX_BINARY pointing to the pinned executable, never a
developer's Codex home. This macOS-capable fixture is NOT Linux containment proof.
"""

import asyncio
import base64
import json
import os
import shlex
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.harness.base import HarnessPrompt, PromptLimits
from sandbox_runtime.harness.codex import CodexHarness, CodexHarnessConfig
from sandbox_runtime.harness.codex.client import CodexClient
from sandbox_runtime.model_prices import ModelPriceCatalog

BINARY = os.environ.get("OI_TEST_CODEX_BINARY")
CATALOG = Path(__file__).parent / "fixtures/reasoning-models.json"
pytestmark = pytest.mark.skipif(
    not BINARY, reason="Set OI_TEST_CODEX_BINARY for pinned native integration"
)


@pytest.mark.parametrize(
    "action,tool,args",
    [
        (
            {"type": "open_page", "url": "https://example.com"},
            "webfetch",
            {"url": "https://example.com"},
        ),
        (
            {"type": "find_in_page", "url": "https://example.com", "pattern": "release"},
            "webfetch",
            {"url": "https://example.com", "pattern": "release"},
        ),
        ({"type": "search", "query": "Codex MCP"}, "websearch", {"query": "Codex MCP"}),
    ],
)
async def test_native_web_actions_project_url_and_query(
    tmp_path, responses, native_factory, action, tool, args
):
    _, _, scripted = responses
    scripted.append(
        {"type": "web_search_call", "id": "web-fixture", "status": "completed", "action": action}
    )
    harness = CodexHarness(
        config=CodexHarnessConfig(tmp_path, tmp_path / "state", "gpt-6.1-sol", False),
        log=MagicMock(),
        limits=PromptLimits(1, 30, 5),
        client_factory=native_factory,
        environ={"OPENAI_API_KEY": "synthetic"},
    )
    events = []

    async def emit(event):
        events.append(event)

    try:
        result = await harness.run_prompt(HarnessPrompt("m", "Use the web"), emit)
        assert result.success, result
    finally:
        await harness.close()
    calls = [event for event in events if event["type"] == "tool_call"]
    completed = [event for event in calls if event["status"] == "completed"]
    assert len(completed) == 1
    assert completed[0]["tool"] == tool
    assert completed[0]["args"] == args
    assert all(event["callId"] == completed[0]["callId"] for event in calls)


@pytest.fixture
def remote_mcp(request):
    observed = []
    expected_auth = request.param

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            frame = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            observed.append((frame.get("method"), self.headers.get("Authorization")))
            if self.headers.get("Authorization") != expected_auth:
                self.send_response(401)
                self.end_headers()
                return
            if "id" not in frame:
                self.send_response(202)
                self.end_headers()
                return
            if frame["method"] == "initialize":
                result = {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "remote-fixture", "version": "1"},
                }
            elif frame["method"] == "tools/list":
                result = {
                    "tools": [
                        {
                            "name": "ready",
                            "description": "Check remote readiness",
                            "inputSchema": {"type": "object", "properties": {}},
                        }
                    ]
                }
            else:
                result = {"content": [{"type": "text", "text": "remote ready"}]}
            body = json.dumps({"jsonrpc": "2.0", "id": frame["id"], "result": result}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/mcp", observed, expected_auth
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.fixture
def responses():
    received, scripted_items = [], []

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
            received.append({"body": body, "auth": self.headers.get("Authorization")})
            if scripted_items and "http_status" in scripted_items[0]:
                body = b'{"error":{"message":"unauthorized"}}'
                self.send_response(scripted_items.pop(0)["http_status"])
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            index = len(received)
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
            if scripted_items:
                events[1]["item"] = scripted_items.pop(0)
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
            BINARY,
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


@pytest.mark.parametrize("subscription", [False, True])
@pytest.mark.parametrize("git_repository", [False, True])
async def test_native_auth_two_turns_restart_resume_and_no_persisted_secret(
    tmp_path, responses, subscription, native_factory, git_repository
):
    _, requests, _ = responses
    native_home, workspace = tmp_path / "state", tmp_path / "workspace"
    workspace.mkdir()
    if git_repository:
        import subprocess

        subprocess.run(["git", "init", "--quiet", str(workspace)], check=True)
    token = "sk-synthetic-fixture"
    account_id = "workspace-fixture"
    if subscription:

        def encode(value):
            return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

        token = (
            encode({"alg": "none"})
            + "."
            + encode(
                {
                    "email": "fixture@example.com",
                    "https://api.openai.com/auth": {
                        "chatgpt_account_id": account_id,
                        "chatgpt_plan_type": "pro",
                    },
                }
            )
            + ".sig"
        )

    class Broker:
        async def fetch(self, **kwargs):
            from sandbox_runtime.credentials.openai_access_token_client import OpenAIAccessToken

            return OpenAIAccessToken(token, account_id, 1, 9999999999999)

    def build():
        return CodexHarness(
            config=CodexHarnessConfig(workspace, native_home, "gpt-6.1-sol", subscription),
            log=MagicMock(),
            limits=PromptLimits(1, 30, 5),
            credential_client=Broker() if subscription else None,
            client_factory=native_factory,
            environ={"PATH": os.environ["PATH"], "OPENAI_API_KEY": token},
            prices=ModelPriceCatalog(CATALOG, MagicMock()),
        )

    events = []

    async def emit(event):
        events.append(event)

    harness = build()
    try:
        await harness.open()
        if git_repository:
            # The bridge creates the native session during prompt preflight.
            await harness.create_session()
            assert (native_home / "config.toml").exists()
        result = await harness.run_prompt(
            HarnessPrompt("m1", "Remember sapphire. Reply once."), emit
        )
        assert result.success, result
        # gpt-6.1-sol: 100 input at $2/M, 15 output and 5 reasoning at $10/M. A
        # subscription reports the same model-price equivalent.
        assert result.message_cost_usd == 0.0004
        thread_id = harness.session_id
        result = await harness.run_prompt(HarnessPrompt("m2", "Recall the previous marker."), emit)
        assert result.success, result
        assert result.message_cost_usd == 0.0004
        if not subscription:
            assert harness._client.auth_logins == 1
    finally:
        await harness.close()
    resumed = build()
    try:
        await resumed.open()
        assert resumed.session_id == thread_id
        result = await resumed.run_prompt(
            HarnessPrompt(
                "m3", "Continue after restart.", model="openai/gpt-5.6-sol", reasoning_effort="max"
            ),
            emit,
        )
        assert result.success, result
        # The restored manifest keeps a trusted baseline: gpt-5.6-sol at $4/M and $20/M.
        assert result.message_cost_usd == 0.0008
        if not subscription:
            assert resumed._client.auth_logins == 1
    finally:
        await resumed.close()
    assert len(requests) == 3
    steps = [event for event in events if event["type"] == "step_finish"]
    assert steps and any("tokens" in event for event in steps)
    assert all(event["cost"] == event["messageCostUsd"] for event in steps)
    assert [event["messageCostUsd"] for event in steps if event["reason"] == "completed"] == [
        0.0004,
        0.0004,
        0.0008,
    ]
    assert not [event for event in events if event["type"] == "warning"]
    assert all("pricingVersion" not in event and "costBasis" not in event for event in steps)
    assert all(request["auth"] == f"Bearer {token}" for request in requests)
    assert "sapphire" in json.dumps(requests[-1]["body"])
    assert requests[-1]["body"]["model"] == "gpt-5.6-sol"
    assert requests[-1]["body"]["reasoning"]["effort"] == "max"
    assert [event["content"] for event in events if event["type"] == "token"] == [
        "answer 1",
        "answer 2",
        "answer 3",
    ]
    assert not (native_home / "auth.json").exists()
    for path in native_home.rglob("*"):
        if path.is_file():
            assert token.encode() not in path.read_bytes(), path


@pytest.mark.parametrize("memory", [None, "", "OI_PINNED_MEMORY_FIRST_476"])
async def test_native_pinned_memory_and_repository_guidance_survive_resume(
    tmp_path, responses, native_factory, memory
):
    from sandbox_runtime.memories import memory_path

    _, requests, _ = responses
    workspace, state = tmp_path / "workspace", tmp_path / "state"
    workspace.mkdir()
    state.mkdir()
    repo_marker = "OI_REPOSITORY_GUIDANCE_921"
    (workspace / "AGENTS.md").write_text(repo_marker)
    if memory is not None:
        memory_path(state).write_text(memory)

    def build():
        return CodexHarness(
            config=CodexHarnessConfig(workspace, state, "gpt-6.1-sol", False),
            log=MagicMock(),
            limits=PromptLimits(1, 30, 5),
            client_factory=native_factory,
            environ={"PATH": os.environ["PATH"], "OPENAI_API_KEY": "sk-synthetic-fixture"},
        )

    harness = build()
    try:
        outcome = await harness.run_prompt(HarnessPrompt("first", "Reply once."), AsyncMock())
        assert outcome.success, outcome
        thread_id = harness.session_id
    finally:
        await harness.close()
    first = json.dumps(requests[0]["body"])
    assert repo_marker in first
    if memory:
        assert memory in first
    else:
        assert "OI_PINNED_MEMORY_" not in first
        memory_path(state).unlink(missing_ok=True)

    resumed = build()
    try:
        await resumed.open()
        assert resumed.session_id == thread_id
        outcome = await resumed.run_prompt(HarnessPrompt("next", "Continue."), AsyncMock())
        assert outcome.success, outcome
    finally:
        await resumed.close()
    assert len(requests) == 2
    continued = json.dumps(requests[1]["body"])
    assert repo_marker in continued
    if memory:
        assert memory in continued
    else:
        assert "OI_PINNED_MEMORY_" not in continued


async def test_native_platform_tool_callback_survives_restart(tmp_path, responses, native_factory):
    import httpx

    from sandbox_runtime.harness.tools import ToolServerConfig

    _, requests, scripted = responses
    config = CodexHarnessConfig(
        tmp_path,
        tmp_path / "state",
        "gpt-6.1-sol",
        False,
        tools=ToolServerConfig(
            "http://fixture.invalid",
            "session",
            "sandbox-auth",
            tmp_path / "repos.json",
            False,
            False,
        ),
    )
    for turn in range(2):
        scripted.append(
            {
                "type": "function_call",
                "call_id": f"tool-{turn}",
                "namespace": "oi",
                "name": "get-child-status",
                "arguments": "{}",
            }
        )
        harness = CodexHarness(
            config=config,
            log=MagicMock(),
            limits=PromptLimits(1, 30, 5),
            client_factory=native_factory,
            environ={"OPENAI_API_KEY": "synthetic"},
        )
        harness._tool_client.request = AsyncMock(
            return_value=httpx.Response(200, json={"children": []})
        )
        try:
            result = await harness.run_prompt(
                HarnessPrompt(f"m{turn}", "List children."), AsyncMock()
            )
            assert result.success, result
            harness._tool_client.request.assert_awaited_once_with("GET", "/children")
        finally:
            await harness.close()
        assert "No child sessions found." in json.dumps(requests[-1]["body"])
    assert len(requests) == 4


async def test_native_image_attachment_is_consumed_and_staging_removed(
    tmp_path, responses, native_factory
):
    # Valid one-pixel PNG. Hydration has already checked type/size before the harness.
    content = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
    harness = CodexHarness(
        config=CodexHarnessConfig(tmp_path, tmp_path / "state", "gpt-6.1-sol", False),
        log=MagicMock(),
        limits=PromptLimits(1, 30, 5),
        client_factory=native_factory,
        environ={"OPENAI_API_KEY": "synthetic"},
    )
    try:
        result = await harness.run_prompt(
            HarnessPrompt(
                "m",
                "Describe image",
                attachments=({"type": "image", "mimeType": "image/png", "content": content},),
            ),
            AsyncMock(),
        )
        assert result.success, result
        assert "input_image" in json.dumps(responses[1][0]["body"])
        assert not list((tmp_path / "state" / "openinspect-input").iterdir())
    finally:
        await harness.close()


@pytest.mark.parametrize("env_field", [None, "env", "environment"])
async def test_native_local_mcp_environment_and_disabled_server_isolation(
    tmp_path, responses, native_factory, env_field
):
    _, requests, scripted = responses
    scripted.append(
        {
            "type": "function_call",
            "call_id": "mcp-fixture-call",
            "namespace": "mcp__fixture",
            "name": "ready",
            "arguments": "{}",
        }
    )
    secret = "synthetic-mcp-credential-never-persist"
    server = {
        "name": "fixture",
        "type": "local",
        "command": [
            sys.executable,
            str(Path(__file__).parent / "fixtures" / "codex_mcp_server.py"),
        ],
    }
    if env_field:
        server[env_field] = {"FIXTURE_MCP_SECRET": "synthetic-active-server-credential"}
    servers = (
        server,
        {
            "name": "disabled",
            "enabled": False,
            "command": ["unused"],
            "environment": {"FIXTURE_MCP_SECRET": secret},
        },
    )
    harness = CodexHarness(
        config=CodexHarnessConfig(
            tmp_path, tmp_path / "state", "gpt-6.1-sol", False, mcp_servers=servers
        ),
        log=MagicMock(),
        limits=PromptLimits(1, 30, 5),
        client_factory=native_factory,
        environ={
            "OPENAI_API_KEY": "synthetic",
            "SESSION_CONFIG": json.dumps({"mcp_servers": servers}),
            "OI_MCP_0_HEADER_0": secret,
        },
    )
    try:
        result = await harness.run_prompt(HarnessPrompt("m", "Check MCP"), AsyncMock())
        assert result.success, result
        assert len(requests) == 2
        expected = "credential present" if env_field else "credential missing"
        assert expected in json.dumps(requests[-1]["body"])
    finally:
        await harness.close()
    for path in harness.config.state_dir.rglob("*"):
        if path.is_file():
            assert secret.encode() not in path.read_bytes(), path
    assert not (harness.config.state_dir / "shell_snapshots").exists()


@pytest.mark.parametrize(
    "remote_mcp,header_field",
    [
        (None, "headers"),
        ("Bearer synthetic-linear-token", "headers"),
        ("Bearer synthetic-linear-token", "env"),
    ],
    indirect=["remote_mcp"],
)
@pytest.mark.parametrize("subscription", [False, True])
async def test_native_remote_mcp_headers(
    tmp_path, responses, native_factory, remote_mcp, header_field, subscription
):
    _, requests, scripted = responses
    url, observed, auth = remote_mcp
    scripted.append(
        {
            "type": "function_call",
            "call_id": "remote-fixture-call",
            "namespace": "mcp__fixture",
            "name": "ready",
            "arguments": "{}",
        }
    )
    # The fixture rejects unauthenticated requests in the authenticated cases.
    server = {
        "name": "fixture",
        "type": "remote",
        "url": url,
        header_field: {"Authorization": auth} if auth else {},
    }
    from sandbox_runtime.credentials.openai_access_token_client import OpenAIAccessToken

    claims = {
        "email": "fixture@example.com",
        "https://api.openai.com/auth": {
            "chatgpt_account_id": "workspace-fixture",
            "chatgpt_plan_type": "pro",
        },
    }
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    token = OpenAIAccessToken(
        f"eyJhbGciOiJub25lIn0.{payload}.sig", "workspace-fixture", 1, 9999999999999
    )
    broker = MagicMock(fetch=AsyncMock(return_value=token))
    harness = CodexHarness(
        config=CodexHarnessConfig(
            tmp_path, tmp_path / "state", "gpt-6.1-sol", subscription, mcp_servers=(server,)
        ),
        log=MagicMock(),
        limits=PromptLimits(1, 30, 5),
        client_factory=native_factory,
        credential_client=broker if subscription else None,
        environ={"OPENAI_API_KEY": "synthetic"},
    )
    try:
        result = await harness.run_prompt(HarnessPrompt("m", "Check remote MCP"), AsyncMock())
        assert result.success, result
        assert "remote ready" in json.dumps(requests[-1]["body"])
    finally:
        await harness.close()
    assert {"initialize", "tools/list", "tools/call"} <= {method for method, _ in observed}
    assert all(observed_auth == auth for _, observed_auth in observed)
    assert not (harness.config.state_dir / "shell_snapshots").exists()


async def test_native_long_answer_has_bounded_final_projection(tmp_path, responses, native_factory):
    from sandbox_runtime.event_size import MAX_EVENT_BYTES, event_size_bytes

    _, _, scripted = responses
    scripted.append(
        {
            "type": "message",
            "role": "assistant",
            "id": "long-answer",
            "content": [{"type": "output_text", "text": "\U0001f642" * 100_000}],
        }
    )
    harness = CodexHarness(
        config=CodexHarnessConfig(tmp_path, tmp_path / "state", "gpt-6.1-sol", False),
        log=MagicMock(),
        limits=PromptLimits(1, 30, 5),
        client_factory=native_factory,
        environ={"OPENAI_API_KEY": "synthetic"},
    )
    emit = AsyncMock()
    try:
        result = await harness.run_prompt(HarnessPrompt("m", "Return long answer"), emit)
        assert result.success, result
        tokens = [call.args[0] for call in emit.call_args_list if call.args[0]["type"] == "token"]
        assert tokens
        assert all(event_size_bytes(event) < MAX_EVENT_BYTES for event in tokens)
        assert "remaining text omitted" in tokens[-1]["content"]
    finally:
        await harness.close()


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="Linux native shell execution")
async def test_native_command_inherits_sandbox_session_context(tmp_path, responses, native_factory):
    _, requests, scripted = responses
    secret = "synthetic-disabled-mcp-credential"
    servers = (
        {
            "name": "disabled",
            "enabled": False,
            "url": "https://unused.invalid",
            "headers": {"Authorization": secret},
        },
    )
    check = (
        "import json, os; "
        "assert json.loads(os.environ['SESSION_CONFIG'])['sessionId'] == 'session-1'; "
        "assert os.environ['SANDBOX_AUTH_TOKEN'] == 'synthetic-sandbox-token'; "
        "assert os.environ['CONTROL_PLANE_URL'] == 'https://cp.example.invalid'; "
        "assert not any(k.startswith('OI_MCP_') for k in os.environ); "
        "print('sandbox session context available')"
    )
    command = f"{shlex.quote(sys.executable)} -c {shlex.quote(check)}"
    scripted.append(
        {
            "type": "custom_tool_call",
            "call_id": "native-env-check",
            "name": "exec",
            "namespace": "functions",
            "input": "text(await tools.exec_command("
            + json.dumps({"cmd": command, "yield_time_ms": 10000})
            + "));",
        }
    )
    harness = CodexHarness(
        config=CodexHarnessConfig(
            tmp_path, tmp_path / "state", "gpt-6.1-sol", False, mcp_servers=servers
        ),
        log=MagicMock(),
        limits=PromptLimits(1, 30, 5),
        client_factory=native_factory,
        environ={
            "OPENAI_API_KEY": "synthetic",
            "PATH": os.environ["PATH"],
            "SESSION_CONFIG": json.dumps({"sessionId": "session-1", "mcp_servers": servers}),
            "SANDBOX_AUTH_TOKEN": "synthetic-sandbox-token",
            "CONTROL_PLANE_URL": "https://cp.example.invalid",
            "OI_MCP_0_HEADER_0": secret,
        },
    )
    try:
        result = await harness.run_prompt(HarnessPrompt("m", "Check command"), AsyncMock())
        assert result.success, result
        outputs = [
            item
            for request in requests
            for item in request["body"]["input"]
            if item.get("type") in {"function_call_output", "custom_tool_call_output"}
        ]
        assert "sandbox session context available" in json.dumps(outputs)
    finally:
        await harness.close()


async def test_native_unauthorized_forces_access_only_refresh(tmp_path, responses, native_factory):
    from sandbox_runtime.credentials.openai_access_token_client import OpenAIAccessToken

    _, requests, scripted = responses
    scripted.append({"http_status": 401})
    rejected_versions = []

    def token(version):
        claims = {
            "email": "fixture@example.com",
            "jti": str(version),
            "https://api.openai.com/auth": {
                "chatgpt_user_id": "fixture-user",
                "chatgpt_account_id": "workspace-fixture",
                "chatgpt_plan_type": "pro",
            },
        }
        payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
        return f"eyJhbGciOiJub25lIn0.{payload}.sig"

    class Broker:
        async def fetch(self, **kwargs):
            rejected = kwargs.get("rejected_credential_version")
            if rejected is not None:
                rejected_versions.append(rejected)
            version = 2 if rejected_versions else 1
            return OpenAIAccessToken(
                token(version), "workspace-fixture", version, 9_999_999_999_999
            )

    harness = CodexHarness(
        config=CodexHarnessConfig(tmp_path, tmp_path / "state", "gpt-6.1-sol", True),
        log=MagicMock(),
        limits=PromptLimits(1, 30, 5),
        client_factory=native_factory,
        credential_client=Broker(),
        environ={"OPENAI_API_KEY": "must-not-fallback"},
    )
    try:
        result = await harness.run_prompt(HarnessPrompt("m", "Check refresh"), AsyncMock())
        assert result.success, f"{rejected_versions} {harness._client.native_error}"
        assert rejected_versions == [1]
        assert requests[0]["auth"] == f"Bearer {token(1)}"
        assert requests[-1]["auth"] == f"Bearer {token(2)}"
    finally:
        await harness.close()
    for path in harness.config.state_dir.rglob("*"):
        if path.is_file():
            assert token(1).encode() not in path.read_bytes(), path
            assert token(2).encode() not in path.read_bytes(), path


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="Linux execution containment")
async def test_native_cancel_contains_detached_command_writer(tmp_path, responses, native_factory):
    _, requests, scripted = responses
    output = tmp_path / "native-writes"
    writer = f"import time\nwhile True:\n with open({str(output)!r},'a') as f: f.write('x')\n time.sleep(.02)"
    parent = (
        "import subprocess,sys,time; "
        f"subprocess.Popen([sys.executable,'-c',{writer!r}],start_new_session=True); "
        "time.sleep(60)"
    )
    command = f"{shlex.quote(sys.executable)} -c {shlex.quote(parent)}"
    scripted.append(
        {
            "type": "custom_tool_call",
            "call_id": "native-exec",
            "name": "exec",
            "namespace": "functions",
            "input": "text(await tools.exec_command("
            + json.dumps({"cmd": command, "yield_time_ms": 10000})
            + "));",
        }
    )
    harness = CodexHarness(
        config=CodexHarnessConfig(tmp_path, tmp_path / "state", "gpt-6.1-sol", False),
        log=MagicMock(),
        limits=PromptLimits(1, 30, 5),
        client_factory=native_factory,
        environ={"OPENAI_API_KEY": "synthetic", "PATH": os.environ["PATH"]},
    )
    task = asyncio.create_task(
        harness.run_prompt(HarnessPrompt("m", "Run fixture command"), AsyncMock())
    )
    try:
        async with asyncio.timeout(10):
            while not output.exists():
                if task.done():
                    outputs = [
                        item
                        for request in requests
                        for item in request["body"]["input"]
                        if item.get("type") in {"function_call_output", "custom_tool_call_output"}
                    ]
                    pytest.fail(f"Native command did not start: {task.result()}; {outputs}")
                await asyncio.sleep(0.02)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 6)
        size = output.stat().st_size
        await asyncio.sleep(0.15)
        assert output.stat().st_size == size
        assert json.loads(harness._manifest_path.read_text())["threadId"] == harness.session_id
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await harness.close()


@pytest.mark.skipif(
    not os.environ.get("OI_TEST_NATIVE_RESTORE_DIR"), reason="Provider restore fixture"
)
async def test_native_provider_filesystem_restore(responses, native_factory):
    """Run on a fresh VM, then again on its filesystem snapshot in a different VM."""
    root = Path(os.environ["OI_TEST_NATIVE_RESTORE_DIR"])
    root.mkdir(parents=True, exist_ok=True)
    workspace = root / "workspace"
    workspace.mkdir(exist_ok=True)
    expected_path = root / "expected.json"
    expected = json.loads(expected_path.read_text()) if expected_path.exists() else None
    harness = CodexHarness(
        config=CodexHarnessConfig(
            workspace, root / "state", "gpt-6.1-sol", False, restored=bool(expected)
        ),
        log=MagicMock(),
        limits=PromptLimits(1, 30, 5),
        client_factory=native_factory,
        environ={
            "OPENAI_API_KEY": "synthetic-restored-key" if expected else "synthetic-initial-key"
        },
    )
    try:
        await harness.open()
        if expected:
            assert harness.session_id == expected["threadId"]
            assert (workspace / "saved-work").read_text() == "filesystem preserved"
        text = (
            "Recall previous marker after VM restore" if expected else "Remember cobalt-checkpoint"
        )
        result = await harness.run_prompt(
            HarnessPrompt("restored" if expected else "initial", text), AsyncMock()
        )
        assert result.success, result
        if expected:
            assert "cobalt-checkpoint" in json.dumps(responses[1][-1]["body"])
            assert responses[1][-1]["auth"] == "Bearer synthetic-restored-key"
        else:
            (workspace / "saved-work").write_text("filesystem preserved")
            expected_path.write_text(json.dumps({"threadId": harness.session_id}))
    finally:
        await harness.close()
    for path in (root / "state").rglob("*"):
        if path.is_file():
            assert b"synthetic-initial-key" not in path.read_bytes(), path
            assert b"synthetic-restored-key" not in path.read_bytes(), path


async def test_native_does_not_execute_discovered_hooks(tmp_path, native_factory):
    state, project_config = tmp_path / "state", tmp_path / ".codex"
    state.mkdir()
    project_config.mkdir()
    marker = tmp_path / "unapproved-hook-ran"
    hook = {
        "hooks": {
            "SessionStart": [
                {"hooks": [{"type": "command", "command": f"touch {shlex.quote(str(marker))}"}]}
            ]
        }
    }
    for directory in (state, project_config):
        (directory / "hooks.json").write_text(json.dumps(hook))
    harness = CodexHarness(
        config=CodexHarnessConfig(tmp_path, state, "gpt-6.1-sol", False),
        log=MagicMock(),
        limits=PromptLimits(1, 30, 5),
        client_factory=native_factory,
        environ={"OPENAI_API_KEY": "synthetic"},
    )
    try:
        result = await harness.run_prompt(HarnessPrompt("m", "Check hook isolation"), AsyncMock())
        assert result.success, result
    finally:
        await harness.close()
    assert not marker.exists()


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="Linux installed image probe")
async def test_native_image_probe_repeated(monkeypatch):
    from sandbox_runtime.harness.codex import probe as codex_probe

    monkeypatch.setattr(codex_probe, "CODEX_BINARY", BINARY)
    for _ in range(10):
        await codex_probe.probe()

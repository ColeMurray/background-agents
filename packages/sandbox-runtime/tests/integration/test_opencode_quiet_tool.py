"""Opt-in, real OpenCode Bash regression; no external model credentials or spend.

Run with the binary pinned by sandbox-images/toolchain.json:

    OI_RUN_REAL_OPENCODE=1 OI_OPENCODE_BINARY=/path/to/opencode \
      uv run pytest tests/integration/test_opencode_quiet_tool.py -s -v

The two named cases take roughly 21 minutes sequentially. OI_QUIET_TOOL_SECONDS
may shorten a development smoke run, but only the default cases satisfy the
quiet-duration criteria. Set OI_QUIET_TOOL_EVIDENCE_DIR to retain JSON traces
outside pytest's automatically pruned temporary directories. A localhost
deterministic model selects the actual
OpenCode Bash tool. The real bridge consumes SSE and forwards events/independent
heartbeats through a real WebSocket to a recording peer. This is deliberately
NOT a deployed control-plane/provider test: the peer does not run SessionDO or
an inactivity alarm. Deployment reproduction must additionally record runtime
generation, effective deadlines, received heartbeats and any firing watchdog.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import platform
import shlex
import shutil
import signal
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from itertools import pairwise
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.harness.opencode import OpencodeHarness
from sandbox_runtime.harness.opencode_client import OpenCodeClient

pytestmark = pytest.mark.skipif(
    os.environ.get("OI_RUN_REAL_OPENCODE") != "1",
    reason="opt-in real OpenCode regression (600 and 660 seconds)",
)

QUIET_DURATIONS_SECONDS = [
    int(value) for value in os.environ.get("OI_QUIET_TOOL_SECONDS", "600,660").split(",")
]


class _RecordingClient(OpenCodeClient):
    def __init__(self, *, evidence: dict[str, Any], **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.evidence = evidence

    async def create_session(self) -> str | None:
        self.evidence["session_creations"] += 1
        return await super().create_session()

    async def _decoded_events(self, *args: Any, **kwargs: Any):
        async for event in super()._decoded_events(*args, **kwargs):
            if event.get("type") == "server.heartbeat":
                self.evidence["opencode_heartbeats_epoch_seconds"].append(time.time())
            yield event

    async def request_stop(self, *args: Any, **kwargs: Any) -> bool:
        self.evidence["abort_requests"] += 1
        return await super().request_stop(*args, **kwargs)


def _model_handler(quiet_seconds: int, evidence: dict[str, Any], tool_pid_path: Path):
    """Return canned model responses, never replace/mock OpenCode's tool executor."""

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args: Any) -> None:
            pass

        def do_POST(self) -> None:
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            messages = body.get("messages", [])
            tool_results = [message for message in messages if message.get("role") == "tool"]
            has_bash = any(
                tool.get("function", {}).get("name") == "bash" for tool in body.get("tools", [])
            )
            if not has_bash and not tool_results:
                # Optional OpenCode title/summary requests are not tool-turn retries.
                delta = {"content": "Quiet tool regression"}
                finish_reason = "stop"
            elif tool_results:
                evidence["tool_results"] = tool_results
                evidence["followup_requests"] += 1
                delta = {"content": "quiet-followup-success"}
                finish_reason = "stop"
            else:
                evidence["tool_requests"] += 1
                arguments = {
                    "command": (
                        f"printf '%s' \"$$\" > {shlex.quote(str(tool_pid_path))}; "
                        "printf 'quiet-before-tool\\n'; "
                        f"sleep {quiet_seconds}; "
                        "printf 'quiet-after-tool\\n'"
                    ),
                    "timeout": (quiet_seconds + 120) * 1000,
                    "description": "Real quiet Bash tool regression",
                }
                evidence["tool_arguments"] = arguments
                delta = {
                    "content": "quiet-before-model",
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "call_quiet_sleep",
                            "type": "function",
                            "function": {"name": "bash", "arguments": json.dumps(arguments)},
                        }
                    ],
                }
                finish_reason = "tool_calls"
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for content, reason in [(delta, None), ({}, finish_reason)]:
                chunk = {
                    "id": "chatcmpl-quiet-regression",
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": "quiet-model",
                    "choices": [{"index": 0, "delta": content, "finish_reason": reason}],
                }
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                self.wfile.flush()
            self.wfile.write(b"data: [DONE]\n\n")

    return Handler


async def _clean_owned_tool(tool_pid_path: Path, command: str) -> None:
    """Reap only this fixture's identified detached Bash group after a failure."""
    if not tool_pid_path.exists():
        return
    tool_pid = int(tool_pid_path.read_text())
    observed = subprocess.run(
        ["ps", "-ww", "-o", "pgid=,command=", "-p", str(tool_pid)],
        text=True,
        capture_output=True,
        check=False,
    ).stdout.strip()
    if not observed:
        return
    group_id, process_command = observed.split(None, 1)
    # A PID file alone is not an ownership proof after PID reuse. Match the
    # unique temporary fixture path and the exact launcher command as well.
    assert int(group_id) == tool_pid
    assert str(tool_pid_path) in process_command and process_command.endswith(command)
    with contextlib.suppress(ProcessLookupError):
        os.killpg(tool_pid, signal.SIGTERM)
    await asyncio.sleep(0.1)
    with contextlib.suppress(ProcessLookupError):
        os.killpg(tool_pid, signal.SIGKILL)


@pytest.mark.parametrize("quiet_seconds", QUIET_DURATIONS_SECONDS)
async def test_real_opencode_quiet_bash_tool(quiet_seconds, tmp_path, monkeypatch):
    """Real sleep 600 and >CP-idle-duration sleep, with normal stream/heartbeat limits."""
    binary = os.environ.get("OI_OPENCODE_BINARY") or shutil.which("opencode")
    assert binary, "Install the sandbox-images pinned OpenCode version first"
    repository = Path(__file__).resolve().parents[4]
    pinned = json.loads((repository / "packages/sandbox-images/toolchain.json").read_text())[
        "opencode"
    ]
    observed = subprocess.check_output([binary, "--version"], text=True).strip()
    assert observed == pinned, f"Expected shipped OpenCode {pinned}, found {observed}"
    evidence: dict[str, Any] = {
        "scope": "local real OpenCode, bridge and recording WebSocket; no SessionDO/provider",
        "platform": platform.system(),
        "python_version": platform.python_version(),
        "opencode_version": observed,
        "runtime_manifest": json.loads(
            (
                repository / "packages/sandbox-runtime/src/sandbox_runtime/runtime_manifest.json"
            ).read_text()
        ),
        "quiet_seconds": quiet_seconds,
        "release_duration_case": quiet_seconds in (600, 660),
        "provider_expiry": "unknown; local process",
        "opencode_heartbeats_epoch_seconds": [],
        "bridge_heartbeats_epoch_seconds": [],
        "events": [],
        "tool_requests": 0,
        "followup_requests": 0,
        "abort_requests": 0,
        "session_creations": 0,
        "server_process_starts": 1,
        "runtime_source_sha256": {
            filename: hashlib.sha256(
                (
                    repository / "packages/sandbox-runtime/src/sandbox_runtime" / filename
                ).read_bytes()
            ).hexdigest()
            for filename in (
                "bridge.py",
                "event_forwarder.py",
                "harness/opencode.py",
                "harness/opencode_client.py",
                "harness/opencode_stream.py",
            )
        },
    }
    # Keep credentials, user config, auth state, project hooks and MCP servers out
    # of this child process. No model request can select a non-local provider.
    server_environment = {"PATH": os.environ["PATH"]}
    for name in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"):
        directory = tmp_path / name.lower()
        directory.mkdir()
        server_environment[name] = str(directory)
    server_environment.update(
        OPENCODE_DISABLE_PROJECT_CONFIG="true",
        OPENCODE_DISABLE_MODELS_FETCH="true",
        OPENCODE_DISABLE_AUTOUPDATE="true",
        OPENCODE_DISABLE_DEFAULT_PLUGINS="true",
    )
    tool_pid_path = tmp_path / "quiet-tool.pid"
    model_server = ThreadingHTTPServer(
        ("127.0.0.1", 0), _model_handler(quiet_seconds, evidence, tool_pid_path)
    )
    model_thread = threading.Thread(target=model_server.serve_forever, daemon=True)
    model_thread.start()
    config = {
        "model": "quiet/quiet-model",
        "small_model": "quiet/quiet-model",
        "enabled_providers": ["quiet"],
        "permission": {"bash": "allow"},
        "compaction": {"auto": False},
        "provider": {
            "quiet": {
                "npm": "@ai-sdk/openai-compatible",
                "options": {
                    "baseURL": f"http://127.0.0.1:{model_server.server_port}/v1",
                    "apiKey": "local-regression-only",
                },
                "models": {"quiet-model": {"limit": {"context": 128000, "output": 8192}}},
            }
        },
    }
    server_environment["OPENCODE_CONFIG_CONTENT"] = json.dumps(config)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        opencode_port = listener.getsockname()[1]
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    bridge = None
    heartbeat_task = None
    server_process = None
    evidence_directory = Path(os.environ.get("OI_QUIET_TOOL_EVIDENCE_DIR", str(tmp_path)))
    evidence_directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    evidence_path = evidence_directory / f"quiet-tool-{quiet_seconds}-{time.time_ns()}.json"
    print(f"Quiet-tool evidence: {evidence_path}", flush=True)
    try:
        with (tmp_path / "opencode-server.log").open("w") as server_log:
            server_process = subprocess.Popen(
                [binary, "serve", "--hostname", "127.0.0.1", "--port", str(opencode_port)],
                cwd=workspace,
                env=server_environment,
                stdout=server_log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        async with httpx.AsyncClient(trust_env=False) as health_client:
            async with asyncio.timeout(60):
                while True:
                    assert server_process.poll() is None, (
                        tmp_path / "opencode-server.log"
                    ).read_text()
                    try:
                        health = await health_client.get(
                            f"http://127.0.0.1:{opencode_port}/global/health"
                        )
                        if health.status_code == 200:
                            break
                    except httpx.TransportError:
                        pass
                    await asyncio.sleep(0.1)

        async def record_events(websocket):
            async for raw in websocket:
                event = json.loads(raw)
                received_at = time.time()
                evidence["events"].append({"received_at_epoch_seconds": received_at, **event})
                if event.get("type") == "heartbeat":
                    evidence["bridge_heartbeats_epoch_seconds"].append(received_at)

        async with serve(record_events, "127.0.0.1", 0) as peer:
            peer_port = peer.sockets[0].getsockname()[1]
            # Exercise normal defaults, not the caller's accidental overrides.
            monkeypatch.delenv("BRIDGE_SSE_INACTIVITY_TIMEOUT", raising=False)
            monkeypatch.delenv("SANDBOX_TIMEOUT_SECONDS", raising=False)
            bridge = AgentBridge(
                sandbox_id=f"quiet-local-{quiet_seconds}",
                session_id=f"quiet-session-{quiet_seconds}",
                control_plane_url=f"http://127.0.0.1:{peer_port}",
                auth_token="local-regression-only",
                opencode_port=opencode_port,
            )
            bridge.repo_path = workspace
            bridge.session_id_file = tmp_path / "agent-session-id"
            bridge.legacy_session_id_file = tmp_path / "legacy-session-id"
            # Git credential/signing refresh is unrelated to this regression and
            # would contact deployment services. Everything in the turn path,
            # tool executor, SSE parser and output/heartbeat forwarding is real.
            monkeypatch.setattr(bridge, "_configure_git_identity", AsyncMock())
            bridge.harness = OpencodeHarness(
                client=_RecordingClient(
                    base_url=f"http://127.0.0.1:{opencode_port}",
                    log=bridge.log,
                    evidence=evidence,
                    http_client=httpx.AsyncClient(trust_env=False),
                ),
                attachment_processor=bridge.attachment_processor,
                log=bridge.log,
                limits=bridge.prompt_limits,
            )
            evidence["stream_responsiveness_seconds"] = (
                bridge.prompt_limits.inactivity_timeout_seconds
            )
            evidence["turn_allowance_seconds"] = bridge.prompt_limits.prompt_max_duration_seconds
            evidence["cleanup_allowance_seconds"] = (
                bridge.prompt_limits.prompt_cleanup_timeout_seconds
            )
            evidence["bridge_heartbeat_interval_seconds"] = bridge.HEARTBEAT_INTERVAL
            async with connect(f"ws://127.0.0.1:{peer_port}") as websocket:
                bridge.ws = websocket
                await bridge.event_forwarder.bind(websocket)
                heartbeat_task = asyncio.create_task(bridge._heartbeat_loop())
                evidence["started_at_epoch_seconds"] = time.time()
                async with asyncio.timeout(quiet_seconds + 180):
                    await bridge._handle_prompt(
                        {
                            "type": "prompt",
                            "messageId": "quiet-turn",
                            "content": "Run the quiet tool then respond.",
                            "model": "quiet/quiet-model",
                            "author": {"gitIdentity": {"mode": "agent-only"}},
                        }
                    )
                await asyncio.sleep(0.1)
                evidence["finished_at_epoch_seconds"] = time.time()
                evidence["opencode_session_id"] = bridge.agent_session_id
        complete = [event for event in evidence["events"] if event["type"] == "execution_complete"]
        assert len(complete) == 1 and complete[0]["success"], complete
        assert not [event for event in evidence["events"] if event["type"] == "error"]
        bash_events = [
            event
            for event in evidence["events"]
            if event["type"] == "tool_call" and event["tool"] == "bash"
        ]
        completed_tools = [event for event in bash_events if event["status"] == "completed"]
        assert len(completed_tools) == 1, bash_events
        assert not [event for event in bash_events if event["status"] == "error"], bash_events
        assert "quiet-before-tool" in completed_tools[0]["output"]
        assert "quiet-after-tool" in completed_tools[0]["output"]
        tokens = "".join(
            event.get("content", "") for event in evidence["events"] if event["type"] == "token"
        )
        assert "quiet-before-model" in tokens and "quiet-followup-success" in tokens, tokens
        tool_results = json.dumps(evidence.get("tool_results"))
        assert "quiet-before-tool" in tool_results and "quiet-after-tool" in tool_results, (
            tool_results
        )
        assert evidence["tool_requests"] == 1 and evidence["followup_requests"] == 1
        assert evidence["abort_requests"] == 0
        assert evidence["session_creations"] == 1
        assert (
            evidence["finished_at_epoch_seconds"] - evidence["started_at_epoch_seconds"]
            >= quiet_seconds
        )
        if quiet_seconds >= 600:
            timeline_times = [
                event["received_at_epoch_seconds"]
                for event in evidence["events"]
                if event["type"] in ("token", "tool_call", "step_finish")
            ]
            quiet_gap_seconds = max(right - left for left, right in pairwise(timeline_times))
            evidence["longest_timeline_quiet_gap_seconds"] = quiet_gap_seconds
            assert quiet_gap_seconds >= quiet_seconds - 5
            for key in ("opencode_heartbeats_epoch_seconds", "bridge_heartbeats_epoch_seconds"):
                timestamps = evidence[key]
                assert len(timestamps) >= quiet_seconds // 30 - 1, (key, timestamps)
                all_times = [
                    evidence["started_at_epoch_seconds"],
                    *timestamps,
                    evidence["finished_at_epoch_seconds"],
                ]
                assert max(right - left for left, right in pairwise(all_times)) < 60
        assert server_process.poll() is None
        evidence["result"] = "passed"
    finally:
        evidence_path.write_text(json.dumps(evidence, indent=2) + "\n")
        if heartbeat_task:
            heartbeat_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await heartbeat_task
        if bridge:
            if evidence.get("result") != "passed" and bridge.agent_session_id:
                # Reader cancellation does not stop the real Bash process. Ask
                # OpenCode to clean up its active tool before stopping the server.
                with contextlib.suppress(Exception):
                    async with asyncio.timeout(5):
                        await bridge.harness.client.request_stop(
                            bridge.agent_session_id, reason="regression_cleanup"
                        )
                await _clean_owned_tool(
                    tool_pid_path, evidence.get("tool_arguments", {}).get("command", "")
                )
            await bridge.harness.client._client().aclose()
            await bridge.harness.close()
        if server_process and server_process.poll() is None:
            os.killpg(server_process.pid, signal.SIGTERM)
            try:
                await asyncio.to_thread(server_process.wait, 5)
            except subprocess.TimeoutExpired:
                os.killpg(server_process.pid, signal.SIGKILL)
                await asyncio.to_thread(server_process.wait, 5)
        model_server.shutdown()
        model_server.server_close()
        model_thread.join(timeout=5)

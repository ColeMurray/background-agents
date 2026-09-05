"""Opt-in wire tests: OPENCODE_TEST_BINARY=/path/to/opencode pytest ... -v.

Uses real OpenCode 1.18.18, an isolated catalog/config, and fake localhost providers.
Only reasoning settings are retained from requests; no real provider keys are used.

Fixture: public subset of https://models.opencode.ai/api.json, retrieved 2026-09-04.
Source SHA-256: ef112420273b7e572ef9c87db13a2f30fe1a562c29ea30d365b911889f9ff46c
Subset SHA-256: 18e7e0ca29f785f273d50776d9d96f6dd2be6e754d62d14d73b23325d7eac6da
Reconcile this frozen fixture with shared model/effort definitions when changing
models or the binary. Mocks verify serialization, not live provider acceptance.
"""

import json
import os
import socket
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from tests.test_prompt_stream import make_stream

pytest_plugins = ["tests.test_reasoning_config"]

BINARY = os.environ.get("OPENCODE_TEST_BINARY")
pytestmark = pytest.mark.skipif(not BINARY, reason="set OPENCODE_TEST_BINARY for wire tests")
CATALOG = Path(__file__).parent / "fixtures/reasoning-models.json"


def openai_events(model):
    item = {
        "id": "msg_test",
        "type": "message",
        "role": "assistant",
        "status": "completed",
        "content": [{"type": "output_text", "text": "OK", "annotations": []}],
    }
    response = {
        "id": "resp_test",
        "object": "response",
        "status": "completed",
        "model": model,
        "output": [item],
        "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
    }
    return [
        {
            "type": "response.created",
            "response": {**response, "status": "in_progress", "output": []},
        },
        {
            "type": "response.output_item.added",
            "output_index": 0,
            "item": {**item, "status": "in_progress", "content": []},
        },
        {
            "type": "response.output_text.delta",
            "item_id": item["id"],
            "output_index": 0,
            "content_index": 0,
            "delta": "OK",
        },
        {"type": "response.output_item.done", "output_index": 0, "item": item},
        {"type": "response.completed", "response": response},
    ]


def anthropic_events(model):
    return [
        {
            "type": "message_start",
            "message": {
                "id": "msg_test",
                "type": "message",
                "role": "assistant",
                "content": [],
                "model": model,
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": 1, "output_tokens": 0},
            },
        },
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "OK"}},
        {"type": "content_block_stop", "index": 0},
        {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn", "stop_sequence": None},
            "usage": {"output_tokens": 1},
        },
        {"type": "message_stop"},
    ]


@pytest.fixture
async def wire_server(tmp_path, reasoning_config):
    assert subprocess.check_output([BINARY, "--version"], text=True).strip() == "1.18.18"
    captured = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            captured.append(
                {key: body.get(key) for key in ("model", "reasoning", "thinking", "output_config")}
            )
            events = (
                anthropic_events(body["model"])
                if self.path.endswith("/messages")
                else openai_events(body["model"])
            )
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write(
                "".join(
                    "event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n"
                    for event in events
                ).encode()
            )

    mock = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=mock.serve_forever, daemon=True)
    thread.start()
    process = None
    try:
        config = reasoning_config
        config["agent"] = {"build": {"options": {"reasoningEffort": "high"}}}
        for provider in ("openai", "anthropic"):
            config["provider"].setdefault(provider, {})["options"] = {
                "baseURL": f"http://127.0.0.1:{mock.server_port}/v1",
                "apiKey": "test-only",
            }
        env = {key: os.environ[key] for key in ("PATH", "HOME", "SYSTEMROOT") if key in os.environ}
        env.update(
            {
                "XDG_CONFIG_HOME": str(tmp_path / "config"),
                "XDG_DATA_HOME": str(tmp_path / "data"),
                "XDG_CACHE_HOME": str(tmp_path / "cache"),
                "XDG_STATE_HOME": str(tmp_path / "state"),
                "OPENCODE_CONFIG_DIR": str(tmp_path / "config/opencode"),
                "OPENCODE_MODELS_PATH": str(CATALOG),
                "OPENCODE_DISABLE_MODELS_FETCH": "1",
                "OPENCODE_CONFIG_CONTENT": json.dumps(config),
                "OPENCODE_CLIENT": "serve",
                "OPENAI_API_KEY": "test-only",
                "ANTHROPIC_API_KEY": "test-only",
            }
        )
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        process = subprocess.Popen(
            [BINARY, "serve", "--hostname", "127.0.0.1", "--port", str(port)],
            cwd=tmp_path,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        def call(path, body=None):
            request = urllib.request.Request(
                f"http://127.0.0.1:{port}" + path,
                data=json.dumps(body).encode() if body is not None else None,
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)

        deadline = time.monotonic() + 30
        while True:
            try:
                call("/global/health")
                break
            except OSError:
                if process.poll() is not None or time.monotonic() >= deadline:
                    pytest.fail("isolated OpenCode server did not become healthy")
                time.sleep(0.1)
        yield call, captured
    finally:
        if process is not None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
        mock.shutdown()
        mock.server_close()
        thread.join(timeout=5)


def submit(call, captured, model, effort, session=None):
    if session is None:
        session = call("/session", {"title": "Reasoning contract"})["id"]
    stream = make_stream()
    stream._attachment_processor.build_file_parts.return_value = []
    body = stream._build_prompt_request_body(
        "Reply only OK. Do not use tools.", model, reasoning_effort=effort
    )
    captured.clear()
    result = call(f"/session/{session}/message", body)
    assert not result["info"].get("error"), result["info"].get("error", {}).get("name")
    provider, model_id = model.split("/", 1)
    sent = [item for item in captured if item["model"] == model_id]
    assert sent, f"no outbound request for {provider}/{model_id}"
    return sent[-1], session


async def test_all_fixture_efforts_reach_provider(wire_server):
    call, captured = wire_server
    catalog = json.loads(CATALOG.read_text())
    for provider, group in catalog.items():
        for model_id, model in group["models"].items():
            manual = model_id in {"claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-5"}
            efforts = (
                ["high", "max"]
                if manual
                else next(
                    option["values"]
                    for option in model["reasoning_options"]
                    if option["type"] == "effort"
                )
            )
            for effort in efforts:
                sent, _ = submit(call, captured, f"{provider}/{model_id}", effort)
                context = f"{provider}/{model_id} {effort}"
                if provider == "openai":
                    assert sent["reasoning"]["effort"] == effort, context
                elif manual:
                    assert sent["thinking"] == {
                        "type": "enabled",
                        "budget_tokens": 16000 if effort == "high" else 31999,
                    }, context
                    expected = (
                        {"effort": "high"}
                        if model_id == "claude-opus-4-5" and effort == "high"
                        else None
                    )
                    assert sent["output_config"] == expected, context
                else:
                    assert sent["thinking"]["type"] == "adaptive", context
                    assert sent["output_config"]["effort"] == effort, context


async def test_defaults_and_switching(wire_server):
    call, captured = wire_server
    # The configured agent's High default must survive omission and yield to a variant.
    sent, session = submit(call, captured, "openai/gpt-5.6-sol", None)
    assert sent["reasoning"]["effort"] == "high"
    sent, session = submit(call, captured, "openai/gpt-5.6-sol", "low", session)
    assert sent["reasoning"]["effort"] == "low"
    sent, session = submit(call, captured, "anthropic/claude-opus-4-5", "max", session)
    assert sent["thinking"] == {"type": "enabled", "budget_tokens": 31999}
    sent, _ = submit(call, captured, "anthropic/claude-haiku-4-5", None)
    assert sent["thinking"] is None


async def test_unsupported_request_options_do_not_override_defaults(wire_server):
    call, captured = wire_server
    base = {
        "model": {"providerID": "openai", "modelID": "gpt-5.6-sol"},
        "parts": [{"type": "text", "text": "Reply only OK. Do not use tools."}],
    }
    for effort in ("low", "max"):
        cases = [
            {**base, "model": {**base["model"], "options": {"reasoningEffort": effort}}},
            {**base, "reasoningEffort": effort},
            {**base, "options": {"reasoningEffort": effort}},
            {**base, "providerOptions": {"openai": {"reasoningEffort": effort}}},
        ]
        for body in cases:
            session = call("/session", {"title": "Reasoning contract"})["id"]
            captured.clear()
            result = call(f"/session/{session}/message", body)
            assert not result["info"].get("error")
            assert captured[-1]["reasoning"]["effort"] == "high"
    for model in ("claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-5"):
        session = call("/session", {"title": "Reasoning contract"})["id"]
        captured.clear()
        result = call(
            f"/session/{session}/message",
            {
                "model": {
                    "providerID": "anthropic",
                    "modelID": model,
                    "options": {"thinking": {"type": "enabled", "budgetTokens": 31999}},
                },
                "parts": base["parts"],
            },
        )
        assert not result["info"].get("error")
        assert captured[-1]["thinking"] is None

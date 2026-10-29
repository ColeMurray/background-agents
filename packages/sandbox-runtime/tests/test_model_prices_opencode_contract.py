"""Opt-in comparison: OPENCODE_TEST_BINARY=/path/to/opencode pytest ... -v.

Runs real OpenCode 1.18.29 against a loopback Responses fixture with the frozen
catalog fixture. Token buckets and arithmetic agree, but Codex honors the
catalog's 272k tier instead of OpenCode's legacy over-200k fallback.
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
from unittest.mock import MagicMock

import pytest

from sandbox_runtime.model_prices import ModelPriceCatalog, TokenBuckets

BINARY = os.environ.get("OPENCODE_TEST_BINARY")
pytestmark = pytest.mark.skipif(not BINARY, reason="set OPENCODE_TEST_BINARY for wire tests")
CATALOG = Path(__file__).parent / "fixtures/reasoning-models.json"
MODEL = "gpt-6.1-sol"
# ((input, cached, cache write, output, reasoning), published cost, OpenCode cost).
CASES = [
    ((48_000, 40_000, 6_000, 1_200, 800), 0.035, 0.035),
    ((52_000, 46_000, 0, 2_500, 1_500), 0.0416, 0.0416),
    ((200_000, 0, 0, 10, 0), 0.4001, 0.4001),
    ((200_001, 0, 0, 10, 0), 0.400102, 0.800154),
    ((230_000, 50_000, 0, 800, 300), 0.373, 0.742),
    ((272_000, 1_000, 500, 40, 20), 0.54275, 1.0853),
    ((272_001, 0, 0, 0, 0), 1.088004, 1.088004),
]


def response_usage(input_tokens, cached, write, output, reasoning):
    return {
        "input_tokens": input_tokens,
        "input_tokens_details": {"cached_tokens": cached, "cache_write_tokens": write},
        "output_tokens": output,
        "output_tokens_details": {"reasoning_tokens": reasoning},
        "total_tokens": input_tokens + output,
    }


@pytest.fixture
def opencode(tmp_path):
    pending = [response_usage(*usage) for usage, _, _ in CASES]

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            # Title generation and other side requests are not priced here.
            usage = pending.pop(0) if body.get("model") == MODEL and pending else None
            item = {
                "id": "msg",
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": "OK", "annotations": []}],
            }
            response = {
                "id": "resp",
                "object": "response",
                "status": "completed",
                "model": body.get("model"),
                "output": [item],
                "usage": usage or response_usage(0, 0, 0, 0, 0),
            }
            events = [
                {"type": "response.created", "response": {**response, "output": []}},
                {
                    "type": "response.output_item.added",
                    "output_index": 0,
                    "item": {**item, "status": "in_progress", "content": []},
                },
                {
                    "type": "response.output_text.delta",
                    "item_id": "msg",
                    "output_index": 0,
                    "content_index": 0,
                    "delta": "OK",
                },
                {"type": "response.output_item.done", "output_index": 0, "item": item},
                {"type": "response.completed", "response": response},
            ]
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write(
                "".join(
                    f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events
                ).encode()
            )

    mock = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=mock.serve_forever, daemon=True)
    thread.start()
    config = {
        "provider": {
            "openai": {
                "options": {
                    "baseURL": f"http://127.0.0.1:{mock.server_port}/v1",
                    "apiKey": "test-only",
                }
            }
        },
        "small_model": f"openai/{MODEL}",
    }
    env = {key: os.environ[key] for key in ("PATH", "HOME") if key in os.environ}
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
            "OPENAI_API_KEY": "test-only",
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

    def call(path, body=None, timeout_seconds=60):
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}{path}",
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            return json.load(response)

    try:
        deadline = time.monotonic() + 30
        while True:
            try:
                call("/global/health", timeout_seconds=1)
                break
            except OSError:
                if process.poll() is not None or time.monotonic() >= deadline:
                    pytest.fail("isolated OpenCode server did not become healthy")
                time.sleep(0.1)
        yield call
    finally:
        process.terminate()
        process.wait(timeout=10)
        mock.shutdown()
        mock.server_close()
        thread.join(timeout=5)


def test_codex_pricing_uses_published_tiers_instead_of_opencode_legacy_fallback(opencode):
    assert subprocess.check_output([BINARY, "--version"], text=True).strip() == "1.18.29"
    session = opencode("/session", {"title": "Pricing contract"})["id"]
    for _ in CASES:
        result = opencode(
            f"/session/{session}/message",
            {
                "model": {"providerID": "openai", "modelID": MODEL},
                "parts": [{"type": "text", "text": "Reply OK"}],
            },
        )
        assert not result["info"].get("error"), result["info"]["error"]
    steps = [
        part
        for message in opencode(f"/session/{session}/message")
        for part in message.get("parts", [])
        if part.get("type") == "step-finish"
    ]
    price = ModelPriceCatalog(CATALOG, MagicMock()).price(MODEL)
    assert len(steps) == len(CASES)
    for step, (usage, published_cost, opencode_cost) in zip(steps, CASES, strict=True):
        tokens = step["tokens"]
        buckets = TokenBuckets(
            input=tokens["input"],
            output=tokens["output"],
            reasoning=tokens["reasoning"],
            cache_read=tokens["cache"]["read"],
            cache_write=tokens["cache"]["write"],
        )
        assert float(price.cost(buckets, usage[0])) == published_cost, step
        assert step["cost"] == opencode_cost, step

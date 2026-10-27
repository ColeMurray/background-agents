"""Released-binary Codex fixtures. Synthetic auth; loopback Responses only."""

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from sandbox_runtime.harness.codex.client import CodexClient


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

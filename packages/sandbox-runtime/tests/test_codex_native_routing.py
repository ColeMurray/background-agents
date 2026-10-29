"""Released-binary routing proof with production provider defaults and synthetic auth.

The TLS CONNECT interceptor never opens an upstream socket. A generated test CA
allows the unmodified first-party endpoints to terminate on loopback, so a custom
model provider cannot conceal an incorrect production endpoint override.
"""

import base64
import datetime
import json
import os
import ssl
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import AsyncMock, MagicMock

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from sandbox_runtime.credentials.openai_access_token_client import OpenAIAccessToken
from sandbox_runtime.harness.base import HarnessPrompt, PromptLimits
from sandbox_runtime.harness.codex import CodexHarness, CodexHarnessConfig
from sandbox_runtime.harness.codex.client import CodexClient

BINARY = os.environ.get("OI_TEST_CODEX_BINARY")
pytestmark = pytest.mark.skipif(not BINARY, reason="Set OI_TEST_CODEX_BINARY for native routing")


@pytest.fixture
def first_party_interceptor(tmp_path):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "OpenInspect routing fixture")])
    now = datetime.datetime.now(datetime.UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=1))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(
            x509.SubjectAlternativeName(
                [x509.DNSName("api.openai.com"), x509.DNSName("chatgpt.com")]
            ),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    leaf_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    leaf = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "api.openai.com")]))
        .issuer_name(name)
        .public_key(leaf_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=1))
        .not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.SubjectAlternativeName(
                [x509.DNSName("api.openai.com"), x509.DNSName("chatgpt.com")]
            ),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    ca_file, key_file = tmp_path / "fixture-ca.pem", tmp_path / "fixture-key.pem"
    chain_file = tmp_path / "fixture-chain.pem"
    ca_file.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    chain_file.write_bytes(leaf.public_bytes(serialization.Encoding.PEM) + ca_file.read_bytes())
    key_file.write_bytes(
        leaf_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    key_file.chmod(0o600)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(chain_file, key_file)
    observed, connections = [], []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def reply(self, body, *, status=200, content_type="application/json"):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()
            self.close_connection = True

        def do_CONNECT(self):
            # Deliberately no upstream forwarding, including unexpected hosts.
            connections.append(self.path)
            if self.path not in {"api.openai.com:443", "chatgpt.com:443"}:
                self.reply(b"{}", status=403)
                return
            self.tunnel_host = self.path.split(":", 1)[0]
            self.send_response(200, "Connection Established")
            self.end_headers()
            self.wfile.flush()
            self.connection = context.wrap_socket(self.connection, server_side=True)
            self.connection.settimeout(10)
            self.rfile = self.connection.makefile("rb")
            self.wfile = self.connection.makefile("wb", buffering=0)
            self.close_connection = False

        def do_GET(self):
            observed.append((self.tunnel_host, "GET", self.path, self.headers.get("Authorization")))
            if self.headers.get("Upgrade", "").lower() == "websocket":
                # Pinned Codex explicitly falls back to HTTP on 426. This keeps
                # built-in provider capabilities and endpoint defaults intact.
                self.reply(b"{}", status=426)
            elif "accounts/check" in self.path:
                self.reply(
                    json.dumps(
                        {
                            "accounts": [
                                {
                                    "id": "workspace-fixture",
                                    "workspace_backend_origin": "https://chatgpt.com",
                                    "account_routing_override": "NO_CONSTRAINT",
                                }
                            ]
                        }
                    ).encode()
                )
            elif "/models" in self.path:
                self.reply(b'{"models":[]}')
            else:
                self.reply(b"{}", status=404)

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            observed.append(
                (self.tunnel_host, "POST", self.path, self.headers.get("Authorization"))
            )
            if not self.path.endswith("/responses"):
                self.reply(b"{}", status=404)
                return
            events = [
                {"type": "response.created", "response": {"id": "r-fixture"}},
                {
                    "type": "response.output_item.done",
                    "item": {
                        "type": "message",
                        "role": "assistant",
                        "id": "m-fixture",
                        "content": [{"type": "output_text", "text": "routing verified"}],
                    },
                },
                {
                    "type": "response.completed",
                    "response": {
                        "id": "r-fixture",
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
            body = "".join(
                f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events
            ).encode()
            self.reply(body, content_type="text/event-stream")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", ca_file, observed, connections
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.mark.parametrize("subscription", [False, True])
async def test_native_builtin_provider_routes_each_auth_mode(
    tmp_path, first_party_interceptor, subscription
):
    proxy, ca_file, observed, connections = first_party_interceptor
    token = "sk-synthetic-routing-fixture"
    if subscription:

        def encode(value):
            return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

        token = ".".join(
            [
                encode({"alg": "none"}),
                encode(
                    {
                        "email": "fixture@example.com",
                        "https://api.openai.com/auth": {
                            "chatgpt_account_id": "workspace-fixture",
                            "chatgpt_user_id": "user-fixture",
                            "chatgpt_plan_type": "pro",
                        },
                    }
                ),
                "sig",
            ]
        )

    def factory(**kwargs):
        # Only select the released binary and platform-appropriate containment.
        # Do not mutate launch config, provider, endpoints or auth routing.
        command = kwargs["command"]
        native = (BINARY, *command[3:])
        linux = sys.platform.startswith("linux")
        kwargs["command"] = (*command[:2], *native) if linux else native
        kwargs["containment_owner"] = linux
        return CodexClient(**kwargs)

    broker = MagicMock()
    broker.fetch = AsyncMock(
        return_value=OpenAIAccessToken(token, "workspace-fixture", 1, 9999999999999)
    )
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    harness = CodexHarness(
        config=CodexHarnessConfig(workspace, tmp_path / "state", "gpt-6.1-sol", subscription),
        log=MagicMock(),
        limits=PromptLimits(1, 20, 5),
        credential_client=broker if subscription else None,
        client_factory=factory,
        environ={
            "PATH": os.environ["PATH"],
            "HOME": str(tmp_path),
            "OPENAI_API_KEY": token,
            "HTTPS_PROXY": proxy,
            "HTTP_PROXY": proxy,
            "ALL_PROXY": proxy,
            "NO_PROXY": "",
            "SSL_CERT_FILE": str(ca_file),
        },
    )
    try:
        outcome = await harness.run_prompt(HarnessPrompt("routing", "Reply once."), AsyncMock())
        assert outcome.success, (
            outcome,
            [(host, method, path) for host, method, path, _ in observed],
        )
    finally:
        await harness.close()
    model_requests = [
        request
        for request in observed
        if request[1] == "POST" and request[2].endswith("/responses")
    ]
    expected_host = "chatgpt.com" if subscription else "api.openai.com"
    expected_path = "/backend-api/codex/responses" if subscription else "/v1/responses"
    assert len(model_requests) == 1
    assert model_requests[0] == (expected_host, "POST", expected_path, f"Bearer {token}")
    assert set(connections) <= {"api.openai.com:443", "chatgpt.com:443"}
    if subscription:
        assert any("accounts/check" in request[2] for request in observed)
    else:
        # API keys stay on the OpenAI API, never the ChatGPT backend.
        assert set(connections) == {"api.openai.com:443"}
        broker.fetch.assert_not_called()

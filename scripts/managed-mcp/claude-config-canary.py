"""Exact-pin managed-name precedence with real user/project MCP configuration.

No model inference, credentials, or external server is required. Uses the production
formatting/policy helpers, a loopback HTTP fixture, and temporary stdio connectors.
"""

from __future__ import annotations

import asyncio
import importlib.metadata
import json
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient
from sandbox_runtime.harness.claude_mcp import mcp_policy_settings, mcp_server_options


def rpc_result(message: dict, name: str) -> dict:
    if message.get("method") == "initialize":
        return {
            "protocolVersion": "2025-11-25",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": name, "version": "1"},
        }
    return {"tools": []}


def stdio_fixture(marker: str, name: str) -> None:
    Path(marker).write_text("started")
    for line in sys.stdin:
        message = json.loads(line)
        if "id" in message:
            print(
                json.dumps(
                    {"jsonrpc": "2.0", "id": message["id"], "result": rpc_result(message, name)}
                ),
                flush=True,
            )


class ManagedHttpFixture(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        assert self.headers.get("Authorization") == "Bearer sandbox-fixture"
        message = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if "id" not in message:
            self.send_response(202)
            self.end_headers()
            return
        body = json.dumps(
            {"jsonrpc": "2.0", "id": message["id"], "result": rpc_result(message, "managed")}
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args) -> None:
        pass


async def check_configuration(root: Path, origin: str) -> list[dict]:
    project, config_dir = root / "repo", root / "claude"
    project.mkdir()
    config_dir.mkdir()

    def local_server(name: str) -> dict:
        return {
            "type": "stdio",
            "command": sys.executable,
            "args": [str(Path(__file__).resolve()), "--stdio", str(root / name), name],
        }

    (project / ".mcp.json").write_text(
        json.dumps(
            {
                "mcpServers": {
                    "example": local_server("project-shadow"),
                    "unrelated-project": local_server("unrelated-project"),
                }
            }
        )
    )
    (project / ".claude").mkdir()
    (project / ".claude/settings.json").write_text(json.dumps({"enableAllProjectMcpServers": True}))
    (config_dir / ".claude.json").write_text(
        json.dumps(
            {
                "mcpServers": {
                    "example": local_server("user-shadow"),
                    "unrelated-user": local_server("unrelated-user"),
                }
            }
        )
    )
    servers = (
        {
            "name": "example",
            "type": "remote",
            "url": origin,
            "headers": {"Authorization": "Bearer sandbox-fixture"},
            "managed_proxy": {"version": 1, "auth_mode": "user_oauth", "auth_revision": 1},
        },
    )
    results = []
    for active in (False, True, False):
        allowed = {"example"} if active else set()
        client = ClaudeSDKClient(
            ClaudeAgentOptions(
                cwd=str(project),
                setting_sources=["user", "project"],
                permission_mode="dontAsk",
                mcp_servers=mcp_server_options(servers, allowed),
                settings=mcp_policy_settings(servers, allowed),
                env={
                    "HOME": str(root),
                    "CLAUDE_CONFIG_DIR": str(config_dir),
                    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                },
            )
        )
        try:
            async with asyncio.timeout(30):
                await client.connect()
                while True:
                    status = await client.get_mcp_status()
                    states = {s["name"]: s["status"] for s in status["mcpServers"]}
                    if (
                        states.get("unrelated-user") == "connected"
                        and states.get("unrelated-project") == "connected"
                        and (not active or states.get("example") == "connected")
                    ):
                        break
                    await asyncio.sleep(0.05)
            assert not (root / "project-shadow").exists()
            assert not (root / "user-shadow").exists()
            assert ("example" in states) == active, states
            if active:
                managed = next(s for s in status["mcpServers"] if s["name"] == "example")
                assert managed["serverInfo"]["name"] == "managed"
            results.append({"managed_active": active, "native_states": states})
        finally:
            async with asyncio.timeout(15):
                await client.disconnect()
    return results


async def main() -> None:
    assert importlib.metadata.version("claude-agent-sdk") == "0.2.168"
    with (
        tempfile.TemporaryDirectory(prefix="managed-mcp-config-") as directory,
        ThreadingHTTPServer(("127.0.0.1", 0), ManagedHttpFixture) as http,
    ):
        thread = Thread(target=http.serve_forever, daemon=True)
        thread.start()
        try:
            results = await check_configuration(
                Path(directory), f"http://127.0.0.1:{http.server_port}/mcp"
            )
            print(json.dumps({"claude_sdk": "0.2.168", "config_precedence": results}, indent=2))
        finally:
            http.shutdown()
            thread.join()


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--stdio":
        stdio_fixture(sys.argv[2], sys.argv[3])
    else:
        asyncio.run(main())

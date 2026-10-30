"""Exact-pin managed-name precedence and outage recovery with real user/project MCP configuration.

No model inference, credentials, or external server is required. Uses the production
formatting/policy/readiness helpers, a loopback HTTP fixture, and temporary stdio connectors.
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
from sandbox_runtime.harness.base import HarnessPrompt
from sandbox_runtime.harness.claude_mcp import (
    check_managed_mcp,
    mcp_policy_settings,
    mcp_server_options,
)


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
    available = True
    initializations = 0

    def do_POST(self) -> None:
        assert self.headers.get("Authorization") == "Bearer sandbox-fixture"
        message = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if message.get("method") == "initialize":
            ManagedHttpFixture.initializations += 1
        if not ManagedHttpFixture.available:
            self.send_response(503)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
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


def local_server(root: Path, name: str) -> dict:
    return {
        "type": "stdio",
        "command": sys.executable,
        "args": [str(Path(__file__).resolve()), "--stdio", str(root / name), name],
    }


def managed_servers(origin: str) -> tuple[dict, ...]:
    return (
        {
            "name": "example",
            "type": "remote",
            "url": origin,
            "headers": {"Authorization": "Bearer sandbox-fixture"},
            "managed_proxy": {"version": 1, "auth_mode": "user_oauth", "auth_revision": 1},
        },
    )


def claude_client(root: Path, servers: tuple[dict, ...], allowed: set[str]) -> ClaudeSDKClient:
    """A fresh process per turn, sharing the config directory as the sandbox does."""
    return ClaudeSDKClient(
        ClaudeAgentOptions(
            cwd=str(root / "repo"),
            setting_sources=["user", "project"],
            permission_mode="dontAsk",
            mcp_servers=mcp_server_options(servers, allowed),
            settings=mcp_policy_settings(servers, allowed),
            env={
                "HOME": str(root),
                "CLAUDE_CONFIG_DIR": str(root / "claude"),
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            },
        )
    )


async def check_configuration(root: Path, origin: str) -> list[dict]:
    project, config_dir = root / "repo", root / "claude"
    project.mkdir(parents=True)
    config_dir.mkdir()
    (project / ".mcp.json").write_text(
        json.dumps(
            {
                "mcpServers": {
                    "example": local_server(root, "project-shadow"),
                    "unrelated-project": local_server(root, "unrelated-project"),
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
                    "example": local_server(root, "user-shadow"),
                    "unrelated-user": local_server(root, "unrelated-user"),
                }
            }
        )
    )
    servers = managed_servers(origin)
    results = []
    for active in (False, True, False):
        allowed = {"example"} if active else set()
        client = claude_client(root, servers, allowed)
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


async def check_outage_recovery(root: Path, origin: str) -> list[dict]:
    """A disable left by a failed turn must not outlive the upstream outage."""
    (root / "repo").mkdir(parents=True)
    (root / "claude").mkdir()
    (root / "claude/.claude.json").write_text(
        json.dumps({"mcpServers": {"unrelated-user": local_server(root, "unrelated-user")}})
    )
    servers = managed_servers(origin)
    warnings: list[dict] = []

    async def emit(event: dict) -> None:
        warnings.append(event)

    results = []
    for available in (False, True):
        ManagedHttpFixture.available = available
        initializations = ManagedHttpFixture.initializations
        warnings.clear()
        client = claude_client(root, servers, {"example"})
        try:
            async with asyncio.timeout(60):
                await client.connect()
                if not available:
                    # A native disable, as `/mcp disable` makes; no turn may undo it.
                    await client.toggle_mcp_server("unrelated-user", False)
                await check_managed_mcp(client, {"example"}, HarnessPrompt("canary", ""), emit)
                status = await client.get_mcp_status()
        finally:
            async with asyncio.timeout(15):
                await client.disconnect()
        states = {s["name"]: s["status"] for s in status["mcpServers"]}
        managed = "connected" if available else "disabled"
        assert states == {"example": managed, "unrelated-user": "disabled"}, states
        assert len(warnings) == (0 if available else 1), warnings
        # The recovered process dials the upstream instead of inheriting the disable.
        assert ManagedHttpFixture.initializations > initializations
        results.append({"upstream_available": available, "native_states": states})
    ManagedHttpFixture.available = True
    return results


async def main() -> None:
    assert importlib.metadata.version("claude-agent-sdk") == "0.2.168"
    with (
        tempfile.TemporaryDirectory(prefix="managed-mcp-config-") as directory,
        ThreadingHTTPServer(("127.0.0.1", 0), ManagedHttpFixture) as http,
    ):
        thread = Thread(target=http.serve_forever, daemon=True)
        thread.start()
        origin = f"http://127.0.0.1:{http.server_port}/mcp"
        try:
            precedence = await check_configuration(Path(directory) / "precedence", origin)
            recovery = await check_outage_recovery(Path(directory) / "recovery", origin)
            print(
                json.dumps(
                    {
                        "claude_sdk": "0.2.168",
                        "config_precedence": precedence,
                        "outage_recovery": recovery,
                    },
                    indent=2,
                )
            )
        finally:
            http.shutdown()
            thread.join()


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--stdio":
        stdio_fixture(sys.argv[2], sys.argv[3])
    else:
        asyncio.run(main())

"""Exact-pin native MCP transport canary; no model API key or inference required.

Run the loopback example server first. Uses isolated HOME/config/data directories.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.metadata
import json
import os
import subprocess
import tempfile
from pathlib import Path

import httpx
from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient


async def main(binary: str, origin: str) -> None:
    assert importlib.metadata.version("claude-agent-sdk") == "0.2.168"
    assert subprocess.check_output([binary, "--version"], text=True).strip() == "1.18.29"
    proxy = f"{origin}/sessions/local/mcp/example"
    headers = {"Authorization": "Bearer sandbox-fixture"}
    async with httpx.AsyncClient(timeout=30) as http:
        # Exercise the remote RBAC contract independently of inference decisions.
        for owner in ("reader", "operator"):
            await http.post(f"{origin}/test/context", json={"owner": owner})
            response = await http.post(
                proxy,
                headers=headers,
                json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            )
            response.raise_for_status()
            session_headers = {**headers, "Mcp-Session-Id": response.headers["Mcp-Session-Id"]}
            result = await http.post(
                proxy,
                headers=session_headers,
                json={
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "tools/call",
                    "params": {"name": "write", "arguments": {}},
                },
            )
            assert result.json()["result"]["isError"] == (owner == "reader")
        await http.post(
            f"{origin}/test/context", json={"owner": "operator", "loseMutationResponse": True}
        )
        before = (await http.get(f"{origin}/test/trace")).json()["mutations"]
        lost = await http.post(
            proxy,
            headers=session_headers,
            json={"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "write"}},
        )
        assert lost.status_code >= 400
        assert (await http.get(f"{origin}/test/trace")).json()["mutations"] == before + 1
        await http.post(f"{origin}/test/context", json={"owner": "reader"})
        with tempfile.TemporaryDirectory(prefix="managed-mcp-native-") as directory:
            root = Path(directory)
            config = {
                "$schema": "https://opencode.ai/config.json",
                "mcp": {
                    "example": {
                        "type": "remote",
                        "url": proxy,
                        "headers": headers,
                        "oauth": False,
                        "enabled": False,
                    }
                },
            }
            isolated = {
                **os.environ,
                "HOME": directory,
                "XDG_CONFIG_HOME": str(root / "config"),
                "XDG_DATA_HOME": str(root / "data"),
                "XDG_CACHE_HOME": str(root / "cache"),
                "XDG_STATE_HOME": str(root / "state"),
                "OPENCODE_CONFIG_CONTENT": json.dumps(config),
                "OPENCODE_DISABLE_AUTOUPDATE": "true",
                "OPENCODE_DISABLE_DEFAULT_PLUGINS": "true",
            }
            with (root / "opencode.log").open("w") as log:
                process = subprocess.Popen(
                    [binary, "serve", "--hostname", "127.0.0.1", "--port", "17882"],
                    cwd=directory,
                    env=isolated,
                    stdout=log,
                    stderr=log,
                )
                try:
                    for _ in range(100):
                        try:
                            status = await http.get("http://127.0.0.1:17882/mcp")
                            if status.is_success:
                                break
                        except httpx.ConnectError:
                            pass
                        await asyncio.sleep(0.1)
                    else:
                        raise RuntimeError(
                            "OpenCode did not start: " + (root / "opencode.log").read_text()[-2000:]
                        )
                    assert status.json()["example"]["status"] == "disabled", status.text
                    for owner in ("reader", "operator"):
                        await http.post(f"{origin}/test/context", json={"owner": owner})
                        connected = await http.post("http://127.0.0.1:17882/mcp/example/connect")
                        connected.raise_for_status()
                        status = await http.get("http://127.0.0.1:17882/mcp")
                        assert status.json()["example"]["status"] == "connected", status.text
                        await http.post(f"{origin}/test/context", json={"active": False})
                        disconnected = await http.post(
                            "http://127.0.0.1:17882/mcp/example/disconnect"
                        )
                        disconnected.raise_for_status()
                        status = await http.get("http://127.0.0.1:17882/mcp")
                        assert status.json()["example"]["status"] != "connected", status.text
                finally:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
            # A fresh owned Claude process per personal turn, on the same async task.
            for owner in ("reader", "operator"):
                await http.post(f"{origin}/test/context", json={"owner": owner})
                options = ClaudeAgentOptions(
                    cwd=directory,
                    setting_sources=[],
                    strict_mcp_config=True,
                    env={
                        "HOME": directory,
                        "CLAUDE_CONFIG_DIR": str(root / "claude"),
                        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                    },
                    mcp_servers={"example": {"type": "http", "url": proxy, "headers": headers}},
                )
                client = ClaudeSDKClient(options)
                await client.connect()
                try:
                    for _ in range(100):
                        status = await client.get_mcp_status()
                        servers = status.get("mcpServers", [])
                        if any(
                            s.get("name") == "example" and s.get("status") == "connected"
                            for s in servers
                        ):
                            break
                        await asyncio.sleep(0.1)
                    else:
                        raise AssertionError(f"Claude MCP not connected: {status}")
                    await http.post(f"{origin}/test/context", json={"active": False})
                finally:
                    await client.disconnect()
            # No native OAuth credentials should be created by managed clients.
            assert not list(root.rglob("mcp-auth.json"))
        trace = (await http.get(f"{origin}/test/trace")).json()
        assert {r["user"] for r in trace["requests"]} == {"reader", "operator"}
        # Both exact native clients must perform fresh discovery for each owner.
        for owner in ("reader", "operator"):
            catalogs = {
                r["session"]
                for r in trace["requests"]
                if r["user"] == owner and r.get("rpc") == "tools/list"
            }
            assert len(catalogs) >= 2, (owner, catalogs)
        print(
            json.dumps(
                {
                    "opencode": "1.18.29",
                    "claude_sdk": "0.2.168",
                    "native_generations": "reader then operator for both harnesses",
                    "rbac": "reader denied; operator allowed",
                    "lost_response_mutations": 1,
                    "trace": trace,
                },
                indent=2,
            )
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--opencode", required=True)
    parser.add_argument("--origin", default="http://127.0.0.1:17881")
    args = parser.parse_args()
    asyncio.run(main(args.opencode, args.origin))

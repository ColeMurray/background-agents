"""Prove uncertain native connect cannot authorize another managed turn.

The exact OpenCode pin may finish connecting after disconnect returned disabled.
This canary exercises the production wrapper's fail-closed response to that race.
No model inference or external server is required.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Event, Thread
from types import SimpleNamespace

import httpx
from sandbox_runtime.harness.base import HarnessPrompt, PromptLimits
from sandbox_runtime.harness.opencode import OpencodeHarness
from sandbox_runtime.harness.opencode_client import OpenCodeClient
from sandbox_runtime.managed_mcp import ManagedMcpHarness


class DelayedMcpFixture(BaseHTTPRequestHandler):
    started = Event()
    release = Event()

    def do_POST(self) -> None:
        message = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path.endswith("/mcp-context/close"):
            result = {"ok": True}
        elif "id" not in message:
            self.send_response(202)
            self.end_headers()
            return
        else:
            if message["method"] == "initialize":
                self.started.set()
                self.release.wait(10)
                payload = {
                    "protocolVersion": "2025-11-25",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "delayed", "version": "1"},
                }
            else:
                payload = {"tools": []}
            result = {"jsonrpc": "2.0", "id": message["id"], "result": payload}
        body = json.dumps(result).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args) -> None:
        pass


async def check(binary: str, directory: str, origin: str, port: int) -> dict:
    server = {
        "name": "example",
        "type": "remote",
        "url": f"{origin}/mcp",
        "headers": {"Authorization": "Bearer sandbox-fixture"},
        "managed_proxy": {"version": 1, "auth_mode": "user_oauth", "auth_revision": 1},
    }
    config = {
        "mcp": {
            "example": {
                "type": "remote",
                "url": server["url"],
                "headers": server["headers"],
                "oauth": False,
                "enabled": False,
            }
        }
    }
    env = {
        **os.environ,
        "HOME": directory,
        **{
            f"XDG_{name}_HOME": f"{directory}/{name.lower()}"
            for name in ("CONFIG", "DATA", "CACHE", "STATE")
        },
        "OPENCODE_CONFIG_CONTENT": json.dumps(config),
        "OPENCODE_DISABLE_AUTOUPDATE": "true",
        "OPENCODE_DISABLE_DEFAULT_PLUGINS": "true",
    }
    with (Path(directory) / "opencode.log").open("w") as log:
        process = subprocess.Popen(
            [binary, "serve", "--hostname", "127.0.0.1", "--port", str(port)],
            cwd=directory,
            env=env,
            stdout=log,
            stderr=log,
        )
        client = OpenCodeClient(
            base_url=f"http://127.0.0.1:{port}", log=None, request_timeout_seconds=0.1
        )
        try:
            async with httpx.AsyncClient(timeout=5) as http:
                async with asyncio.timeout(15):
                    while True:
                        try:
                            ready = await http.get(f"http://127.0.0.1:{port}/mcp")
                            if ready.is_success:
                                break
                        except httpx.ConnectError:
                            pass
                        await asyncio.sleep(0.05)
                native = OpencodeHarness(
                    client=client,
                    attachment_processor=None,
                    log=SimpleNamespace(warn=lambda *_args, **_kwargs: None),
                    limits=PromptLimits(10, 10, 1),
                    managed_mcp_names=("example",),
                )
                wrapped = ManagedMcpHarness(
                    native,
                    servers=[server],
                    control_plane_url=origin,
                    session_id="local",
                    auth_token="sandbox-fixture",
                )
                prompt = HarnessPrompt(
                    message_id="m",
                    text="must not reach inference",
                    managed_mcp={"messageId": "m", "revision": 1, "servers": ["example"]},
                )
                try:
                    await wrapped.run_prompt(prompt, None)
                except httpx.ReadTimeout:
                    pass
                else:
                    raise AssertionError("Expected uncertain native connect timeout")
                assert DelayedMcpFixture.started.is_set()
                before = (await http.get(f"http://127.0.0.1:{port}/mcp")).json()
                assert before["example"]["status"] == "disabled"
                assert wrapped.cleanup_failed
                DelayedMcpFixture.release.set()
                async with asyncio.timeout(5):
                    while True:
                        after = (await http.get(f"http://127.0.0.1:{port}/mcp")).json()
                        if after["example"]["status"] == "connected":
                            break
                        await asyncio.sleep(0.05)
                following = await wrapped.run_prompt(prompt, None)
                assert not following.success and "restart" in following.error
                return {
                    "opencode": "1.18.29",
                    "after_disconnect": "disabled",
                    "after_late_initialize": "connected",
                    "runtime_poisoned": wrapped.cleanup_failed,
                    "following_turn_refused": not following.success,
                }
        finally:
            DelayedMcpFixture.release.set()
            await client.aclose()
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


async def main(binary: str, port: int) -> None:
    assert subprocess.check_output([binary, "--version"], text=True).strip() == "1.18.29"
    with (
        tempfile.TemporaryDirectory(prefix="managed-mcp-cancel-") as directory,
        ThreadingHTTPServer(("127.0.0.1", 0), DelayedMcpFixture) as fixture,
    ):
        thread = Thread(target=fixture.serve_forever, daemon=True)
        thread.start()
        try:
            result = await check(binary, directory, f"http://127.0.0.1:{fixture.server_port}", port)
            print(json.dumps(result, indent=2))
        finally:
            fixture.shutdown()
            thread.join()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--opencode", required=True)
    parser.add_argument("--port", type=int, default=17883)
    args = parser.parse_args()
    asyncio.run(main(args.opencode, args.port))

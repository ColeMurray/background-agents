import asyncio
import os
import sys
from pathlib import Path

import pytest

from sandbox_runtime.harness.codex.client import CodexClient, CodexTransportError

PEER = Path(__file__).parent / "fixtures" / "codex_app_server.py"


async def test_slow_tool_does_not_block_refresh_reply_or_client_requests(tmp_path):
    release = asyncio.Event()

    async def respond(method, params):
        if method == "item/tool/call":
            await release.wait()
        return {"ok": True}

    client = CodexClient(
        command=(sys.executable, str(PEER)),
        cwd=tmp_path,
        env={"PATH": os.environ["PATH"]},
        on_request=respond,
    )
    try:
        await client.open()
        await client.request("initialize", {})
        await client.notify("initialized", {})
        await client.request("callbacks", {})
        observed = await asyncio.wait_for(client.next_notification(), 1)
        assert observed["params"]["id"] == 71
        assert (await client.request("ping", {}))["echo"] == "ping"
        release.set()
        observed = await asyncio.wait_for(client.next_notification(), 1)
        assert observed["params"]["id"] == "slow"
    finally:
        assert await client.close(timeout_seconds=2)


@pytest.mark.parametrize("method", ["exit", "malformed"])
async def test_transport_loss_settles_pending_calls_without_raw_peer_data(tmp_path, method):
    client = CodexClient(command=(sys.executable, str(PEER)), cwd=tmp_path, env={})
    await client.open()
    try:
        with pytest.raises(CodexTransportError):
            await asyncio.wait_for(client.request(method, {}), 2)
    finally:
        assert await client.close(timeout_seconds=2)


async def test_close_deadline_includes_host_callback_containment(tmp_path):
    entered, release = asyncio.Event(), asyncio.Event()

    async def respond(method, params):
        if method == "item/tool/call":
            entered.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                await release.wait()
        return {}

    client = CodexClient(
        command=(sys.executable, str(PEER)), cwd=tmp_path, env={}, on_request=respond
    )
    await client.open()
    await client.request("callbacks", {})
    await entered.wait()
    try:
        assert not await asyncio.wait_for(client.close(timeout_seconds=0.05), 0.2)
    finally:
        release.set()
        await asyncio.sleep(0.05)
        assert await client.close(timeout_seconds=2)


@pytest.mark.parametrize("method", ["fragmented", "oversize"])
async def test_wire_framing_handles_utf8_splits_and_rejects_oversize(tmp_path, method):
    client = CodexClient(command=(sys.executable, str(PEER)), cwd=tmp_path, env={})
    await client.open()
    try:
        if method == "fragmented":
            assert (await client.request(method, {}))["text"] == "hello 🌊"
        else:
            with pytest.raises(CodexTransportError):
                await client.request(method, {})
    finally:
        assert await client.close(timeout_seconds=2)

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


async def test_undelivered_notification_bytes_are_bounded(tmp_path, monkeypatch):
    monkeypatch.setattr("sandbox_runtime.harness.codex.client.MAX_QUEUED_NOTIFICATION_BYTES", 4096)
    flood = (
        "import json,sys,time\n"
        "for i in range(8):\n"
        "    print(json.dumps({'method': 'note', 'params': {'pad': 'x' * 1024}}), flush=True)\n"
        "time.sleep(30)\n"
    )
    client = CodexClient(command=(sys.executable, "-c", flood), cwd=tmp_path, env={})
    await client.open()
    try:
        with pytest.raises(CodexTransportError):
            async with asyncio.timeout(5):
                while not client._failure:
                    await asyncio.sleep(0.01)
                while True:
                    await client.next_notification()
    finally:
        await client.close(timeout_seconds=2)


def _slow_spawn(monkeypatch, entered: asyncio.Event, release: asyncio.Event):
    real = asyncio.create_subprocess_exec

    async def slow(*args, **kwargs):
        process = await real(*args, **kwargs)
        entered.set()
        await release.wait()
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", slow)


@pytest.mark.parametrize("interrupt", ["cancel_open", "concurrent_close"])
async def test_pending_spawn_is_contained_by_every_close_path(tmp_path, monkeypatch, interrupt):
    entered, release = asyncio.Event(), asyncio.Event()
    _slow_spawn(monkeypatch, entered, release)
    client = CodexClient(
        command=(sys.executable, "-c", "import time; time.sleep(30)"), cwd=tmp_path, env={}
    )
    opening = asyncio.create_task(client.open())
    await entered.wait()
    if interrupt == "cancel_open":
        opening.cancel()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await opening
    else:
        closing = asyncio.create_task(client.close(timeout_seconds=2))
        await asyncio.sleep(0.05)
        # close() must not report containment before the spawned process exists.
        assert not closing.done()
        release.set()
        assert await closing
        with pytest.raises(CodexTransportError):
            await opening
    assert client._process is not None
    assert client._process.returncode is not None


async def test_spawn_finishing_after_the_close_deadline_is_still_contained(tmp_path, monkeypatch):
    entered, release = asyncio.Event(), asyncio.Event()
    _slow_spawn(monkeypatch, entered, release)
    client = CodexClient(
        command=(sys.executable, "-c", "import time; time.sleep(30)"), cwd=tmp_path, env={}
    )
    opening = asyncio.create_task(client.open())
    await entered.wait()
    # The spawn outlives the close budget: containment is reported unconfirmed...
    assert not await client.close(timeout_seconds=0.05)
    release.set()
    with pytest.raises(CodexTransportError):
        await opening
    # ...but the process is still contained once the spawn completes.
    assert client._late_containment is not None
    await asyncio.wait_for(client._late_containment, 10)
    assert client._process is not None
    assert client._process.returncode is not None

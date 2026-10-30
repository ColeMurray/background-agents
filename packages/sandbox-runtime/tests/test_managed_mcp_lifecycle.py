"""Managed MCP harness contracts, bounded cleanup, and reconnect readiness."""

from __future__ import annotations

import asyncio
from contextlib import suppress
from unittest.mock import AsyncMock, Mock
from uuid import UUID

import httpx
import pytest

from sandbox_runtime.attachment_processor import AttachmentProcessor
from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.harness.base import AgentHarness, HarnessPrompt, PromptLimits, TurnOutcome
from sandbox_runtime.harness.claude import ClaudeHarness, ClaudeHarnessConfig
from sandbox_runtime.harness.opencode import OpencodeHarness
from sandbox_runtime.harness.opencode_client import OpenCodeClient
from sandbox_runtime.log_config import get_logger
from sandbox_runtime.managed_mcp import ManagedMcpHarness
from sandbox_runtime.repo_config import dump_repo_manifest

SERVER = {
    "name": "example",
    "type": "remote",
    "url": "https://fixture.invalid/mcp",
    "headers": {"Authorization": "Bearer fixture"},
    "managed_proxy": {"version": 1, "auth_mode": "user_oauth", "auth_revision": 1},
}


@pytest.fixture
def native():
    return OpencodeHarness(
        client=Mock(spec=OpenCodeClient),
        attachment_processor=Mock(spec=AttachmentProcessor),
        log=get_logger("managed_mcp_lifecycle"),
        limits=PromptLimits(1, 5, 1),
        managed_mcp_names=("example",),
    )


def _wrap(native, origin="https://fixture.invalid"):
    return ManagedMcpHarness(
        native,
        servers=[SERVER],
        control_plane_url=origin,
        session_id="fixture-session",
        auth_token="fixture",
    )


def _prompt():
    return HarnessPrompt(
        message_id="fixture-message",
        text="No inference should run in these tests.",
        managed_mcp={
            "messageId": "fixture-message",
            "revision": 1,
            "servers": ["example"],
            "unavailable": [],
        },
    )


def test_wrapper_satisfies_runtime_protocol_and_forwards_session_identity(native):
    wrapped = _wrap(native)

    assert isinstance(native, AgentHarness)
    assert isinstance(wrapped, AgentHarness)
    assert wrapped.id == native.id
    native.session_id = "native-session"
    assert wrapped.session_id == "native-session"
    wrapped.session_id = "replacement-session"
    assert native.session_id == "replacement-session"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "args", "result"),
    [
        ("open", (), None),
        ("close", (), None),
        ("resume_session", ("persisted-session",), True),
        ("create_session", (), None),
        ("abort", (), True),
        ("stop_execution", (0.5,), False),
    ],
)
async def test_wrapper_forwards_native_lifecycle(native, monkeypatch, method, args, result):
    operation = AsyncMock(return_value=result)
    monkeypatch.setattr(native, method, operation)
    assert await getattr(_wrap(native), method)(*args) == result
    operation.assert_awaited_once_with(*args)


@pytest.mark.asyncio
async def test_native_preparation_returns_unavailable_names_without_starting_claude(
    native, tmp_path
):
    claude = ClaudeHarness(
        config=ClaudeHarnessConfig(
            workdir=tmp_path,
            config_dir=tmp_path / "claude",
            mcp_servers=(SERVER,),
            default_model="claude-sonnet-4-6",
            oauth_managed=False,
        ),
        log=native.log,
        limits=native.limits,
        environ={},
    )
    async with asyncio.timeout(2):
        claude_result = await claude.prepare_managed_mcp(set())
        opencode_result = await native.prepare_managed_mcp(set())

    assert claude_result == opencode_result == []
    assert claude._client is None
    native.client.set_mcp_connected.assert_awaited_once_with("example", False)


@pytest.mark.asyncio
async def test_authority_close_has_a_wall_clock_deadline_despite_dripping_response(
    native, monkeypatch
):
    close_timeout_seconds = 0.5
    monkeypatch.setattr(
        "sandbox_runtime.managed_mcp.MANAGED_MCP_CLOSE_TIMEOUT_SECONDS", close_timeout_seconds
    )
    # Keep this a real loopback HTTPX request even on hosts with configured proxies.
    monkeypatch.setenv("NO_PROXY", "*")
    monkeypatch.setenv("no_proxy", "*")
    authority_started = asyncio.Event()
    finish_response = asyncio.Event()
    requests = []
    handlers = []
    loop = asyncio.get_running_loop()
    first_body_at = None

    async def respond(reader, writer):
        nonlocal first_body_at
        try:
            headers = await reader.readuntil(b"\r\n\r\n")
            requests.append(headers.split(b"\r\n", 1)[0])
            content_length = next(
                int(line.split(b":", 1)[1])
                for line in headers.split(b"\r\n")
                if line.lower().startswith(b"content-length:")
            )
            await reader.readexactly(content_length)
            writer.write(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                b"Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
                b"2\r\n{}\r\n"
            )
            first_body_at = loop.time()
            while not finish_response.is_set():
                writer.write(b"1\r\n \r\n")
                await writer.drain()
                authority_started.set()
                # Keep the idle timeout satisfied until the test releases the response.
                await asyncio.sleep(0.01)
            writer.write(b"0\r\n\r\n")
            await writer.drain()
        except ConnectionError:
            # The bounded client may close before the fixture finishes writing.
            pass
        finally:
            writer.close()
            with suppress(ConnectionError):
                await asyncio.wait_for(writer.wait_closed(), timeout=1)

    def accept(reader, writer):
        handlers.append(asyncio.create_task(respond(reader, writer)))

    server = await asyncio.start_server(accept, "127.0.0.1", 0)
    turn_task = None
    try:
        async with asyncio.timeout(8):
            port = server.sockets[0].getsockname()[1]
            wrapped = _wrap(native, f"http://127.0.0.1:{port}")
            monkeypatch.setattr(native, "run_prompt", AsyncMock(return_value=TurnOutcome.ok()))
            native_close = AsyncMock()
            monkeypatch.setattr(native, "close_managed_mcp", native_close)
            # OpenCode preparation also calls close_managed_mcp; isolate post-turn cleanup.
            monkeypatch.setattr(native, "prepare_managed_mcp", AsyncMock(return_value=[]))
            turn_task = asyncio.create_task(wrapped.run_prompt(_prompt(), AsyncMock()))
            await authority_started.wait()
            outcome = await asyncio.wait_for(asyncio.shield(turn_task), close_timeout_seconds * 4)
            assert outcome.success
            assert not finish_response.is_set()
            assert first_body_at is not None
            assert loop.time() - first_body_at < close_timeout_seconds * 4
            native_close.assert_awaited_once_with()
            assert not wrapped.cleanup_failed
            assert requests == [b"POST /sessions/fixture-session/mcp-context/close HTTP/1.1"]
            finish_response.set()
            await asyncio.gather(*handlers)
    finally:
        server.close()
        finish_response.set()
        tasks = [*handlers, *([turn_task] if turn_task is not None else [])]
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.wait_for(
            asyncio.gather(server.wait_closed(), *tasks, return_exceptions=True), timeout=2
        )


@pytest.mark.asyncio
async def test_reconnect_preserves_capability_and_instance_id_during_a_healthy_turn(
    native, monkeypatch, tmp_path
):
    started = asyncio.Event()
    release = asyncio.Event()

    async def run(prompt, emit):
        started.set()
        await release.wait()
        return TurnOutcome.ok()

    async def close_authority(self, url, **kwargs):
        return httpx.Response(200, request=httpx.Request("POST", url))

    monkeypatch.setattr(native, "run_prompt", AsyncMock(side_effect=run))
    monkeypatch.setattr(httpx.AsyncClient, "post", close_authority)
    wrapped = _wrap(native)
    bridge = AgentBridge(
        sandbox_id="fixture-sandbox",
        session_id="fixture-session",
        control_plane_url="https://fixture.invalid",
        auth_token="fixture",
        harness=wrapped,
    )
    bridge.repo_manifest_path = tmp_path / "repositories.json"
    bridge.repo_manifest_path.write_text(dump_repo_manifest([]))
    send_event = AsyncMock(return_value=True)
    monkeypatch.setattr(bridge, "_send_event", send_event)
    turn_task = None
    try:
        async with asyncio.timeout(3):
            await bridge.boot_attach.on_connect()
            assert send_event.await_args.args[0]["managedMcpVersion"] == 1
            instance_id = send_event.await_args.args[0]["bridgeInstanceId"]
            assert str(UUID(instance_id)) == instance_id
            turn_task = asyncio.create_task(wrapped.run_prompt(_prompt(), AsyncMock()))
            await started.wait()

            assert not wrapped.cleanup_failed
            assert not turn_task.done()
            await bridge.boot_attach.on_connect()
            reconnect_ready = send_event.await_args.args[0]
            assert reconnect_ready["type"] == "ready"
            assert reconnect_ready["managedMcpVersion"] == 1
            assert reconnect_ready["bridgeInstanceId"] == instance_id
            assert bridge.harness is wrapped

            release.set()
            assert (await turn_task).success
            assert not wrapped.cleanup_failed
            await bridge.boot_attach.on_connect()
            assert send_event.await_args.args[0]["managedMcpVersion"] == 1
            assert send_event.await_args.args[0]["bridgeInstanceId"] == instance_id
    finally:
        release.set()
        if turn_task is not None:
            if not turn_task.done():
                turn_task.cancel()
            await asyncio.wait_for(asyncio.gather(turn_task, return_exceptions=True), timeout=2)


def test_new_bridge_construction_gets_a_new_instance_id(native, tmp_path):
    def new_bridge():
        bridge = AgentBridge(
            sandbox_id="same-allocation",
            session_id="same-session",
            control_plane_url="https://fixture.invalid",
            auth_token="fixture",
            harness=_wrap(native),
        )
        bridge.repo_manifest_path = tmp_path / "repositories.json"
        return bridge

    first = new_bridge()
    second = new_bridge()
    first_id = first._build_ready_event()["bridgeInstanceId"]
    second_id = second._build_ready_event()["bridgeInstanceId"]
    assert UUID(first_id).version == UUID(second_id).version == 4
    assert first_id != second_id
    assert first._build_ready_event()["bridgeInstanceId"] == first_id

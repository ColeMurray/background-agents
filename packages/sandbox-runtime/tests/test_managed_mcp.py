"""Authority closes before native clients, including failed and cancelled turns."""

import asyncio
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from sandbox_runtime.harness.base import HarnessPrompt, PromptLimits, TurnOutcome
from sandbox_runtime.harness.opencode import OpencodeHarness
from sandbox_runtime.harness.opencode_client import McpInitializationUnavailable, OpenCodeClient
from sandbox_runtime.managed_mcp import ManagedMcpHarness, managed_marker

SERVER = {
    "id": "s",
    "name": "example",
    "type": "remote",
    "url": "https://proxy.test/mcp",
    "headers": {"Authorization": "Bearer sandbox"},
    "managed_proxy": {"version": 1, "auth_mode": "user_oauth", "auth_revision": 1},
}


def make(monkeypatch, *, close_error=False, run_error=None):
    events = []

    async def prepare(names):
        events.append(("prepare", names))
        return []

    async def run(prompt, emit):
        events.append("run")
        if run_error:
            raise run_error
        return TurnOutcome.ok()

    async def close():
        events.append("native-close")

    async def post(self, url, **kwargs):
        events.append("authority-close")
        assert kwargs["json"] == {"messageId": "m", "revision": 7}
        if close_error:
            raise httpx.ConnectError("unavailable")
        return httpx.Response(200, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    native = SimpleNamespace(
        prepare_managed_mcp=prepare,
        run_prompt=run,
        close_managed_mcp=close,
        limits=PromptLimits(
            inactivity_timeout_seconds=10,
            prompt_max_duration_seconds=30,
            prompt_cleanup_timeout_seconds=1,
        ),
    )
    wrapped = ManagedMcpHarness(
        native,
        servers=[SERVER],
        control_plane_url="https://proxy.test",
        session_id="session",
        auth_token="sandbox",
    )
    prompt = HarnessPrompt(
        message_id="m",
        text="hello",
        managed_mcp={"messageId": "m", "revision": 7, "servers": ["example"], "unavailable": []},
    )
    return events, wrapped, prompt


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid_name", [{}, [], None, 1])
async def test_invalid_connector_names_fail_before_preparation(monkeypatch, invalid_name):
    events, wrapped, prompt = make(monkeypatch)
    prompt.managed_mcp["servers"] = [invalid_name]
    outcome = await wrapped.run_prompt(prompt, AsyncMock())
    assert not outcome.success
    assert outcome.error == "Invalid managed MCP execution context."
    assert events == []
    assert not wrapped.cleanup_failed


@pytest.mark.asyncio
async def test_success_closes_authority_before_clients_and_next_turn(monkeypatch):
    events, wrapped, prompt = make(monkeypatch)
    assert (await wrapped.run_prompt(prompt, AsyncMock())).success
    assert events == [("prepare", {"example"}), "run", "authority-close", "native-close"]
    assert not wrapped.cleanup_failed
    assert (await wrapped.run_prompt(prompt, AsyncMock())).success


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [RuntimeError("failure"), asyncio.CancelledError()])
async def test_failure_and_cancellation_still_dispose_owned_clients(monkeypatch, failure):
    events, wrapped, prompt = make(monkeypatch, run_error=failure)
    with pytest.raises(type(failure)):
        await wrapped.run_prompt(prompt, AsyncMock())
    assert events[-2:] == ["authority-close", "native-close"]


@pytest.mark.asyncio
async def test_authority_close_failure_keeps_turn_result_and_later_turns(monkeypatch):
    events, wrapped, prompt = make(monkeypatch, close_error=True)
    assert (await wrapped.run_prompt(prompt, AsyncMock())).success
    assert events[-2:] == ["authority-close", "native-close"]
    assert not wrapped.cleanup_failed
    assert (await wrapped.run_prompt(prompt, AsyncMock())).success
    assert events.count("run") == 2


@pytest.mark.asyncio
async def test_native_close_failure_prevents_later_delegated_turn(monkeypatch):
    events, wrapped, prompt = make(monkeypatch)
    wrapped.harness.close_managed_mcp = AsyncMock(side_effect=RuntimeError("stuck"))
    with pytest.raises(RuntimeError):
        await wrapped.run_prompt(prompt, AsyncMock())
    assert wrapped.cleanup_failed
    assert not (await wrapped.run_prompt(prompt, AsyncMock())).success
    assert events.count("run") == 1


@pytest.mark.asyncio
async def test_native_close_timeout_stays_poisoned(monkeypatch):
    events, wrapped, prompt = make(monkeypatch)
    monkeypatch.setattr("sandbox_runtime.managed_mcp.MANAGED_MCP_CLOSE_TIMEOUT_SECONDS", 0.02)

    async def close():
        await asyncio.Event().wait()

    wrapped.harness.close_managed_mcp = close
    async with asyncio.timeout(2):
        with pytest.raises(TimeoutError):
            await wrapped.run_prompt(prompt, AsyncMock())
        assert wrapped.cleanup_failed
        assert not (await wrapped.run_prompt(prompt, AsyncMock())).success
    assert events.count("run") == 1


@pytest.mark.asyncio
async def test_repeated_cancellation_during_native_cleanup_stays_poisoned(monkeypatch):
    _, wrapped, prompt = make(monkeypatch)
    run_started = asyncio.Event()
    close_started = asyncio.Event()

    async def run(prompt, emit):
        run_started.set()
        await asyncio.Event().wait()

    async def close():
        close_started.set()
        await asyncio.Event().wait()

    wrapped.harness.run_prompt = run
    wrapped.harness.close_managed_mcp = close
    task = asyncio.create_task(wrapped.run_prompt(prompt, AsyncMock()))
    try:
        async with asyncio.timeout(2):
            await run_started.wait()
            assert not wrapped.cleanup_failed
            task.cancel()
            await close_started.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert wrapped.cleanup_failed
            assert not (await wrapped.run_prompt(prompt, AsyncMock())).success
    finally:
        if not task.done():
            task.cancel()
        await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), timeout=1)


@pytest.mark.asyncio
async def test_unavailable_connector_emits_recovery_and_unrelated_tools_continue(monkeypatch):
    events, wrapped, prompt = make(monkeypatch)
    prompt.managed_mcp["servers"] = []
    prompt.managed_mcp["unavailable"] = [{"name": "example", "code": "mcp_connection_required"}]
    emit = AsyncMock()
    assert (await wrapped.run_prompt(prompt, emit)).success
    assert events[0] == ("prepare", set())
    warning = emit.await_args.args[0]
    assert warning["type"] == "warning"
    assert "mcp-connections" in warning["message"]


@pytest.mark.asyncio
@pytest.mark.parametrize("explicit_budget", [None, 1.0])
async def test_preparation_and_warnings_spend_one_turn_budget(monkeypatch, explicit_budget):
    events, wrapped, prompt = make(monkeypatch)
    prompt = replace(prompt, max_duration_seconds=explicit_budget)
    prompt.managed_mcp["unavailable"] = [{"name": "example", "code": "mcp_connection_required"}]
    native_run = AsyncMock(return_value=TurnOutcome.ok())
    wrapped.harness.run_prompt = native_run

    async def prepare(names):
        await asyncio.sleep(0.01)
        return ["example"]

    async def emit(event):
        await asyncio.sleep(0.01)

    wrapped.harness.prepare_managed_mcp = prepare
    assert (await wrapped.run_prompt(prompt, emit)).success
    forwarded = native_run.await_args.args[0]
    original_budget = explicit_budget or wrapped.harness.limits.prompt_max_duration_seconds
    assert 0 < forwarded.max_duration_seconds <= original_budget - 0.03
    assert prompt.max_duration_seconds == explicit_budget
    assert events[-2:] == ["authority-close", "native-close"]


@pytest.mark.asyncio
@pytest.mark.parametrize("blocked_stage", ["prepare", "warning"])
async def test_expired_prompt_never_starts_native_turn_and_still_cleans_up(
    monkeypatch, blocked_stage
):
    events, wrapped, prompt = make(monkeypatch)
    prompt = replace(prompt, max_duration_seconds=0.01)
    native_run = AsyncMock(return_value=TurnOutcome.ok())
    wrapped.harness.run_prompt = native_run

    async def block(*args):
        await asyncio.Event().wait()

    emit = AsyncMock()
    if blocked_stage == "prepare":
        wrapped.harness.prepare_managed_mcp = block
    else:
        prompt.managed_mcp["unavailable"] = [{"name": "example", "code": "mcp_connection_required"}]
        emit = block
    async with asyncio.timeout(1):
        outcome = await wrapped.run_prompt(prompt, emit)
    assert not outcome.success
    assert "timed out" in outcome.error
    native_run.assert_not_called()
    assert events[-2:] == ["authority-close", "native-close"]
    assert wrapped.cleanup_failed == (blocked_stage == "prepare")


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [httpx.ReadTimeout("unknown"), asyncio.CancelledError()])
async def test_uncertain_prepare_stays_poisoned_after_successful_disconnect(monkeypatch, failure):
    events, wrapped, prompt = make(monkeypatch)
    wrapped.harness.prepare_managed_mcp = AsyncMock(side_effect=failure)
    with pytest.raises(type(failure)):
        await wrapped.run_prompt(prompt, AsyncMock())
    assert events[-2:] == ["authority-close", "native-close"]
    assert wrapped.cleanup_failed
    assert not (await wrapped.run_prompt(prompt, AsyncMock())).success
    assert "run" not in events


@pytest.mark.asyncio
@pytest.mark.parametrize("uncertain", [False, True])
async def test_opencode_distinguishes_unavailable_from_uncertain_preparation(uncertain):
    async def set_connected(name, connected):
        if connected:
            if uncertain:
                raise httpx.ReadTimeout("native operation may still complete")
            raise McpInitializationUnavailable("settled without connection")

    harness = OpencodeHarness(
        client=SimpleNamespace(set_mcp_connected=set_connected),
        attachment_processor=None,
        log=SimpleNamespace(warn=lambda *args, **kwargs: None),
        limits=PromptLimits(1, 1, 1),
        managed_mcp_names=("example",),
    )
    if uncertain:
        with pytest.raises(httpx.ReadTimeout):
            await harness.prepare_managed_mcp({"example"})
    else:
        assert await harness.prepare_managed_mcp({"example"}) == ["example"]


@pytest.mark.asyncio
@pytest.mark.parametrize("state", [None, "pending", "unexpected"])
@pytest.mark.parametrize("connected", [False, True])
async def test_unknown_native_state_never_confirms_connection_or_cleanup(state, connected):
    def respond(request):
        return httpx.Response(200, json={"example": {"status": state}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
        client = OpenCodeClient(base_url="http://native.test", log=None, http_client=http)
        with pytest.raises(RuntimeError) as error:
            await client.set_mcp_connected("example", connected)
        assert not isinstance(error.value, McpInitializationUnavailable)


@pytest.mark.asyncio
async def test_allocation_fence_recovery_requests_sandbox_replacement_not_reauthentication(
    monkeypatch,
):
    _, wrapped, prompt = make(monkeypatch)
    prompt.managed_mcp["servers"] = []
    prompt.managed_mcp["unavailable"] = [
        {"name": "example", "code": "mcp_runtime_restart_required"}
    ]
    emit = AsyncMock()
    assert (await wrapped.run_prompt(prompt, emit)).success
    warning = emit.await_args.args[0]["message"]
    assert "sandbox allocation" in warning
    assert "reconnect in Settings" not in warning


def test_unknown_marker_and_env_fallback_fail_closed():
    for override in [
        {"managed_proxy": {"version": 2}},
        {"env": {"Authorization": "Bearer private"}},
    ]:
        with pytest.raises(ValueError):
            managed_marker({**SERVER, **override})


def test_runtime_roundtrip_preserves_marker_and_defers_claude_personal_config():
    from sandbox_runtime.harness.claude import mcp_server_options
    from sandbox_runtime.types import SessionConfig

    config = SessionConfig.model_validate({"session_id": "s", "mcp_servers": [SERVER]})
    restored = config.model_dump()["mcp_servers"][0]
    assert restored["managed_proxy"] == SERVER["managed_proxy"]
    assert mcp_server_options((restored,)) == {}
    assert mcp_server_options((restored,), {"example"})["example"]["headers"] == SERVER["headers"]

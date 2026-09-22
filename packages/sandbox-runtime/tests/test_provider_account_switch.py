import asyncio
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from sandbox_runtime.provider_account_switch import ProviderAccountSwitchRuntime
from sandbox_runtime.provider_switch_control import HarnessSwitchControl
from tests.event_forwarder_fakes import make_forwarder, open_ws, sent_events
from tests.test_claude_harness import Harness, Issued

GENERATION = {"sandboxId": "sandbox", "createdAt": 100}
IDENTITY = {
    "operationId": "switch",
    "provider": "anthropic",
    "bindingRevision": 2,
    "generation": GENERATION,
    "conversationId": "conversation",
}


def runtime(monkeypatch):
    monkeypatch.setenv("PROVIDER_ACCOUNT_SWITCH_QUALIFIED", "claude/anthropic")
    harness = SimpleNamespace(
        id=SimpleNamespace(value="claude"),
        session_id="conversation",
        stop_execution=AsyncMock(return_value=True),
        apply_provider_account=AsyncMock(),
    )
    bridge = SimpleNamespace(
        _require_harness=lambda: harness,
        _parse_generation=lambda generation: generation,
        shutdown_preparation=SimpleNamespace(generation=GENERATION, fenced=False),
        activity=SimpleNamespace(drain_for_shutdown=AsyncMock(return_value=True)),
        _shutdown_push_error_event=MagicMock(),
        _persist_rotated_session_id=AsyncMock(),
        _send_event=AsyncMock(),
        auth_token="token",
    )
    return ProviderAccountSwitchRuntime(bridge), bridge, harness


def command(kind):
    return {
        **IDENTITY,
        "type": f"provider_account_{kind}",
        "deadlineMs": time.time() * 1000 + 60_000,
        "model": "anthropic/claude-sonnet-4-6",
        "reasoningEffort": "high",
    }


async def test_stops_before_application_and_replays_without_reexecuting(monkeypatch):
    switch, bridge, harness = runtime(monkeypatch)
    await switch.handle(command("quiesce"))
    assert switch.fenced
    assert bridge._send_event.call_args.args[0]["outcome"] == "quiesced"
    harness.apply_provider_account.assert_not_awaited()
    await switch.handle(command("apply"))
    await switch.handle(command("apply"))
    harness.apply_provider_account.assert_awaited_once_with(
        IDENTITY, model="anthropic/claude-sonnet-4-6", reasoning_effort="high"
    )
    assert not switch.fenced
    assert bridge._send_event.call_args.args[0]["outcome"] == "applied"


async def test_failed_containment_never_applies_or_unfences(monkeypatch):
    switch, bridge, harness = runtime(monkeypatch)
    bridge.activity.drain_for_shutdown.return_value = False
    await switch.handle(command("quiesce"))
    await switch.handle(command("apply"))
    assert switch.fenced
    harness.apply_provider_account.assert_not_awaited()


async def test_claude_transcript_only_restore_applies_current_model_and_effort(
    monkeypatch, tmp_path
):
    switch, bridge, _ = runtime(monkeypatch)
    credentials = SimpleNamespace(
        fetch=AsyncMock(side_effect=[Issued("initial-secret"), Issued("replacement-secret")])
    )
    h = Harness(
        tmp_path,
        oauth_managed=True,
        credential_client=credentials,
        transcript_exists=lambda *_args: True,
    )
    await h.harness.open()
    assert await h.harness.resume_session("conversation")
    assert not h.clients  # no prompt or SDK connection has occurred in this process
    bridge._require_harness = lambda: h.harness

    async def drain(**kwargs):
        return await kwargs["stop_execution"](1)

    bridge.activity.drain_for_shutdown.side_effect = drain
    await switch.handle(command("quiesce"))
    apply = {**command("apply"), "model": "anthropic/claude-opus-4-6", "reasoningEffort": "medium"}
    await switch.handle(apply)
    await switch.handle(apply)
    assert bridge._send_event.call_args.args[0]["outcome"] == "applied"
    assert not switch.fenced
    assert len(h.clients) == 1
    assert h.client.connected
    assert h.client.queries == []  # application must not replay the interrupted prompt
    assert h.client.options["model"] == "claude-opus-4-6"
    assert h.client.options["effort"] == "medium"
    assert h.client.options["resume"] == "conversation"
    assert h.client.options["env"]["CLAUDE_CODE_OAUTH_TOKEN"] == "replacement-secret"
    credentials.fetch.assert_awaited_with("anthropic", IDENTITY)
    assert credentials.fetch.await_count == 2


async def test_generation_mismatch_and_unqualified_provider_never_apply(monkeypatch):
    switch, bridge, harness = runtime(monkeypatch)
    await switch.handle({**command("apply"), "generation": {**GENERATION, "createdAt": 99}})
    bridge._send_event.assert_not_awaited()
    await switch.handle({**command("quiesce"), "provider": "openai"})
    bridge.activity.drain_for_shutdown.assert_not_awaited()
    harness.apply_provider_account.assert_not_awaited()


async def test_changed_conversation_and_expired_deadline_stay_paused(monkeypatch):
    switch, bridge, harness = runtime(monkeypatch)
    harness.session_id = "other"
    await switch.handle(command("quiesce"))
    assert bridge._send_event.call_args.args[0]["reason"] == "conversation_unavailable"
    assert switch.fenced
    harness.session_id = "conversation"
    await switch.handle({**command("quiesce"), "deadlineMs": 0})
    assert switch.fenced
    harness.apply_provider_account.assert_not_awaited()


async def test_delayed_quiesced_ack_cannot_remove_applied_replay():
    forwarder = make_forwarder()
    ws = open_ws()
    await forwarder.bind(ws)
    await forwarder.send({**IDENTITY, "type": "provider_account_switch", "outcome": "quiesced"})
    await forwarder.send({**IDENTITY, "type": "provider_account_switch", "outcome": "applied"})
    events = sent_events(ws)
    assert events[0]["ackId"] != events[1]["ackId"]
    assert forwarder.acknowledge(events[0]["ackId"])
    assert events[1]["ackId"] in forwarder._pending_acks


async def test_supervisor_stop_failure_is_not_cached_as_containment():
    owner = SimpleNamespace(
        stop=AsyncMock(side_effect=[RuntimeError("stop failed"), None, None]),
        restart_for_provider=AsyncMock(),
    )
    control = HarnessSwitchControl(owner, "token")

    async def request(action):
        reader = asyncio.StreamReader()
        reader.feed_data(
            json.dumps({**IDENTITY, "token": "token", "action": action}).encode() + b"\n"
        )
        reader.feed_eof()
        writer = MagicMock(drain=AsyncMock(), wait_closed=AsyncMock())
        await control.handle(reader, writer)
        return json.loads(writer.write.call_args.args[0])

    assert await request("stop") == {"ok": False}
    assert await request("start") == {"ok": False}
    owner.restart_for_provider.assert_not_awaited()
    assert await request("stop") == {"ok": True}
    assert await request("start") == {"ok": True}
    assert await request("stop") == {"ok": True}
    assert not control.applied
    assert owner.stop.await_count == 3


async def test_restored_generation_requiesces_stopped_opencode_via_supervisor(monkeypatch):
    switch, bridge, harness = runtime(monkeypatch)
    harness.id.value = "opencode"
    monkeypatch.setenv("PROVIDER_ACCOUNT_SWITCH_QUALIFIED", "opencode/openai")
    control = AsyncMock()
    monkeypatch.setattr("sandbox_runtime.provider_account_switch.harness_control", control)

    async def drain(**kwargs):
        return await kwargs["stop_execution"](30)

    bridge.activity.drain_for_shutdown.side_effect = drain
    old_command = {**command("quiesce"), "provider": "openai", "model": "openai/gpt-test"}
    await switch.handle(old_command)
    assert switch.quiesced
    next_generation = {**GENERATION, "createdAt": 200}
    switch.establish_generation(next_generation)
    bridge.shutdown_preparation.generation = next_generation
    assert switch.fenced
    assert not switch.quiesced
    next_command = {
        **old_command,
        "operationId": "recovery",
        "generation": next_generation,
        "bindingRevision": 3,
    }
    await switch.handle(next_command)
    assert switch.quiesced
    harness.stop_execution.assert_not_awaited()
    assert control.await_count == 2
    assert control.call_args.args[1]["operationId"] == "recovery"
    assert bridge._send_event.call_args.args[0]["outcome"] == "quiesced"


async def test_supervisor_accepts_new_generation_after_failed_operation():
    owner = SimpleNamespace(stop=AsyncMock(), restart_for_provider=AsyncMock())
    control = HarnessSwitchControl(owner, "token")

    async def request(identity):
        reader = asyncio.StreamReader()
        reader.feed_data(
            json.dumps({**identity, "token": "token", "action": "stop"}).encode() + b"\n"
        )
        reader.feed_eof()
        writer = MagicMock(drain=AsyncMock(), wait_closed=AsyncMock())
        await control.handle(reader, writer)
        return json.loads(writer.write.call_args.args[0])

    assert await request(IDENTITY) == {"ok": True}
    newer = {**IDENTITY, "operationId": "recovery", "generation": {**GENERATION, "createdAt": 200}}
    assert await request(newer) == {"ok": True}
    assert await request(IDENTITY) == {"ok": False}
    assert owner.stop.await_count == 2

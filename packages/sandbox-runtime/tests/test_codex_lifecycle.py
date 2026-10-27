import asyncio
import base64
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.credentials.openai_access_token_client import OpenAIAccessTokenUnavailable
from sandbox_runtime.harness.base import (
    HarnessPrompt,
    HarnessStartError,
    PromptLimits,
)
from sandbox_runtime.harness.codex import CodexHarness, CodexHarnessConfig
from sandbox_runtime.harness.codex.client import CodexRpcError, CodexTransportError
from sandbox_runtime.memories import memory_path


def build(tmp_path):
    client = MagicMock()
    client.running = True
    client.open = AsyncMock()
    client.close = AsyncMock(return_value=True)
    client.notify = AsyncMock()
    client.request = AsyncMock(return_value={"account": {"type": "apiKey"}})
    h = CodexHarness(
        config=CodexHarnessConfig(tmp_path, tmp_path / "native", "gpt-6.1-sol", False),
        log=MagicMock(),
        limits=PromptLimits(1, 30, 5),
        client_factory=MagicMock(return_value=client),
        environ={"OPENAI_API_KEY": "fixture"},
    )
    return h, client


@pytest.mark.parametrize("memory", [None, "", "Pinned session directive"])
async def test_create_and_fresh_process_resume_load_pinned_memory(tmp_path, memory):
    def reply(method, params):
        if method in {"thread/start", "thread/resume"}:
            return {"thread": {"id": "thread"}}
        return {"account": {"type": "apiKey"}}

    harness, client = build(tmp_path)
    harness.config.state_dir.mkdir()
    if memory is not None:
        memory_path(harness.config.state_dir).write_text(memory)
    client.request.side_effect = reply
    await harness.create_session()
    submitted = next(
        call.args[1] for call in client.request.call_args_list if call.args[0] == "thread/start"
    )
    assert submitted["developerInstructions"] == (memory or "")
    assert "baseInstructions" not in submitted
    await harness.close()

    resumed, client = build(tmp_path)
    client.request.side_effect = reply
    await resumed.open()
    assert resumed.session_id == "thread"
    restored = next(
        call.args[1] for call in client.request.call_args_list if call.args[0] == "thread/resume"
    )
    assert restored["developerInstructions"] == (memory or "")
    assert "baseInstructions" not in restored
    await resumed.close()


@pytest.mark.parametrize("name", ["auth.json", "config.toml", "managed_config.toml"])
async def test_restored_native_authority_rejected_before_launch(tmp_path, name):
    h, client = build(tmp_path)
    h.config.state_dir.mkdir()
    (h.config.state_dir / name).write_text("unexpected authority")
    with pytest.raises(HarnessStartError):
        await h.open()
    client.open.assert_not_called()


async def test_native_project_trust_is_accepted_before_and_after_open(tmp_path):
    h, client = build(tmp_path)
    h.config.state_dir.mkdir()
    (h.config.state_dir / "config.toml").write_text(
        '[projects."/workspace/repo"]\ntrust_level = "trusted"\n'
    )
    await h.open()
    await h.open()
    client.open.assert_awaited_once()
    await h.close()


@pytest.mark.parametrize(
    "config",
    [
        'model_provider = "untrusted"\n',
        '[projects."/workspace/repo"]\ntrust_level = "trusted"\ncommand = "untrusted"\n',
        'projects = "invalid"\n',
        '[projects."/workspace/repo"]\ntrust_level = "invalid"\n',
    ],
)
async def test_non_trust_native_configuration_still_rejected(tmp_path, config):
    h, client = build(tmp_path)
    h.config.state_dir.mkdir()
    (h.config.state_dir / "config.toml").write_text(config)
    with pytest.raises(HarnessStartError):
        await h.open()
    client.open.assert_not_called()


async def test_unconfirmed_old_owner_never_replaced(tmp_path):
    h, client = build(tmp_path)
    h._client = client
    client.running = False
    client.close.return_value = False
    with pytest.raises(HarnessStartError):
        await h.open()
    assert h._client is client
    h._factory.assert_not_called()


async def test_failed_open_retains_unconfirmed_owner(tmp_path):
    h, client = build(tmp_path)
    client.request.side_effect = CodexTransportError("broken pipe")
    client.close.return_value = False
    with pytest.raises(CodexTransportError):
        await h.open()
    assert h._client is client


async def test_stop_does_not_wait_for_open_lock(tmp_path):
    h, client = build(tmp_path)
    h._client = client
    async with h._lock:
        assert await asyncio.wait_for(h.stop_execution(0.1), 0.2)
    client.close.assert_awaited_once()


async def test_lost_turn_start_response_fails_then_resumes_without_replaying(tmp_path):
    h, client = build(tmp_path)
    await h.open()
    h.session_id = "thread"
    h._usage_baseline_known = True
    h._persist()
    starts = 0

    async def request(method, params):
        nonlocal starts
        if method == "turn/start":
            starts += 1
            if starts == 1:
                raise CodexTransportError("lost response")
            return {"turn": {"id": "turn-2"}}
        if method == "thread/resume":
            return {"thread": {"id": "thread"}}
        return {"account": {"type": "apiKey"}}

    client.request.side_effect = request
    outcome = await h.run_prompt(HarnessPrompt("m1", "change a file"), AsyncMock())
    assert not outcome.success
    assert h._client is None
    assert json.loads(h._manifest_path.read_text())["usageBaselineKnown"] is False
    client.next_notification = AsyncMock(
        return_value={
            "method": "turn/completed",
            "params": {"threadId": "thread", "turn": {"id": "turn-2", "status": "completed"}},
        }
    )
    assert (await h.run_prompt(HarnessPrompt("m2", "next instruction"), AsyncMock())).success
    submissions = [
        call.args[1] for call in client.request.call_args_list if call.args[0] == "turn/start"
    ]
    assert [item["input"][0]["text"] for item in submissions] == [
        "change a file",
        "next instruction",
    ]


async def test_pre_submit_broker_outage_is_retryable_without_unknown_execution(tmp_path):
    h, client = build(tmp_path)
    h._authenticate = AsyncMock(side_effect=OpenAIAccessTokenUnavailable("unavailable"))
    outcome = await h.run_prompt(HarnessPrompt("m", "hello"), AsyncMock())
    assert not outcome.success
    assert "retry" in outcome.error
    assert "Settings" not in outcome.error
    assert not any(call.args[0] == "turn/start" for call in client.request.call_args_list)


async def test_cancellation_without_containment_retains_owner_without_launching_another(tmp_path):
    h, client = build(tmp_path)
    await h.open()
    h.session_id = "thread"
    submitted = asyncio.Event()

    async def request(method, params):
        if method == "turn/start":
            submitted.set()
            await asyncio.Event().wait()
        return {"account": {"type": "apiKey"}}

    client.request.side_effect = request
    client.close.return_value = False
    task = asyncio.create_task(h.run_prompt(HarnessPrompt("m", "work"), AsyncMock()))
    await submitted.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    h.log.error.assert_any_call("codex.turn.cancel_containment_unconfirmed")
    assert h._client is client
    factories = h._factory.call_count
    retry = await h.run_prompt(HarnessPrompt("next", "next instruction"), AsyncMock())
    assert not retry.success
    assert h._factory.call_count == factories


async def test_remaining_prompt_deadline_includes_native_authentication(tmp_path):
    h, client = build(tmp_path)

    async def slow_auth():
        await asyncio.sleep(1)

    h._authenticate = slow_auth
    outcome = await asyncio.wait_for(
        h.run_prompt(HarnessPrompt("m", "must not run", max_duration_seconds=0.01), AsyncMock()),
        0.3,
    )
    assert not outcome.success
    assert not any(call.args[0] == "turn/start" for call in client.request.call_args_list)


async def test_restart_resumes_native_thread_even_with_an_old_unfinished_receipt(tmp_path):
    h, _ = build(tmp_path)
    await h.open()
    h.session_id = "thread"
    h._persist()
    state = json.loads(h._manifest_path.read_text())
    state["receipt"] = {"status": "running", "messageId": "old-prompt"}
    h._manifest_path.write_text(json.dumps(state))
    await h.close()
    resumed, client = build(tmp_path)

    async def request(method, params):
        if method == "thread/resume":
            return {"thread": {"id": "thread"}}
        return {"account": {"type": "apiKey"}}

    client.request.side_effect = request
    await resumed.open()
    assert resumed.session_id == "thread"
    assert not any(call.args[0] == "turn/start" for call in client.request.call_args_list)


async def test_unavailable_history_leaves_creation_to_the_next_prompt(tmp_path):
    h, client = build(tmp_path)
    h.config.state_dir.mkdir()
    h._manifest_path.write_text('{"schemaVersion": "invalid"}')
    await h.open()
    assert h.session_id is None
    assert not h._manifest_path.exists()
    assert not any(call.args[0] == "thread/start" for call in client.request.call_args_list)


async def test_replacement_thread_accounts_first_turn_and_only_later_deltas(tmp_path):
    def usage(turn_id, input_tokens, output_tokens, reasoning_tokens):
        return {
            "method": "thread/tokenUsage/updated",
            "params": {
                "threadId": "replacement-thread",
                "turnId": turn_id,
                "tokenUsage": {
                    "total": {
                        "inputTokens": input_tokens,
                        "cachedInputTokens": 0,
                        "outputTokens": output_tokens,
                        "reasoningOutputTokens": reasoning_tokens,
                        "totalTokens": input_tokens + output_tokens,
                    }
                },
            },
        }

    def completed(turn_id):
        return {
            "method": "turn/completed",
            "params": {
                "threadId": "replacement-thread",
                "turn": {"id": turn_id, "status": "completed"},
            },
        }

    old, _ = build(tmp_path)
    await old.open()
    old.session_id = "old-thread"
    old._total = {
        "inputTokens": 100,
        "cachedInputTokens": 0,
        "cacheWriteInputTokens": 0,
        "outputTokens": 20,
        "reasoningOutputTokens": 5,
        "totalTokens": 120,
    }
    old._persist()
    await old.close()
    state = json.loads(old._manifest_path.read_text())
    state["toolCatalog"] = "incompatible-catalog"
    old._manifest_path.write_text(json.dumps(state))

    harness, client = build(tmp_path)
    turns = iter(("turn-1", "turn-2"))

    async def request(method, params):
        if method == "thread/start":
            return {"thread": {"id": "replacement-thread"}}
        if method == "turn/start":
            return {"turn": {"id": next(turns)}}
        return {"account": {"type": "apiKey"}}

    notifications = iter(
        (
            usage("turn-1", 10, 4, 1),
            completed("turn-1"),
            usage("turn-2", 16, 7, 2),
            completed("turn-2"),
        )
    )

    client.request.side_effect = request
    client.next_notification = AsyncMock(side_effect=lambda: next(notifications))
    events = []

    async def emit(event):
        events.append(event)

    assert (await harness.run_prompt(HarnessPrompt("m1", "first"), emit)).success
    assert (await harness.run_prompt(HarnessPrompt("m2", "second"), emit)).success
    accounted = {event["messageId"]: event["tokens"] for event in events if event.get("tokens")}
    assert accounted == {
        "m1": {
            "input": 10,
            "output": 3,
            "reasoning": 1,
            "cache": {"read": 0, "write": 0},
            "total": 14,
        },
        "m2": {
            "input": 6,
            "output": 2,
            "reasoning": 1,
            "cache": {"read": 0, "write": 0},
            "total": 9,
        },
    }


@pytest.mark.parametrize(
    ("model", "effort", "expected"),
    [
        ("openai/gpt-next-from-catalog", "max", "gpt-next-from-catalog"),
        ("gpt-6.1-sol", "high", "gpt-6.1-sol"),
        (None, None, "gpt-6.1-sol"),
    ],
)
async def test_admitted_selection_is_forwarded_without_runtime_catalog(
    tmp_path, model, effort, expected
):
    harness, client = build(tmp_path)
    await harness.open()
    harness.session_id = "thread"
    client.request.return_value = {"turn": {"id": "turn"}}
    client.next_notification = AsyncMock(
        return_value={
            "method": "turn/completed",
            "params": {"threadId": "thread", "turn": {"id": "turn", "status": "completed"}},
        }
    )
    outcome = await harness.run_prompt(
        HarnessPrompt("message", "hello", model=model, reasoning_effort=effort), AsyncMock()
    )
    assert outcome.success, outcome
    submitted = next(
        call.args[1] for call in client.request.call_args_list if call.args[0] == "turn/start"
    )
    assert submitted["model"] == expected
    assert submitted["effort"] == effort
    await harness.close()


async def test_overlapping_prompts_run_one_native_turn_at_a_time(tmp_path):
    h, client = build(tmp_path)
    await h.open()
    h.session_id = "thread"
    started: list[str] = []
    first_running, release_first = asyncio.Event(), asyncio.Event()

    async def request(method, params):
        if method == "turn/start":
            started.append(params["input"][0]["text"])
            if len(started) == 1:
                first_running.set()
                await release_first.wait()
            raise CodexRpcError("rejected")
        if method == "thread/resume":
            return {"thread": {"id": "thread"}}
        return {"account": {"type": "apiKey"}}

    client.request.side_effect = request
    first = asyncio.create_task(h.run_prompt(HarnessPrompt("a", "first"), AsyncMock()))
    await first_running.wait()
    second = asyncio.create_task(h.run_prompt(HarnessPrompt("b", "second"), AsyncMock()))
    await asyncio.sleep(0.05)
    # The second prompt waits for the first turn, including its cleanup.
    assert started == ["first"]
    assert not second.done()
    release_first.set()
    await first
    await second
    assert started == ["first", "second"]


async def test_resume_requests_thread_metadata_without_history(tmp_path):
    h, client = build(tmp_path)
    await h.open()
    h.session_id = "thread"
    h._persist()
    await h.close()
    resumed, client = build(tmp_path)

    async def request(method, params):
        if method == "thread/resume":
            return {"thread": {"id": "thread"}}
        return {"account": {"type": "apiKey"}}

    client.request.side_effect = request
    await resumed.open()
    params = next(c.args[1] for c in client.request.call_args_list if c.args[0] == "thread/resume")
    assert params["excludeTurns"] is True


async def test_transient_resume_failure_keeps_manifest_and_fails_only_this_attempt(tmp_path):
    h, _ = build(tmp_path)
    await h.open()
    h.session_id = "thread"
    h._persist()
    await h.close()
    saved = h._manifest_path.read_text()
    resumed, client = build(tmp_path)

    async def request(method, params):
        if method == "thread/resume":
            raise CodexTransportError("broken pipe")
        return {"account": {"type": "apiKey"}}

    client.request.side_effect = request
    with pytest.raises(CodexTransportError):
        await resumed.open()
    assert resumed.session_id is None
    assert resumed._manifest_path.read_text() == saved
    assert not any(c.args[0] == "thread/start" for c in client.request.call_args_list)


async def test_transient_bridge_resume_failure_propagates_without_clearing_state(tmp_path):
    h, client = build(tmp_path)
    await h.open()
    h.session_id = "thread"
    h._persist()
    saved = h._manifest_path.read_text()

    async def request(method, params):
        if method == "thread/resume":
            raise CodexTransportError("timed out")
        return {"account": {"type": "apiKey"}}

    client.request.side_effect = request
    with pytest.raises(CodexTransportError):
        await h.resume_session("other-thread")
    assert h.session_id == "thread"
    assert h._manifest_path.read_text() == saved


async def test_unexpected_sink_failure_contains_native_execution(tmp_path):
    h, client = build(tmp_path)
    await h.open()
    h.session_id = "thread"

    async def request(method, params):
        if method == "turn/start":
            return {"turn": {"id": "turn"}}
        return {"account": {"type": "apiKey"}}

    client.request.side_effect = request
    h.stop_execution = AsyncMock(return_value=True)
    emit = AsyncMock(side_effect=RuntimeError("sink failed"))
    with pytest.raises(RuntimeError, match="sink failed"):
        await h.run_prompt(HarnessPrompt("m", "work"), emit)
    h.stop_execution.assert_awaited()
    assert h._turn_id is None


async def test_silent_app_server_fails_the_turn_after_the_inactivity_budget(tmp_path):
    h, client = build(tmp_path)
    h.limits = PromptLimits(0.05, 30, 5)
    await h.open()
    h.session_id = "thread"

    async def request(method, params):
        if method == "turn/start":
            return {"turn": {"id": "turn"}}
        return {"account": {"type": "apiKey"}}

    async def silent():
        await asyncio.Event().wait()

    client.request.side_effect = request
    client.next_notification = silent
    client.handling_requests = False
    h.stop_execution = AsyncMock(return_value=True)
    async with asyncio.timeout(2):
        outcome = await h.run_prompt(HarnessPrompt("m", "work"), AsyncMock())
    assert not outcome.success
    assert "no output" in outcome.error
    h.stop_execution.assert_awaited()


async def test_running_host_callback_renews_inactivity(tmp_path):
    h, client = build(tmp_path)
    h.limits = PromptLimits(0.05, 30, 5)
    await h.open()
    h.session_id = "thread"
    calls = 0

    async def next_notification():
        nonlocal calls
        calls += 1
        if calls < 3:
            await asyncio.Event().wait()
        client.handling_requests = False
        return {"method": "noop", "params": {}}

    client.next_notification = next_notification
    client.handling_requests = True
    assert await h._next_notification() == {"method": "noop", "params": {}}
    assert calls == 3


async def test_usage_baseline_is_durably_distrusted_while_a_turn_runs(tmp_path):
    h, client = build(tmp_path)
    await h.open()
    h.session_id = "thread"
    h._usage_baseline_known = True
    h._persist()
    observed = []

    async def request(method, params):
        if method == "turn/start":
            observed.append(json.loads(h._manifest_path.read_text())["usageBaselineKnown"])
            raise CodexRpcError("rejected")
        return {"account": {"type": "apiKey"}}

    client.request.side_effect = request
    await h.run_prompt(HarnessPrompt("m", "work"), AsyncMock())
    # A hard crash at submission would restore an untrusted baseline.
    assert observed == [False]


async def test_bridge_id_cannot_adopt_a_thread_whose_manifest_was_rejected(tmp_path):
    h, _ = build(tmp_path)
    await h.open()
    h.session_id = "thread"
    h._persist()
    await h.close()
    state = json.loads(h._manifest_path.read_text())
    state["toolCatalog"] = "catalog-before-slack-tools"
    h._manifest_path.write_text(json.dumps(state))
    resumed, client = build(tmp_path)

    async def request(method, params):
        if method == "thread/resume":
            return {"thread": {"id": "thread"}}
        return {"account": {"type": "apiKey"}}

    client.request.side_effect = request
    await resumed.open()
    assert resumed.session_id is None
    assert not await resumed.resume_session("thread")
    assert resumed.session_id is None
    assert not resumed._manifest_path.exists()


async def test_rejected_manifest_blocks_adoption_across_a_restart(tmp_path):
    h, _ = build(tmp_path)
    await h.open()
    h.session_id = "thread"
    h._persist()
    await h.close()
    state = json.loads(h._manifest_path.read_text())
    state["toolCatalog"] = "catalog-before-slack-tools"
    h._manifest_path.write_text(json.dumps(state))

    async def request(method, params):
        if method == "thread/resume":
            return {"thread": {"id": "thread"}}
        if method == "thread/start":
            return {"thread": {"id": "fresh"}}
        return {"account": {"type": "apiKey"}}

    first, client = build(tmp_path)
    client.request.side_effect = request
    await first.open()
    assert not await first.resume_session("thread")
    await first.close()
    # The bridge restarts before any prompt creates a new thread.
    restarted, client = build(tmp_path)
    client.request.side_effect = request
    await restarted.open()
    assert not await restarted.resume_session("thread")
    assert not any(c.args[0] == "thread/resume" for c in client.request.call_args_list)
    # Creating a fresh thread replaces the rejected record.
    await restarted.create_session()
    assert restarted.session_id == "fresh"
    assert not restarted._rejected_manifest_path.exists()


async def test_partially_written_attachment_is_removed(tmp_path, monkeypatch):
    h, _ = build(tmp_path)
    await h.open()
    h.session_id = "thread"

    def partial_write(self, data):
        with open(self, "wb") as output:
            output.write(data[:1])
        raise OSError("disk full")

    monkeypatch.setattr("pathlib.Path.write_bytes", partial_write)
    prompt = HarnessPrompt(
        "m", "look", attachments=({"content": base64.b64encode(b"image").decode()},)
    )
    outcome = await h.run_prompt(prompt, AsyncMock())
    assert not outcome.success
    assert list((h.config.state_dir / "openinspect-input").iterdir()) == []


async def test_generation_reauthentication_waits_for_the_stopped_turn_to_unwind(tmp_path):
    h, client = build(tmp_path)
    await h.open()
    h.session_id = "thread"
    unwinding, release = asyncio.Event(), asyncio.Event()

    async def request(method, params):
        if method == "turn/start":
            return {"turn": {"id": "turn"}}
        return {"account": {"type": "apiKey"}}

    async def next_notification():
        await asyncio.Event().wait()

    client.request.side_effect = request
    client.next_notification = next_notification
    client.handling_requests = False
    stop = h.stop_execution

    async def slow_cleanup_stop(timeout):
        if not unwinding.is_set():
            unwinding.set()
            await release.wait()
        return await stop(timeout)

    turn = asyncio.create_task(h.run_prompt(HarnessPrompt("m", "work"), AsyncMock()))
    await asyncio.sleep(0.05)
    h.stop_execution = slow_cleanup_stop
    turn.cancel()
    await unwinding.wait()
    opens = h._factory.call_count
    reauth = asyncio.create_task(h.reauthenticate_generation({"sandboxId": "s", "createdAt": 2}))
    await asyncio.sleep(0.05)
    # The old turn still holds the lock in its cleanup: no new client yet.
    assert h._factory.call_count == opens
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await turn
    await reauth
    assert h._factory.call_count == opens + 1


@pytest.mark.parametrize(
    ("status", "error", "expected", "cancelled"),
    [
        ("failed", {"message": "boom", "codexErrorInfo": "unauthorized"}, "OPENAI_API_KEY", False),
        ("failed", {"message": "stream broke"}, "stream broke", False),
        ("failed", None, "Codex turn failed", False),
        ("interrupted", {"message": "stopped"}, "Codex turn interrupted", True),
    ],
)
async def test_terminal_outcome_carries_native_failure_detail(
    tmp_path, status, error, expected, cancelled
):
    harness, client = build(tmp_path)
    await harness.open()
    harness.session_id = "thread"
    client.request.return_value = {"turn": {"id": "turn"}}
    client.next_notification = AsyncMock(
        return_value={
            "method": "turn/completed",
            "params": {
                "threadId": "thread",
                "turn": {"id": "turn", "status": status, "error": error},
            },
        }
    )
    emit = AsyncMock()
    outcome = await harness.run_prompt(HarnessPrompt("message", "hello"), emit)
    assert not outcome.success
    assert outcome.cancelled is cancelled
    assert expected in outcome.error
    errors = [call.args[0] for call in emit.await_args_list if call.args[0]["type"] == "error"]
    assert errors == (
        [] if cancelled else [{"type": "error", "error": outcome.error, "messageId": "message"}]
    )


FATAL_ERROR_FRAME = {
    "method": "error",
    "params": {
        "threadId": "thread",
        "turnId": "turn",
        "willRetry": False,
        "error": {"message": "quota", "codexErrorInfo": "usageLimitExceeded"},
    },
}


@pytest.mark.parametrize(
    ("ending", "fallback"),
    [("transport", "Codex transport failed"), ("inactivity", "no output")],
)
@pytest.mark.parametrize("fatal", [True, False])
async def test_turn_ending_without_completion_keeps_recorded_native_error(
    tmp_path, ending, fallback, fatal
):
    h, client = build(tmp_path)
    h.limits = PromptLimits(0.05, 30, 5)
    await h.open()
    h.session_id = "thread"

    async def request(method, params):
        if method == "turn/start":
            return {"turn": {"id": "turn"}}
        return {"account": {"type": "apiKey"}}

    frames = [FATAL_ERROR_FRAME] if fatal else []

    async def notifications():
        if frames:
            return frames.pop()
        if ending == "transport":
            raise CodexTransportError("broken pipe")
        await asyncio.Event().wait()

    client.request.side_effect = request
    client.next_notification = notifications
    client.handling_requests = False
    h.stop_execution = AsyncMock(return_value=True)
    emit = AsyncMock()
    async with asyncio.timeout(2):
        outcome = await h.run_prompt(HarnessPrompt("m", "work"), emit)
    assert not outcome.success
    errors = [call.args[0] for call in emit.await_args_list if call.args[0]["type"] == "error"]
    if fatal:
        assert outcome.error == "OpenAI usage limit reached; retry after it resets."
        assert errors == [{"type": "error", "error": outcome.error, "messageId": "m"}]
    else:
        assert fallback in outcome.error
        assert errors == []

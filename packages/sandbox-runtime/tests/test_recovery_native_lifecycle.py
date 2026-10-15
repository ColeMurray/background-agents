"""Recovery decisions follow native lifecycle and submission acknowledgements."""

import asyncio
from dataclasses import replace
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.harness.codex.client import CodexRpcError, CodexTransportError
from tests.claude_fakes import Harness as ClaudeTestHarness
from tests.claude_fakes import _result, _stream, _text_delta
from tests.conftest import MockResponse, wire_opencode_transport
from tests.test_bridge_conversation_recovery import command
from tests.test_bridge_sse import DroppingMockSSEResponse, MockHttpClient, MockSSEResponse
from tests.test_codex_lifecycle import build


def configure_bridge(tmp_path, harness=None):
    bridge = AgentBridge(
        sandbox_id="replacement",
        session_id="session",
        control_plane_url="https://control.invalid",
        auth_token="test",
        harness=harness,
    )
    bridge.log = MagicMock()
    bridge._configure_git_identity = AsyncMock()
    bridge._send_event = AsyncMock(return_value=True)
    bridge.session_id_file = tmp_path / "agent-session-id"
    bridge.legacy_session_id_file = tmp_path / "opencode-session-id"
    return bridge


class NativeHttp(MockHttpClient):
    def __init__(self, failure):
        super().__init__()
        self.failure = failure
        self.texts = []
        self.streams = 0

    async def post(self, url, json=None, **kwargs):
        if url.endswith("/session"):
            if self.failure == "slow_creation":
                await asyncio.sleep(0.1)
            return MockResponse(200, {"id": "native"})
        if url.endswith("/prompt_async"):
            self.texts.append(json["parts"][0]["text"])
            if self.failure == "unknown" and len(self.texts) == 1:
                raise httpx.ReadTimeout("submission response lost")
            if self.failure == "rejected" and len(self.texts) == 1:
                return MockResponse(401, text="unauthorized")
        return MockResponse(204)

    def stream(self, *args, **kwargs):
        self.streams += 1
        if self.failure == "connect" and self.streams == 1:
            raise httpx.ConnectError("event connection failed")
        if self.failure == "after_acceptance" and self.streams == 1:
            return DroppingMockSSEResponse([])
        return MockSSEResponse([])


@pytest.mark.parametrize("failure", ["connect", "rejected"])
async def test_known_pre_submission_failure_retries_with_context(tmp_path, failure):
    bridge = configure_bridge(tmp_path)
    http = NativeHttp(failure)
    wire_opencode_transport(bridge, http)
    await bridge._handle_prompt(command())
    await bridge._handle_prompt({**command(), "messageId": "retry"})
    assert "Use approach X; do not use Y." in http.texts[-1]


async def test_native_acceptance_prevents_replay_after_later_stream_failure(tmp_path):
    bridge = configure_bridge(tmp_path)
    http = NativeHttp("after_acceptance")
    wire_opencode_transport(bridge, http)
    await bridge._handle_prompt(command())
    await bridge._handle_prompt({**command(), "messageId": "retry"})
    assert "Use approach X; do not use Y." in http.texts[0]
    assert http.texts[1] == command()["content"]


@pytest.mark.parametrize("restart_bridge", [False, True])
async def test_ambiguous_submission_does_not_blindly_replay_recovery(tmp_path, restart_bridge):
    bridge = configure_bridge(tmp_path)
    http = NativeHttp("unknown")
    wire_opencode_transport(bridge, http)
    await bridge._handle_prompt(command())
    if restart_bridge:
        bridge = configure_bridge(tmp_path)
        wire_opencode_transport(bridge, http)
        await bridge._load_session_id()
    result = await bridge._handle_prompt({**command(), "messageId": "retry"})
    assert len(http.texts) == 1
    assert "uncertain" in result["error"].lower()


@pytest.mark.parametrize("slow_stage", ["warning", "slow_creation"])
async def test_native_preparation_spends_the_original_prompt_budget(tmp_path, slow_stage):
    bridge = configure_bridge(tmp_path)
    http = NativeHttp(slow_stage)
    wire_opencode_transport(bridge, http)
    bridge.prompt_limits = replace(bridge.prompt_limits, prompt_max_duration_seconds=0.01)

    async def slow_warning(event):
        if event["type"] == "warning":
            await asyncio.sleep(0.1)
        return True

    bridge._send_event = AsyncMock(side_effect=slow_warning)
    start = asyncio.get_running_loop().time()
    result = await bridge._handle_prompt(command())
    elapsed = asyncio.get_running_loop().time() - start
    assert result["success"] is False
    assert elapsed < 0.06
    assert not http.texts


@pytest.mark.parametrize("failure", [RuntimeError("warning failed"), asyncio.CancelledError()])
async def test_warning_failure_is_known_to_precede_native_submission(tmp_path, failure):
    bridge = configure_bridge(tmp_path)
    http = NativeHttp(None)
    wire_opencode_transport(bridge, http)
    bridge._send_event = AsyncMock(side_effect=failure)
    assert not (await bridge._handle_prompt(command()))["success"]
    assert not http.texts
    bridge._send_event = AsyncMock(return_value=True)
    await bridge._handle_prompt({**command(), "messageId": "retry"})
    assert "Use approach X; do not use Y." in http.texts[0]


async def test_claude_native_activity_commits_recovery_before_the_next_turn(tmp_path):
    sdk = ClaudeTestHarness(
        tmp_path,
        turns=[
            [_stream("message_start", message={"id": "first"}), _text_delta("Done."), _result(0.1)],
            [_stream("message_start", message={"id": "next"}), _text_delta("Next."), _result(0.2)],
        ],
    )
    await sdk.harness.open()
    bridge = configure_bridge(tmp_path, sdk.harness)
    assert (await bridge._handle_prompt(command()))["success"]
    assert (await bridge._handle_prompt({**command(), "messageId": "next"}))["success"]
    texts = [query[0]["message"]["content"][0]["text"] for query in sdk.client.queries]
    assert "Use approach X; do not use Y." in texts[0]
    assert texts[1] == command()["content"]
    await sdk.harness.close()


async def test_claude_success_outcome_alone_does_not_prove_native_input_acceptance(tmp_path):
    sdk = ClaudeTestHarness(tmp_path, turns=[[_result(0.1)]])
    await sdk.harness.open()
    bridge = configure_bridge(tmp_path, sdk.harness)
    await bridge._handle_prompt(command())
    result = await bridge._handle_prompt({**command(), "messageId": "next"})
    assert "uncertain" in result["error"].lower()
    assert len(sdk.client.queries) == 1
    await sdk.harness.close()


@pytest.mark.parametrize("reject_resume", [False, True])
@pytest.mark.parametrize("missing_bridge_pointer", [False, True])
async def test_codex_reopen_uses_actual_native_history_disposition(
    tmp_path, reject_resume, missing_bridge_pointer
):
    harness, client = build(tmp_path)
    bridge = configure_bridge(tmp_path, harness)
    submissions = []
    current_thread = "old"
    current_turn = ""
    starts = 0

    async def request(method, params):
        nonlocal current_thread, current_turn, starts
        if method == "thread/start":
            return {"thread": {"id": current_thread}}
        if method == "thread/resume":
            if reject_resume:
                current_thread = "new"
                raise CodexRpcError({"code": -32000, "message": "thread not found"})
            return {"thread": {"id": current_thread}}
        if method == "turn/start":
            starts += 1
            if starts == 2:
                raise CodexTransportError("connection lost")
            submissions.append(params["input"][0]["text"])
            current_turn = f"turn-{starts}"
            return {"turn": {"id": current_turn}}
        return {"account": {"type": "apiKey"}}

    async def notification():
        return {
            "method": "turn/completed",
            "params": {
                "threadId": current_thread,
                "turn": {"id": current_turn, "status": "completed"},
            },
        }

    client.request.side_effect = request
    client.next_notification = AsyncMock(side_effect=notification)
    assert (await bridge._handle_prompt(command()))["success"]
    assert not (await bridge._handle_prompt({**command(), "messageId": "lost"}))["success"]
    assert harness._client is None
    if missing_bridge_pointer:
        bridge.session_id_file.unlink()
    result = await bridge._handle_prompt(
        {**command(), "messageId": "reopened", "content": "Continue."}
    )
    assert result["success"], result
    if reject_resume:
        assert "Use approach X; do not use Y." in submissions[-1]
    else:
        assert submissions[-1] == "Continue."
    await harness.close()

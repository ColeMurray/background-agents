"""Unit tests for handing a message to the running turn."""

import asyncio
from typing import Any

import pytest

from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.harness import HarnessPrompt


class SteerableHarness:
    def __init__(self, accept: bool, fail: bool = False) -> None:
        self.accept = accept
        self.fail = fail
        self.prompts: list[HarnessPrompt] = []

    async def steer(self, prompt: HarnessPrompt) -> bool:
        self.prompts.append(prompt)
        if self.fail:
            raise RuntimeError("transport closed")
        return self.accept


@pytest.fixture
def bridge() -> AgentBridge:
    return AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )


@pytest.fixture
def sent(bridge: AgentBridge) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []

    async def capture(event: dict[str, Any]) -> bool:
        events.append(event)
        return True

    bridge._send_event = capture  # type: ignore[method-assign]
    return events


def _running(bridge: AgentBridge) -> asyncio.Task[None]:
    task = asyncio.create_task(asyncio.Event().wait())
    bridge.activity.track_prompt("m1", task)
    return task


STEER = {"type": "steer", "messageId": "m2", "content": "and this too"}


class TestHandleSteer:
    @pytest.mark.asyncio
    async def test_a_running_turn_takes_the_message(
        self, bridge: AgentBridge, sent: list[dict[str, Any]]
    ) -> None:
        harness = SteerableHarness(accept=True)
        bridge.boot_attach.harness = harness  # type: ignore[assignment]
        task = _running(bridge)

        await bridge._handle_command(STEER)

        assert sent == [{"type": "steer_result", "messageId": "m2", "accepted": True}]
        assert [(p.message_id, p.text) for p in harness.prompts] == [("m2", "and this too")]
        task.cancel()

    @pytest.mark.asyncio
    async def test_the_message_is_refused_when_the_harness_turns_it_down(
        self, bridge: AgentBridge, sent: list[dict[str, Any]]
    ) -> None:
        bridge.boot_attach.harness = SteerableHarness(accept=False)  # type: ignore[assignment]
        task = _running(bridge)

        await bridge._handle_command(STEER)

        assert sent == [{"type": "steer_result", "messageId": "m2", "accepted": False}]
        task.cancel()

    @pytest.mark.asyncio
    async def test_a_steer_that_fails_is_reported_as_refused(
        self, bridge: AgentBridge, sent: list[dict[str, Any]]
    ) -> None:
        bridge.boot_attach.harness = SteerableHarness(accept=True, fail=True)  # type: ignore[assignment]
        task = _running(bridge)

        await bridge._handle_command(STEER)

        assert sent == [{"type": "steer_result", "messageId": "m2", "accepted": False}]
        task.cancel()

    @pytest.mark.asyncio
    async def test_the_message_is_refused_without_a_running_turn_or_with_attachments(
        self, bridge: AgentBridge, sent: list[dict[str, Any]]
    ) -> None:
        harness = SteerableHarness(accept=True)
        bridge.boot_attach.harness = harness  # type: ignore[assignment]

        await bridge._handle_command(STEER)
        task = _running(bridge)
        await bridge._handle_command({**STEER, "attachments": [{"id": "a1"}]})

        assert [e["accepted"] for e in sent] == [False, False]
        assert harness.prompts == []
        task.cancel()

    @pytest.mark.asyncio
    async def test_a_harness_that_cannot_steer_refuses(
        self, bridge: AgentBridge, sent: list[dict[str, Any]]
    ) -> None:
        task = _running(bridge)

        await bridge._handle_command(STEER)

        assert sent == [{"type": "steer_result", "messageId": "m2", "accepted": False}]
        task.cancel()

"""Opt-in released-binary checks of Codex sub-agents. Synthetic auth; loopback Responses only.

Run with OI_TEST_CODEX_BINARY pointing to the pinned executable.
"""

import json
import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.harness.base import HarnessPrompt, PromptLimits
from sandbox_runtime.harness.codex import CodexHarness, CodexHarnessConfig
from sandbox_runtime.model_prices import ModelPriceCatalog

CATALOG = Path(__file__).parents[1] / "fixtures/reasoning-models.json"

pytestmark = pytest.mark.skipif(
    not os.environ.get("OI_TEST_CODEX_BINARY"),
    reason="Set OI_TEST_CODEX_BINARY for pinned native integration",
)


async def test_native_subagent_is_a_task_with_nested_tools_and_usage(
    tmp_path, responses, native_factory
):
    import httpx

    from sandbox_runtime.harness.tools import ToolServerConfig

    _, requests, scripted = responses
    tools = ToolServerConfig(
        "http://fixture.invalid", "session", "sandbox-auth", tmp_path / "repos.json", False, False
    )

    def call(call_id, namespace, name, arguments):
        return {
            "type": "function_call",
            "call_id": call_id,
            "namespace": namespace,
            "name": name,
            "arguments": json.dumps(arguments),
        }

    scripted.extend(
        [
            call("spawn", "collaboration", "spawn_agent", {"task_name": "check", "message": "Go."}),
            # The sub-agent calls an OpenInspect tool from its own thread, then answers.
            {"subagent": call("child-tool", "oi", "get-child-status", {})},
            call("wait", "collaboration", "wait_agent", {"timeout_ms": 30000}),
        ]
    )
    harness = CodexHarness(
        config=CodexHarnessConfig(tmp_path, tmp_path / "state", "gpt-6.1-sol", False, tools=tools),
        log=MagicMock(),
        limits=PromptLimits(1, 60, 30),
        client_factory=native_factory,
        environ={"OPENAI_API_KEY": "synthetic"},
        prices=ModelPriceCatalog(CATALOG, MagicMock()),
    )
    harness._tool_client.request = AsyncMock(
        return_value=httpx.Response(200, json={"children": []})
    )
    events = []

    async def emit(event):
        events.append(event)

    try:
        result = await harness.run_prompt(HarnessPrompt("m", "Use a sub-agent."), emit)
    finally:
        await harness.close()
    assert result.success, result
    harness._tool_client.request.assert_awaited_once_with("GET", "/children")
    assert sum(request["subagent"] for request in requests) == 2

    [task] = [e for e in events if e.get("tool") == "task" and e["status"] == "completed"]
    assert task["args"] == {"description": "check", "task_id": "/root/check"}
    child_answer = next(r for r in reversed(requests) if r["subagent"])
    assert task["output"] == f"answer {requests.index(child_answer) + 1}"
    nested = [e for e in events if e.get("taskCallId") == task["callId"]]
    assert all(e["isSubtask"] and e["childSessionId"] == task["childSessionId"] for e in nested)
    [tool] = [e for e in nested if e["type"] == "tool_call" and e["status"] == "completed"]
    assert tool["tool"] == "get-child-status"
    assert "No child sessions found." in tool["output"]
    # Two sub-agent model calls of 120 tokens each, reported apart from the parent's.
    # Each request is 100 input at $2/M, 15 output and 5 reasoning at $10/M.
    child_step = [e for e in nested if e["type"] == "step_finish"][-1]
    assert child_step["tokens"]["total"] == 240
    assert child_step["cost"] == 0.0008
    parent_step = events[-1]
    assert parent_step["type"] == "step_finish" and "isSubtask" not in parent_step
    assert parent_step["tokens"]["total"] == 360
    assert parent_step["cost"] == 0.0012
    # The prompt's cost includes its sub-agent's.
    assert parent_step["messageCostUsd"] == result.message_cost_usd == 0.002
    assert not [e for e in events if e["type"] == "warning"]

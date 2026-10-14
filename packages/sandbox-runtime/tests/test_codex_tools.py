"""Native dynamic tools use the existing session-scoped tool implementation."""

from unittest.mock import MagicMock

import httpx

from sandbox_runtime.harness.claude_tools import ControlPlaneToolClient, ToolServerConfig
from sandbox_runtime.harness.codex.tools import CodexTools


async def test_native_tool_uses_existing_authenticated_handler(tmp_path):
    requests = []

    def handle(request):
        requests.append(request)
        return httpx.Response(200, json={"children": []})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
        client = ControlPlaneToolClient(
            ToolServerConfig(
                "https://cp.example", "session", "fixture", tmp_path / "repos.json", True, False
            ),
            MagicMock(),
            http,
        )
        tools = CodexTools(client)
        names = {tool["name"] for tool in tools.specs()[0]["tools"]}
        assert {"get-child-status", "spawn-child", "memory_search"} <= names
        result = await tools.call({"namespace": "oi", "tool": "get-child-status", "arguments": {}})
        assert result["success"]
        assert result["contentItems"][0]["type"] == "inputText"
        assert len(requests) == 1
        assert str(requests[0].url) == "https://cp.example/sessions/session/children"
        assert requests[0].headers["Authorization"] == "Bearer fixture"

        # Invalid native arguments are rejected before the handler makes a request.
        result = await tools.call({"namespace": "oi", "tool": "spawn-child", "arguments": {}})
        assert not result["success"]
        assert len(requests) == 1


async def test_handler_error_results_are_reported_as_native_failures(tmp_path):
    def handle(request):
        return httpx.Response(403, json={"error": "forbidden"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
        client = ControlPlaneToolClient(
            ToolServerConfig(
                "https://cp.example", "session", "fixture", tmp_path / "repos.json", True, False
            ),
            MagicMock(),
            http,
        )
        result = await CodexTools(client).call(
            {"namespace": "oi", "tool": "memory_search", "arguments": {"query": "deploy"}}
        )
        assert not result["success"]
        assert "403" in result["contentItems"][0]["text"]

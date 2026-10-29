"""Native dynamic tools adapt the vendor-neutral registry and results."""

import builtins
import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock

import httpx
import pytest

from sandbox_runtime.harness.codex.tools import CodexTools
from sandbox_runtime.harness.tools import ControlPlaneToolClient, ToolServerConfig, build_tools


def test_tool_imports_do_not_load_vendor_sdks():
    probe = (
        "import sys;"
        "sys.path.insert(0, sys.argv[1]);"
        "import sandbox_runtime.harness.codex.tools;"
        "import sandbox_runtime.harness.tools;"
        "bad = [name for name in sys.modules "
        "if name.split('.')[0] in {'claude_agent_sdk', 'mcp'}];"
        "assert not bad, bad"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe, str(Path(__file__).resolve().parents[1] / "src")],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr


async def test_native_tool_uses_existing_authenticated_handler(tmp_path, monkeypatch):
    import_module = builtins.__import__

    def no_vendor_imports(name, *args, **kwargs):
        assert not name.startswith(("claude_agent_sdk", "mcp"))
        return import_module(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_vendor_imports)
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
        assert tools.specs()[0]["tools"] == [
            {
                "type": "function",
                "name": tool.name,
                "description": tool.description,
                "inputSchema": tool.input_schema,
            }
            for tool in build_tools(client)
        ]
        names = {tool["name"] for tool in tools.specs()[0]["tools"]}
        assert {"get-child-status", "spawn-child", "memory_search"} <= names
        result = await tools.call({"namespace": "oi", "tool": "get-child-status", "arguments": {}})
        assert result["success"] is True
        assert result["contentItems"][0]["type"] == "inputText"
        assert json.loads(result["contentItems"][0]["text"]) == {
            "version": 1,
            "kind": "list",
            "children": [],
            "agentMessage": "No child sessions found.",
        }
        assert len(requests) == 1
        assert str(requests[0].url) == "https://cp.example/sessions/session/children"
        assert requests[0].headers["Authorization"] == "Bearer fixture"

        # Invalid native arguments are rejected before the handler makes a request.
        result = await tools.call({"namespace": "oi", "tool": "spawn-child", "arguments": {}})
        assert not result["success"]
        assert len(requests) == 1


@pytest.mark.parametrize("unavailable", [False, True])
async def test_handler_error_results_are_reported_as_native_failures(tmp_path, unavailable):
    def handle(request):
        if unavailable:
            raise httpx.ConnectError("unavailable", request=request)
        return httpx.Response(403, json={"error": "forbidden"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
        client = ControlPlaneToolClient(
            ToolServerConfig(
                "https://cp.example", "session", "fixture", tmp_path / "repos.json", True, False
            ),
            MagicMock(),
            http,
        )
        tools = CodexTools(client)
        for name, args in [("memory_search", {"query": "deploy"}), ("get-child-status", {})]:
            result = await tools.call({"namespace": "oi", "tool": name, "arguments": args})
            assert result["success"] is False
            assert result["contentItems"][0]["type"] == "inputText"
            assert ("unavailable" if unavailable else "403") in result["contentItems"][0]["text"]

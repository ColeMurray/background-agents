"""Claude decorates shared tools and maps their results to native MCP responses."""

import json
from unittest.mock import MagicMock

import anyio
import httpx
import pytest
from mcp import ClientSession
from mcp.shared.memory import create_client_server_memory_streams

from sandbox_runtime.harness.claude_tools import build_tool_server
from sandbox_runtime.harness.tools import ControlPlaneToolClient, ToolServerConfig, build_tools


@pytest.mark.parametrize("has_repository,slack_enabled", [(False, False), (True, True)])
@pytest.mark.parametrize("status", [200, 403, None])
async def test_sdk_server_preserves_specs_and_maps_native_results(
    tmp_path, has_repository, slack_enabled, status
):
    def handle(request):
        if status is None:
            raise httpx.ConnectError("unavailable", request=request)
        return httpx.Response(status, json={"children": [], "error": "forbidden"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
        client = ControlPlaneToolClient(
            ToolServerConfig(
                "https://cp.example",
                "session",
                "fixture",
                tmp_path / "repos.json",
                has_repository,
                slack_enabled,
            ),
            MagicMock(),
            http,
        )
        config = build_tool_server(client)
        assert config["type"] == "sdk" and config["name"] == "oi"
        server = config["instance"]
        async with (
            create_client_server_memory_streams() as (client_streams, server_streams),
            anyio.create_task_group() as tasks,
        ):
            tasks.start_soon(server.run, *server_streams, server.create_initialization_options())
            async with ClientSession(*client_streams) as session:
                await session.initialize()
                registered = await session.list_tools()
                assert [
                    (tool.name, tool.description, tool.input_schema) for tool in registered.tools
                ] == [
                    (tool.name, tool.description, tool.input_schema) for tool in build_tools(client)
                ]
                # Exercise different bound handlers through the SDK's actual MCP conversion.
                for name, args in [
                    ("memory_search", {"query": "deploy"}),
                    ("get-child-status", {}),
                ]:
                    result = await session.call_tool(name, args)
                    wire_result = result.model_dump(by_alias=True, mode="json")
                    assert wire_result["isError"] is (status != 200)
                    assert wire_result["content"][0]["type"] == "text"
                    text = wire_result["content"][0]["text"]
                    if status == 200:
                        if name == "memory_search":
                            assert text == '{"children":[],"error":"forbidden"}'
                        else:
                            assert json.loads(text) == {
                                "version": 1,
                                "kind": "list",
                                "children": [],
                                "agentMessage": "No child sessions found.",
                            }
                    else:
                        assert ("unavailable" if status is None else "403") in text
            tasks.cancel_scope.cancel()

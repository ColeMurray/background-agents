"""Adapt the shared sandbox tools to an in-process Claude SDK MCP server."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from .tools import OI_TOOL_SERVER_NAME, build_tools

if TYPE_CHECKING:
    from claude_agent_sdk import McpSdkServerConfig, SdkMcpTool

    from .tools import ControlPlaneToolClient, ToolDefinition


def _sdk_tool(definition: ToolDefinition) -> SdkMcpTool[dict[str, Any]]:
    async def handler(args: dict[str, Any]) -> dict[str, Any]:
        result = await definition.handler(args)
        # The SDK maps its handler convention onto MCP's native ``isError``.
        return {
            "content": [{"type": "text", "text": result.text}],
            "is_error": result.is_error,
        }

    return tool(definition.name, definition.description, definition.input_schema)(handler)


def build_tool_server(client: ControlPlaneToolClient) -> McpSdkServerConfig:
    """The SDK MCP server config for ``ClaudeAgentOptions.mcp_servers["oi"]``."""
    return create_sdk_mcp_server(
        name=OI_TOOL_SERVER_NAME,
        version="1.0.0",
        tools=[_sdk_tool(definition) for definition in build_tools(client)],
    )

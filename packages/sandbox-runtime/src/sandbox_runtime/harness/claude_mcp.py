"""Claude MCP configuration and readiness; the harness owns the SDK process."""

from __future__ import annotations

import asyncio
import contextlib
import json
from typing import TYPE_CHECKING, Any, Final, Protocol

from ..managed_mcp import managed_marker, personal_names
from .claude_env import CLAUDE_POLICY_SETTINGS

if TYPE_CHECKING:
    from collections.abc import Mapping

    from claude_agent_sdk import McpStatusResponse

    from .base import EventSink, HarnessPrompt

MANAGED_MCP_STATUS_TIMEOUT_SECONDS: Final = 30.0


class McpStatusClient(Protocol):
    async def get_mcp_status(self) -> McpStatusResponse: ...

    async def toggle_mcp_server(self, server_name: str, enabled: bool) -> None: ...


def mcp_server_options(
    servers: tuple[Mapping[str, Any], ...], allowed_personal: set[str] | None = None
) -> dict[str, Any]:
    """Session MCP servers in the SDK's config shape."""
    config: dict[str, Any] = {}
    for server in servers:
        name = server.get("name")
        if not name or server.get("enabled") is False:
            continue
        marker = managed_marker(server)
        if (
            marker
            and marker["auth_mode"] == "user_oauth"
            and name not in (allowed_personal or set())
        ):
            continue
        if server.get("type") == "remote":
            entry: dict[str, Any] = {"type": "http", "url": server.get("url", "")}
            headers = (
                (server.get("headers") or {})
                if marker
                else (server.get("headers") or server.get("env") or {})
            )
            if headers:
                entry["headers"] = dict(headers)
        else:
            command = list(server.get("command") or [])
            if not command:
                continue
            entry = {"type": "stdio", "command": command[0], "args": command[1:]}
            if server.get("env"):
                entry["env"] = dict(server["env"])
        config[str(name)] = entry
    return config


def mcp_policy_settings(servers: tuple[Mapping[str, Any], ...], allowed_personal: set[str]) -> str:
    """Reserve unavailable managed names without disabling unrelated native MCPs."""
    denied = sorted(set(personal_names(servers)) - allowed_personal)
    if not denied:
        return CLAUDE_POLICY_SETTINGS
    return json.dumps(
        {
            **json.loads(CLAUDE_POLICY_SETTINGS),
            "deniedMcpServers": [{"serverName": name} for name in denied],
        },
        separators=(",", ":"),
    )


async def check_managed_mcp(
    client: McpStatusClient, allowed: set[str], prompt: HarnessPrompt, emit: EventSink
) -> None:
    if not allowed:
        return
    deadline = asyncio.get_running_loop().time() + MANAGED_MCP_STATUS_TIMEOUT_SECONDS
    # Claude persists a disable in its config directory, which outlives this
    # process; without this, one failed turn would keep the server off for good.
    status = await client.get_mcp_status()
    for server in status.get("mcpServers", []):
        if server["name"] in allowed and server.get("status") == "disabled":
            # Enabling dials the server and raises if it cannot connect; the
            # readiness check below reports that like any other failure.
            with contextlib.suppress(Exception):
                await client.toggle_mcp_server(server["name"], True)
    while True:
        status = await client.get_mcp_status()
        states = {server["name"]: server.get("status") for server in status.get("mcpServers", [])}
        pending = any(states.get(name) in {None, "pending", "connecting"} for name in allowed)
        if not pending or asyncio.get_running_loop().time() >= deadline:
            break
        await asyncio.sleep(0.1)
    for name in allowed:
        if states.get(name) != "connected":
            await client.toggle_mcp_server(name, False)
            await emit(
                {
                    "type": "warning",
                    "scope": "mcp",
                    "messageId": prompt.message_id,
                    "message": f"Personal MCP {name} could not connect. Reconnect in Settings. Other tools remain available.",
                }
            )

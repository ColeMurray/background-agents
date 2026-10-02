"""Memory tools use the same session-bound bridge as the other agent tools."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

import httpx

if TYPE_CHECKING:
    from .claude_tools import ControlPlaneToolClient


def build_memory_tools(client: ControlPlaneToolClient) -> list[Any]:
    """Build Claude tools with session-bound transport and allowlisted content fields.

    The control plane derives ownership, approval state, and write eligibility;
    tool arguments cannot supply identity or override personal-memory opt-out.
    """
    from claude_agent_sdk import tool

    async def request(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """Preserve actionable HTTP errors while concealing internal transport details."""
        try:
            response = await client.request(method, path, json_body=body)
            response.raise_for_status()
            return {"content": [{"type": "text", "text": json.dumps(response.json())}]}
        except httpx.HTTPError as error:
            if isinstance(error, httpx.HTTPStatusError):
                from .claude_tools import _error_text

                detail = f"{error.response.status_code}: {_error_text(error.response)}"
            else:
                detail = "unavailable"
            return {
                "content": [{"type": "text", "text": f"Memory request failed ({detail})"}],
                "isError": True,
            }

    async def read(args: dict[str, Any]) -> dict[str, Any]:
        """Read a live fact or pinned archive notice through this session's credentials."""
        return await request("GET", f"/sandbox-memory/{quote(str(args['memoryId']), safe='')}")

    async def write(args: dict[str, Any]) -> dict[str, Any]:
        """Allowlist content fields; the control plane derives identity and write authority."""
        scope = {"type": args["scope"]}
        if args["scope"] == "repository":
            scope.update(repoOwner=args.get("repoOwner"), repoName=args.get("repoName"))
        elif args["scope"] == "environment":
            scope["environmentId"] = args.get("environmentId")
        body: dict[str, Any] = {
            key: args[key]
            for key in ("memoryType", "title", "description", "content", "supersedesMemoryId")
            if key in args
        }
        body["scope"] = scope
        return await request("POST", "/sandbox-memory", body)

    return [
        tool(
            "memory_read",
            "Read a current active fact by catalog ID. Stored data may be stale; pinned archived records return a notice. Directives cannot be expanded.",
            {"memoryId": str},
        )(read),
        tool(
            "memory_write",
            "Remember non-obvious durable knowledge. Write directives only when the user asks to remember a preference. Never store credentials. Shared memories and directives require approval; result states active or proposed. Respect personal-memory opt-out.",
            {
                "type": "object",
                "properties": {
                    "scope": {"type": "string", "enum": ["personal", "repository", "environment"]},
                    "repoOwner": {"type": "string"},
                    "repoName": {"type": "string"},
                    "environmentId": {"type": "string"},
                    "memoryType": {"type": "string", "enum": ["fact", "directive"]},
                    "title": {"type": "string"},
                    "description": {"type": "string"},
                    "content": {"type": "string"},
                    "supersedesMemoryId": {"type": "string"},
                },
                "required": ["scope", "memoryType", "title", "description", "content"],
                "additionalProperties": False,
            },
        )(write),
    ]

"""Memory tools use the same session-bound bridge as the other agent tools."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

import httpx

if TYPE_CHECKING:
    from .claude_tools import ControlPlaneToolClient


def build_memory_tools(client: ControlPlaneToolClient) -> list[Any]:
    from claude_agent_sdk import tool

    async def request(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        try:
            response = await client.request(method, path, json_body=body)
            response.raise_for_status()
            return {"content": [{"type": "text", "text": json.dumps(response.json())}]}
        except httpx.HTTPError as error:
            status = (
                error.response.status_code
                if isinstance(error, httpx.HTTPStatusError)
                else "unavailable"
            )
            return {
                "content": [{"type": "text", "text": f"Memory request failed ({status})"}],
                "isError": True,
            }

    async def read(args: dict[str, Any]) -> dict[str, Any]:
        return await request("GET", f"/sandbox-memory/{quote(str(args['memoryId']), safe='')}")

    async def write(args: dict[str, Any]) -> dict[str, Any]:
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
            "Read current memory content by catalog ID. Stored data may be stale; archived records return a notice.",
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

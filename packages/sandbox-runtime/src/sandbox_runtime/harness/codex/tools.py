"""Adapt the shared sandbox tool definitions and results to Codex dynamic tools."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from jsonschema import ValidationError, validate

from ..tools import ControlPlaneToolClient, build_tools


class CodexTools:
    def __init__(self, client: ControlPlaneToolClient) -> None:
        self._tools = {tool.name: tool for tool in build_tools(client)}

    def specs(self) -> list[dict[str, Any]]:
        return [
            {
                "type": "namespace",
                "name": "oi",
                "description": "OpenInspect session tools",
                "tools": [
                    {
                        "type": "function",
                        "name": tool.name,
                        "description": tool.description,
                        "inputSchema": tool.input_schema,
                    }
                    for tool in self._tools.values()
                ],
            }
        ]

    @property
    def catalog_hash(self) -> str:
        return hashlib.sha256(json.dumps(self.specs(), sort_keys=True).encode()).hexdigest()

    async def call(self, params: dict[str, Any]) -> dict[str, Any]:
        tool = self._tools.get(params.get("tool", ""))
        args = params.get("arguments")
        if params.get("namespace") != "oi" or tool is None or not isinstance(args, dict):
            return self._failure("Unknown or unavailable OpenInspect tool")
        try:
            validate(args, tool.input_schema)
        except ValidationError:
            return self._failure("Invalid OpenInspect tool arguments")
        result = await tool.handler(args)
        return {
            "success": not result.is_error,
            "contentItems": [{"type": "inputText", "text": result.text}],
        }

    @staticmethod
    def _failure(message: str) -> dict[str, Any]:
        return {"success": False, "contentItems": [{"type": "inputText", "text": message}]}

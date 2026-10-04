"""Claude memory tools, built from the generated cross-harness specs.

``tools/_memory.js`` builds the OpenCode twins from the same specs with the
same requests and error text (each harness reports errors its own way). Arguments are forwarded verbatim after
dropping keys the input schema does not declare; the control plane derives
ownership, approval state, and write eligibility from the session.
"""

from __future__ import annotations

import functools
import re
from typing import TYPE_CHECKING, Any, Final
from urllib.parse import quote

import httpx

from .tool_results import error_result, error_text, text_result

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

    from ..memory_contract import MemoryToolSpec
    from .claude_tools import ControlPlaneToolClient

_PATH_PARAM: Final = re.compile(r"\{(\w+)\}")


class MemoryTools:
    """One generic handler for every memory endpoint; ``build`` binds it to each spec."""

    def __init__(self, client: ControlPlaneToolClient, specs: Sequence[MemoryToolSpec]) -> None:
        self.client = client
        self.specs = specs

    async def execute(self, spec: MemoryToolSpec, args: Mapping[str, Any]) -> dict[str, Any]:
        name = spec["name"]
        body = {key: args[key] for key in spec["inputSchema"]["properties"] if key in args}
        path = _PATH_PARAM.sub(
            lambda match: quote(str(body.pop(match[1], "")), safe=""), spec["path"]
        )
        try:
            response = await self.client.request(
                spec["method"], path, json_body=None if spec["method"] == "GET" else body
            )
        except httpx.HTTPError:
            # Transport details can name internal hosts; the agent only needs the outcome.
            return error_result(f"{name} failed (unavailable)")
        if not response.is_success:
            return error_result(f"{name} failed ({response.status_code}): {error_text(response)}")
        return text_result(response.text)

    def build(self) -> list[Any]:
        from claude_agent_sdk import tool

        return [
            tool(spec["name"], spec["description"], spec["inputSchema"])(
                functools.partial(self.execute, spec)
            )
            for spec in self.specs
        ]

"""Materialize the immutable project snapshot before either harness starts."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import quote

import httpx

if TYPE_CHECKING:
    from .runtime_config import RuntimeConfig

PROJECT_CONTEXT_PATH = Path("/tmp/openinspect-project-context.md")
PROJECT_CONTEXT_FETCH_TIMEOUT_SECONDS = 20
PROJECT_CONTEXT_RESPONSE_BYTES = 65_536
PROJECT_CONTEXT_INJECTION_BYTES = 12_000


async def prepare_project_context(
    config: RuntimeConfig,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    path: Path = PROJECT_CONTEXT_PATH,
) -> None:
    """Clear stale restore material and fail explicitly if a configured snapshot cannot load."""
    path.unlink(missing_ok=True)
    os.environ.pop("AGENT_PROJECT_CONTEXT_ENABLED", None)
    os.environ.pop("AGENT_PROJECT_SNAPSHOT_READY", None)
    if not config.session_config.get("project"):
        return
    url = (
        f"{config.control_plane_url.rstrip('/')}/sessions/"
        f"{quote(config.session_id, safe='')}/project-context?part=injection"
    )
    async with (
        httpx.AsyncClient(transport=transport) as client,
        client.stream(
            "GET",
            url,
            headers={"Authorization": f"Bearer {config.sandbox_token}"},
            timeout=PROJECT_CONTEXT_FETCH_TIMEOUT_SECONDS,
        ) as response,
    ):
        response.raise_for_status()
        payload = bytearray()
        async for chunk in response.aiter_bytes():
            payload.extend(chunk)
            if len(payload) > PROJECT_CONTEXT_RESPONSE_BYTES:
                raise ValueError("Project context response exceeds its byte budget")
    data = json.loads(payload)
    text = data.get("text")
    if not isinstance(text, str) or len(text.encode("utf-8")) > PROJECT_CONTEXT_INJECTION_BYTES:
        raise ValueError("Invalid project context injection")
    if text:
        path.write_text(text, encoding="utf-8")
        path.chmod(0o600)
    os.environ["AGENT_PROJECT_SNAPSHOT_READY"] = "true"
    if config.session_config["project"].get("toolEnabled", True):
        os.environ["AGENT_PROJECT_CONTEXT_ENABLED"] = "true"


def project_context_text() -> str:
    if os.environ.get("AGENT_PROJECT_SNAPSHOT_READY") != "true":
        return ""
    return PROJECT_CONTEXT_PATH.read_text(encoding="utf-8") if PROJECT_CONTEXT_PATH.exists() else ""

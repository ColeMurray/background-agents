"""Materialize pinned session memory before either agent harness starts."""

import asyncio
import json
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx

MEMORY_FILENAME = "oi-memory.md"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_RENDERED_CHARS = 256_000
REQUEST_TIMEOUT_SECONDS = 30
MAX_ATTEMPTS = 3


def memory_text(config_dir: Path) -> str | None:
    """Read materialized context, or return None when boot installed no memory file."""
    path = config_dir / MEMORY_FILENAME
    return path.read_text(encoding="utf-8") if path.is_file() else None


def append_memory(guidance: str | None, config_dir: Path) -> str | None:
    """Append pinned context for Claude, preserving existing guidance when memory is empty."""
    text = memory_text(config_dir)
    if not text:
        return guidance
    return f"{guidance}\n\n{text}" if guidance else text


class MemoryMaterializer:
    """Install control-plane-rendered context using credentials bound to one session.

    Boot must finish materialization before starting either harness. Restored files
    are not trusted: each call clears old context before fetching the pinned selection.
    """

    def __init__(
        self,
        control_plane_url: str,
        session_id: str,
        sandbox_token: str,
        config_dir: Path,
        log: Any,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.url = (
            f"{control_plane_url.rstrip('/')}/sessions/{quote(session_id, safe='')}/sandbox-memory"
        )
        self.token = sandbox_token
        self.destination = config_dir / MEMORY_FILENAME
        self.log = log
        self.transport = transport

    async def materialize(self) -> None:
        """Replace context atomically with an owner-readable file, or leave no file.

        A legacy 404 means empty context. Transport errors, throttling, and server
        failures retry within a bounded budget; authorization, validation, and
        exhausted retries propagate to fail the memory boot phase.
        """
        # A restored image may contain another session's context. Never retain it
        # on an empty response, old server, failed fetch, or malformed payload.
        self.destination.unlink(missing_ok=True)
        for attempt in range(MAX_ATTEMPTS):
            try:
                rendered = await self._fetch()
                if rendered:
                    self.destination.parent.mkdir(parents=True, exist_ok=True)
                    temporary = self.destination.with_suffix(".tmp")
                    try:
                        with temporary.open("w", encoding="utf-8") as stream:
                            temporary.chmod(0o600)
                            stream.write(rendered)
                        temporary.replace(self.destination)
                    finally:
                        temporary.unlink(missing_ok=True)
                return
            except (httpx.TransportError, httpx.HTTPStatusError) as error:
                retryable = (
                    not isinstance(error, httpx.HTTPStatusError)
                    or error.response.status_code >= 500
                    or error.response.status_code == 429
                )
                if not retryable or attempt == MAX_ATTEMPTS - 1:
                    raise RuntimeError("Session memory could not be loaded") from error
                await asyncio.sleep(attempt + 1)

    async def _fetch(self) -> str:
        """Stream a bounded versioned response without logging credentials or memory text."""
        async with (
            httpx.AsyncClient(transport=self.transport, timeout=REQUEST_TIMEOUT_SECONDS) as client,
            client.stream(
                "GET", self.url, headers={"Authorization": f"Bearer {self.token}"}
            ) as response,
        ):
            if response.status_code == 404:
                self.log.info("memory.unavailable_legacy_control_plane")
                return ""
            response.raise_for_status()
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > MAX_RESPONSE_BYTES:
                    raise RuntimeError("Session memory response exceeds the size limit")
        try:
            payload = json.loads(body)
        except (ValueError, UnicodeError) as error:
            raise RuntimeError("Invalid session memory response") from error
        if not isinstance(payload, dict) or payload.get("schemaVersion") != 1:
            raise RuntimeError("Unsupported session memory response")
        rendered = payload.get("rendered")
        if not isinstance(rendered, str) or len(rendered) > MAX_RENDERED_CHARS:
            raise RuntimeError("Invalid rendered session memory")
        return rendered

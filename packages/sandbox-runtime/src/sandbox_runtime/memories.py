"""Materialize pinned session memory before either agent harness starts."""

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, Protocol
from urllib.parse import quote

import httpx

from .control_plane_fetch import ResponseTooLargeError, fetch_bounded
from .durable_files import atomic_write_private, remove_abandoned_staging
from .memory_contract import SANDBOX_MEMORY_SCHEMA_VERSION

MEMORY_FILENAME: Final = "oi-memory.md"
MAX_MEMORY_RESPONSE_BYTES: Final = 2 * 1024 * 1024
MEMORY_FETCH_TIMEOUT_SECONDS: Final = 30.0


def memory_path(config_dir: Path) -> Path:
    """Where boot materializes rendered memory inside a harness's config directory."""
    return config_dir / MEMORY_FILENAME


def memory_text(config_dir: Path) -> str | None:
    """Read materialized context, or return None when boot installed no memory file."""
    path = memory_path(config_dir)
    return path.read_text(encoding="utf-8") if path.is_file() else None


def append_memory(guidance: str | None, config_dir: Path) -> str | None:
    """Append pinned context for Claude, preserving existing guidance when memory is empty."""
    text = memory_text(config_dir)
    if not text:
        return guidance
    return f"{guidance}\n\n{text}" if guidance else text


@dataclass(frozen=True)
class RenderedSessionMemory:
    """A session's pinned memory, rendered by the control plane for its harness."""

    manifest_sha256: str
    rendered: str


def _validate_rendered(body: bytes, max_rendered_chars: int) -> RenderedSessionMemory:
    """Parse an untrusted versioned rendered-memory response."""
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeError) as error:
        raise RuntimeError("Invalid session memory response") from error
    if (
        not isinstance(payload, dict)
        or payload.get("schemaVersion") != SANDBOX_MEMORY_SCHEMA_VERSION
    ):
        raise RuntimeError("Unsupported session memory response")
    manifest_sha256, rendered = payload.get("manifestSha256"), payload.get("rendered")
    if (
        not isinstance(manifest_sha256, str)
        or not isinstance(rendered, str)
        or len(rendered) > max_rendered_chars
    ):
        raise RuntimeError("Invalid rendered session memory")
    return RenderedSessionMemory(manifest_sha256, rendered)


class SessionMemoryClient:
    """Fetch one session's rendered memory with credentials bound to that session."""

    def __init__(
        self,
        control_plane_url: str,
        session_id: str,
        sandbox_token: str,
        *,
        max_rendered_chars: int,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.url = (
            f"{control_plane_url.rstrip('/')}/sessions/{quote(session_id, safe='')}/sandbox-memory"
        )
        self.headers = {"Authorization": f"Bearer {sandbox_token}"}
        self.max_rendered_chars = max_rendered_chars
        self.transport = transport

    async def fetch_rendered(self) -> RenderedSessionMemory:
        """Retry transient failures under the shared control-plane fetch policy.

        Raises RuntimeError once the fetch fails permanently or the payload is invalid.
        """
        try:
            body = await fetch_bounded(
                self.url,
                headers=self.headers,
                max_bytes=MAX_MEMORY_RESPONSE_BYTES,
                timeout_seconds=MEMORY_FETCH_TIMEOUT_SECONDS,
                transport=self.transport,
            )
        except (ResponseTooLargeError, httpx.HTTPError, OSError) as error:
            raise RuntimeError("Session memory could not be loaded") from error
        return _validate_rendered(body, self.max_rendered_chars)


class RenderedMemorySource(Protocol):
    """Where the materializer gets a session's rendered memory."""

    async def fetch_rendered(self) -> RenderedSessionMemory: ...


class MemoryMaterializer:
    """Install control-plane-rendered context before either harness starts.

    Boot must finish materialization before starting either harness. Restored files
    are not trusted: each call clears old context before fetching the pinned selection.
    """

    def __init__(self, client: RenderedMemorySource, destination: Path, log: Any) -> None:
        self.client = client
        self.destination = destination
        self.log = log

    async def materialize(self) -> None:
        """Replace context atomically with an owner-readable file, or leave no file.

        Any fetch or validation failure propagates to fail the memory boot phase.
        """
        # A restored image may contain another session's context. Never retain it
        # on an empty response, failed fetch, or malformed payload.
        self.destination.unlink(missing_ok=True)
        remove_abandoned_staging(self.destination)
        memory = await self.client.fetch_rendered()
        if memory.rendered:
            atomic_write_private(self.destination, memory.rendered)
        # Never log memory text; the manifest digest identifies the pinned selection.
        self.log.info(
            "memory.materialized",
            manifest_sha256=memory.manifest_sha256,
            rendered_chars=len(memory.rendered),
        )

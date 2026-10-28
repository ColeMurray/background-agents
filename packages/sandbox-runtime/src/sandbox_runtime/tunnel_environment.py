from __future__ import annotations

import asyncio
import json
import os
import shlex
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

import httpx

from .constants import (
    EXPECTED_TUNNEL_PORTS_ENV_VAR,
    TUNNEL_ENV_FILE_PATH,
    TUNNEL_ENV_SANDBOX_ID_KEY,
)
from .control_plane_fetch import ResponseTooLargeError, fetch_bounded
from .durable_files import atomic_write_private

MAX_TUNNEL_RESPONSE_BYTES = 64 * 1024
TUNNEL_FETCH_TIMEOUT_SECONDS = 2.0


class TunnelEnvironment:
    DEFAULT_WAIT_TIMEOUT_SECONDS = 30
    WAIT_POLL_INTERVAL_SECONDS = 0.2
    FETCH_RETRY_INTERVAL_SECONDS = 1.0

    def __init__(
        self,
        sandbox_id: str,
        log: Any,
        *,
        control_plane_url: str = "",
        session_id: str = "",
        sandbox_token: str = "",
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.sandbox_id = sandbox_id
        self.log = log
        self._urls_endpoint = (
            f"{control_plane_url.rstrip('/')}/sessions/{quote(session_id, safe='')}/tunnel-urls"
            if control_plane_url and session_id and sandbox_token
            else None
        )
        self._headers = {"Authorization": f"Bearer {sandbox_token}"}
        self._transport = transport

    async def _restore_from_control_plane(
        self, expected_ports: list[int], timeout_seconds: float
    ) -> bool:
        """Recover URLs when Modal's external file write is not visible after restore."""
        if self._urls_endpoint is None:
            return False
        try:
            # Bound the entire fetch, including retries, by the remaining wait budget.
            async with asyncio.timeout(timeout_seconds):
                content = await fetch_bounded(
                    self._urls_endpoint,
                    headers=self._headers,
                    max_bytes=MAX_TUNNEL_RESPONSE_BYTES,
                    timeout_seconds=timeout_seconds,
                    transport=self._transport,
                )
            payload = json.loads(content)
            urls = payload.get("tunnelUrls") if isinstance(payload, dict) else None
            if not isinstance(urls, dict):
                raise ValueError("invalid tunnel URL map")
            if any(str(port) not in urls for port in expected_ports):
                return False  # The control plane may still be publishing URLs.
            lines = [f"{TUNNEL_ENV_SANDBOX_ID_KEY}={shlex.quote(self.sandbox_id)}"]
            for port in sorted(set(expected_ports)):
                url = urls[str(port)]
                if not isinstance(url, str) or any(char.isspace() for char in url):
                    raise ValueError("invalid tunnel URL")
                parsed = urlsplit(url)
                if parsed.scheme not in {"https", "http"} or not parsed.netloc:
                    raise ValueError("invalid tunnel URL")
                lines.append(f"TUNNEL_{port}={shlex.quote(url)}")
            atomic_write_private(Path(TUNNEL_ENV_FILE_PATH), "\n".join(lines) + "\n")
            self.log.info("tunnel.env_file_restored", ports=expected_ports)
            return True
        except (httpx.HTTPError, OSError, TimeoutError, ValueError, ResponseTooLargeError) as error:
            self.log.warn("tunnel.env_file_restore_failed", error=type(error).__name__)
            return False

    def expected_ports(self) -> list[int]:
        raw = os.environ.get(EXPECTED_TUNNEL_PORTS_ENV_VAR, "")
        if not raw:
            return []
        ports: list[int] = []
        for piece in raw.split(","):
            piece = piece.strip()
            if not piece:
                continue
            try:
                ports.append(int(piece))
            except ValueError:
                self.log.warn("tunnel.expected_ports_parse_failed", value=piece, raw=raw)
        return ports

    def clear_stale_file(self) -> None:
        path = Path(TUNNEL_ENV_FILE_PATH)
        if not path.exists() and not path.is_symlink():
            return
        if self.sandbox_id and self.sandbox_id != "unknown":
            try:
                own_marker = f"{TUNNEL_ENV_SANDBOX_ID_KEY}={self.sandbox_id}"
                if own_marker in path.read_text().splitlines():
                    self.log.info("tunnel.fresh_file_kept", path=str(path))
                    return
            except Exception as error:
                self.log.warn("tunnel.stale_check_read_failed", path=str(path), exc=error)
        try:
            path.unlink(missing_ok=True)
            self.log.info("tunnel.stale_file_cleared", path=str(path))
        except Exception as error:
            self.log.warn("tunnel.stale_file_clear_failed", path=str(path), exc=error)

    async def wait_until_ready(self, expected_ports: list[int]) -> bool:
        if not expected_ports:
            return True
        raw_timeout = os.environ.get("TUNNEL_WAIT_TIMEOUT_SECONDS")
        try:
            timeout_seconds = (
                float(raw_timeout) if raw_timeout else self.DEFAULT_WAIT_TIMEOUT_SECONDS
            )
        except ValueError:
            timeout_seconds = self.DEFAULT_WAIT_TIMEOUT_SECONDS

        path = Path(TUNNEL_ENV_FILE_PATH)
        expected_prefixes = [f"TUNNEL_{port}=" for port in expected_ports]
        start_time = time.monotonic()
        deadline = start_time + timeout_seconds
        next_fetch_time = start_time
        while time.monotonic() < deadline:
            if path.exists():
                try:
                    lines = path.read_text().splitlines()
                    if all(
                        any(line.startswith(prefix) for line in lines)
                        for prefix in expected_prefixes
                    ):
                        self.log.info(
                            "tunnel.env_file_ready",
                            path=str(path),
                            ports=expected_ports,
                            wait_ms=int((time.monotonic() - start_time) * 1000),
                        )
                        return True
                except Exception as error:
                    self.log.warn("tunnel.env_file_read_failed", path=str(path), exc=error)
            now = time.monotonic()
            if self._urls_endpoint is not None and next_fetch_time <= now < deadline:
                if await self._restore_from_control_plane(
                    expected_ports, min(TUNNEL_FETCH_TIMEOUT_SECONDS, deadline - now)
                ):
                    return True
                next_fetch_time = time.monotonic() + self.FETCH_RETRY_INTERVAL_SECONDS
            await asyncio.sleep(
                min(self.WAIT_POLL_INTERVAL_SECONDS, max(0, deadline - time.monotonic()))
            )

        self.log.warn(
            "tunnel.env_file_wait_timeout",
            path=str(path),
            ports=expected_ports,
            timeout_seconds=timeout_seconds,
        )
        return False

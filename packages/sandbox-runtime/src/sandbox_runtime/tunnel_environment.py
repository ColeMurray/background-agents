from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path
from typing import Any

from .constants import (
    EXPECTED_TUNNEL_PORTS_ENV_VAR,
    TUNNEL_ENV_FILE_PATH,
    TUNNEL_ENV_SANDBOX_ID_KEY,
)


class TunnelEnvironment:
    DEFAULT_WAIT_TIMEOUT_SECONDS = 30
    WAIT_POLL_INTERVAL_SECONDS = 0.2

    def __init__(self, sandbox_id: str, log: Any) -> None:
        self.sandbox_id = sandbox_id
        self.log = log

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
            await asyncio.sleep(self.WAIT_POLL_INTERVAL_SECONDS)

        self.log.warn(
            "tunnel.env_file_wait_timeout",
            path=str(path),
            ports=expected_ports,
            timeout_seconds=timeout_seconds,
        )
        return False

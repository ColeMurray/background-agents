from __future__ import annotations

import asyncio
import contextlib
import os
from typing import TYPE_CHECKING, Any

from .constants import CODE_SERVER_PORT, CODE_SERVER_PORT_ENV_VAR
from .process_output import iter_process_lines
from .service_ports import port_from_env

if TYPE_CHECKING:
    from pathlib import Path

_LOG_FORWARD_STREAM_LIMIT_BYTES = 1024 * 1024
_STOP_TIMEOUT_SECONDS = 5


class CodeServer:
    def __init__(self, log: Any) -> None:
        self.log = log
        self._process: asyncio.subprocess.Process | None = None

    async def start(self, workdir: Path) -> None:
        password = os.environ.get("CODE_SERVER_PASSWORD")
        if not password:
            self.log.info("code_server.skip", reason="no_password")
            return

        port = port_from_env(CODE_SERVER_PORT_ENV_VAR, CODE_SERVER_PORT)
        self._process = await asyncio.create_subprocess_exec(
            "code-server",
            "--bind-addr",
            f"0.0.0.0:{port}",
            "--auth",
            "password",
            "--disable-telemetry",
            str(workdir),
            cwd=workdir,
            env={**os.environ, "PASSWORD": password},
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=_LOG_FORWARD_STREAM_LIMIT_BYTES,
        )
        asyncio.create_task(self._forward_logs())
        self.log.info("code_server.started", port=port)

    async def _forward_logs(self) -> None:
        if not self._process or not self._process.stdout:
            return
        async for line in iter_process_lines(
            self._process.stdout,
            on_error=lambda error: self.log.warn("code_server.log_forward_error", exc=error),
        ):
            self.log.info("code_server.stdout", line=line)

    async def stop(self) -> None:
        process = self._process
        if process and process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=_STOP_TIMEOUT_SECONDS)
            except TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    process.kill()
                try:
                    await asyncio.wait_for(process.wait(), timeout=_STOP_TIMEOUT_SECONDS)
                except TimeoutError:
                    self.log.warn("code_server.stop_timeout")
        self._process = None

    def exit_code(self) -> int | None:
        return self._process.returncode if self._process else None

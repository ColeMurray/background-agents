from __future__ import annotations

import asyncio
import contextlib
import os
from typing import TYPE_CHECKING, Any

from .constants import TTYD_PORT, TTYD_PROXY_PORT, TTYD_PROXY_PORT_ENV_VAR
from .process_output import iter_process_lines
from .service_ports import port_from_env

if TYPE_CHECKING:
    from pathlib import Path

_LOG_FORWARD_STREAM_LIMIT_BYTES = 1024 * 1024
_READINESS_TIMEOUT_SECONDS = 5


class WebTerminal:
    def __init__(self, log: Any) -> None:
        self.log = log
        self._ttyd_process: asyncio.subprocess.Process | None = None
        self._proxy_process: asyncio.subprocess.Process | None = None

    async def start(self, workdir: Path) -> None:
        if not os.environ.get("TERMINAL_ENABLED"):
            self.log.info("ttyd.skip", reason="TERMINAL_ENABLED not set")
            return

        self.log.info("ttyd.starting", port=TTYD_PORT, workdir=workdir)
        self._ttyd_process = await asyncio.create_subprocess_exec(
            "ttyd",
            "--port",
            str(TTYD_PORT),
            "--interface",
            "127.0.0.1",
            "--writable",
            "bash",
            cwd=workdir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=os.environ.copy(),
            limit=_LOG_FORWARD_STREAM_LIMIT_BYTES,
        )
        asyncio.create_task(self._forward_logs("ttyd", self._ttyd_process))
        self.log.info("ttyd.started", pid=self._ttyd_process.pid)
        if not await self._wait_for_ttyd():
            await self.stop()
            raise RuntimeError("ttyd failed to become ready")

        proxy_port = port_from_env(TTYD_PROXY_PORT_ENV_VAR, TTYD_PROXY_PORT)
        self.log.info("ttyd_proxy.starting", port=proxy_port)
        self._proxy_process = await asyncio.create_subprocess_exec(
            "bun",
            "run",
            "/app/sandbox_runtime/ttyd_proxy/server.ts",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=os.environ.copy(),
            limit=_LOG_FORWARD_STREAM_LIMIT_BYTES,
        )
        asyncio.create_task(self._forward_logs("ttyd_proxy", self._proxy_process))
        self.log.info("ttyd_proxy.started", pid=self._proxy_process.pid)

    async def _forward_logs(self, name: str, process: asyncio.subprocess.Process) -> None:
        if not process.stdout:
            return
        async for line in iter_process_lines(
            process.stdout,
            on_error=lambda error: self.log.warn(f"{name}.log_forward_error", exc=error),
        ):
            self.log.info(f"{name}.stdout", line=line)

    async def _wait_for_ttyd(self) -> bool:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + _READINESS_TIMEOUT_SECONDS
        while loop.time() < deadline:
            if self._ttyd_process and self._ttyd_process.returncode is not None:
                return False
            try:
                _, writer = await asyncio.open_connection("127.0.0.1", TTYD_PORT)
                writer.close()
                await writer.wait_closed()
                return True
            except (ConnectionRefusedError, OSError):
                await asyncio.sleep(0.1)
        self.log.warn("port_readiness.timeout", port=TTYD_PORT, timeout=_READINESS_TIMEOUT_SECONDS)
        return False

    async def stop(self) -> None:
        for process in (self._proxy_process, self._ttyd_process):
            if process and process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=_READINESS_TIMEOUT_SECONDS)
                except TimeoutError:
                    with contextlib.suppress(ProcessLookupError):
                        process.kill()
                    try:
                        await asyncio.wait_for(process.wait(), timeout=_READINESS_TIMEOUT_SECONDS)
                    except TimeoutError:
                        self.log.warn("web_terminal.stop_timeout")
        self._proxy_process = None
        self._ttyd_process = None

    def crash(self) -> tuple[str, int] | None:
        for name, process in (("ttyd", self._ttyd_process), ("ttyd_proxy", self._proxy_process)):
            if process and process.returncode is not None:
                return name, process.returncode
        return None

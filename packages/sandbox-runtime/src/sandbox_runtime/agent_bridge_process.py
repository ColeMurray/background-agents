from __future__ import annotations

import asyncio
import contextlib
import os
from typing import TYPE_CHECKING, Any

from .constants import OPENCODE_PORT
from .process_output import iter_process_lines

if TYPE_CHECKING:
    from .runtime_config import BridgeProcessConfig

_LOG_FORWARD_STREAM_LIMIT_BYTES = 1024 * 1024


class AgentBridgeProcess:
    def __init__(self, config: BridgeProcessConfig, log: Any) -> None:
        self.log = log
        self.sandbox_id = config.sandbox_id
        self.control_plane_url = config.control_plane_url
        self.sandbox_token = config.sandbox_token
        self.session_id = config.session_id
        self._process: asyncio.subprocess.Process | None = None

    async def start(self) -> None:
        self.log.info("bridge.start")
        if not self.control_plane_url:
            self.log.info("bridge.skip", reason="no_control_plane_url")
            return
        if not self.session_id:
            self.log.info("bridge.skip", reason="no_session_id")
            return

        self._process = await asyncio.create_subprocess_exec(
            "python",
            "-m",
            "sandbox_runtime.bridge",
            "--sandbox-id",
            self.sandbox_id,
            "--session-id",
            self.session_id,
            "--control-plane",
            self.control_plane_url,
            "--token",
            self.sandbox_token,
            "--opencode-port",
            str(OPENCODE_PORT),
            env=os.environ,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=_LOG_FORWARD_STREAM_LIMIT_BYTES,
        )
        asyncio.create_task(self._forward_logs())
        self.log.info("bridge.started")
        await asyncio.sleep(0.5)
        if self._process.returncode is not None:
            exit_code = self._process.returncode
            stdout, _ = await self._process.communicate()
            if exit_code == 0:
                self.log.warn("bridge.early_exit", exit_code=exit_code)
            else:
                self.log.error(
                    "bridge.startup_crash",
                    exit_code=exit_code,
                    output=stdout.decode(errors="replace") if stdout else "",
                )

    async def _forward_logs(self) -> None:
        if not self._process or not self._process.stdout:
            return
        async for line in iter_process_lines(
            self._process.stdout,
            on_error=lambda error: self.log.warn("bridge.log_forward_error", exc=error),
        ):
            print(line)

    async def stop(self) -> None:
        if self._process and self._process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                self._process.terminate()
            try:
                await asyncio.wait_for(self._process.wait(), timeout=5.0)
            except TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    self._process.kill()
                try:
                    await asyncio.wait_for(self._process.wait(), timeout=5.0)
                except TimeoutError:
                    self.log.warn("bridge.stop_timeout")

    def exit_code(self) -> int | None:
        return self._process.returncode if self._process else None

    def started(self) -> bool:
        return self._process is not None

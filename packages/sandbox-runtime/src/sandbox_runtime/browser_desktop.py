from __future__ import annotations

import asyncio
import contextlib
import os
from pathlib import Path
from typing import Any

from cryptography.hazmat.decrepit.ciphers.algorithms import TripleDES
from cryptography.hazmat.primitives.ciphers import Cipher, modes

from .constants import (
    NOVNC_PORT,
    NOVNC_PORT_ENV_VAR,
    NOVNC_WEB_ROOT,
    VNC_DISPLAY,
    VNC_PASSWORD_FILE_PATH,
    VNC_PASSWORD_MAX_BYTES,
    VNC_PORT,
)
from .process_output import iter_process_lines
from .service_ports import port_from_env

_LOG_FORWARD_STREAM_LIMIT_BYTES = 1024 * 1024
_READINESS_TIMEOUT_SECONDS = 5
_VNC_PASSWORD_FILE_KEY = bytes((0xE8, 0x4A, 0xD6, 0x60, 0xC4, 0x72, 0x1A, 0xE0)) * 3


def _encode_vnc_password(password: bytes) -> bytes:
    encryptor = Cipher(TripleDES(_VNC_PASSWORD_FILE_KEY), modes.ECB()).encryptor()
    return encryptor.update(password.ljust(VNC_PASSWORD_MAX_BYTES, b"\0")) + encryptor.finalize()


class BrowserDesktop:
    def __init__(self, log: Any, *, password: str | None) -> None:
        self.log = log
        self._password = password
        self._xvfb_process: asyncio.subprocess.Process | None = None
        self._fluxbox_process: asyncio.subprocess.Process | None = None
        self._x11vnc_process: asyncio.subprocess.Process | None = None
        self._novnc_process: asyncio.subprocess.Process | None = None

    async def start(self) -> None:
        if not self._password:
            Path(VNC_PASSWORD_FILE_PATH).unlink(missing_ok=True)
            self.log.info("vnc.skip", reason="no_password")
            return
        password_bytes = self._password.encode()
        if len(password_bytes) > VNC_PASSWORD_MAX_BYTES:
            raise ValueError(f"VNC password must not exceed {VNC_PASSWORD_MAX_BYTES} bytes")

        self._clear_display_artifacts()
        password_path = Path(VNC_PASSWORD_FILE_PATH)
        password_path.unlink(missing_ok=True)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        password_fd = os.open(password_path, flags, 0o600)
        try:
            os.write(password_fd, _encode_vnc_password(password_bytes))
        finally:
            os.close(password_fd)

        child_env = os.environ.copy()
        display_env = {**child_env, "DISPLAY": VNC_DISPLAY}
        self._xvfb_process = await self._launch(
            "xvfb",
            "Xvfb",
            VNC_DISPLAY,
            "-screen",
            "0",
            "1280x720x24",
            "-nolisten",
            "tcp",
            env=child_env,
        )
        display_number = VNC_DISPLAY.removeprefix(":").split(".", maxsplit=1)[0]
        if not await self._wait_for_path(
            Path(f"/tmp/.X11-unix/X{display_number}"), self._xvfb_process
        ):
            await self.stop()
            raise RuntimeError("Xvfb failed to become ready")
        self._fluxbox_process = await self._launch("fluxbox", "fluxbox", env=display_env)
        self._x11vnc_process = await self._launch(
            "x11vnc",
            "x11vnc",
            "-display",
            VNC_DISPLAY,
            "-rfbport",
            str(VNC_PORT),
            "-listen",
            "127.0.0.1",
            "-forever",
            "-shared",
            "-rfbauth",
            VNC_PASSWORD_FILE_PATH,
            env=display_env,
        )
        if not await self._wait_for_port(VNC_PORT):
            await self.stop()
            raise RuntimeError("x11vnc failed to become ready")
        novnc_port = port_from_env(NOVNC_PORT_ENV_VAR, NOVNC_PORT)
        self._novnc_process = await self._launch(
            "novnc",
            "websockify",
            "--web",
            NOVNC_WEB_ROOT,
            f"0.0.0.0:{novnc_port}",
            f"127.0.0.1:{VNC_PORT}",
            env=child_env,
        )
        self.log.info("vnc.started", display=VNC_DISPLAY, novnc_port=novnc_port)

    async def _launch(
        self, name: str, *command: str, env: dict[str, str]
    ) -> asyncio.subprocess.Process:
        process = await asyncio.create_subprocess_exec(
            *command,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=_LOG_FORWARD_STREAM_LIMIT_BYTES,
        )
        asyncio.create_task(self._forward_logs(name, process))
        return process

    async def _forward_logs(self, name: str, process: asyncio.subprocess.Process) -> None:
        if not process.stdout:
            return
        log = self.log.debug if name == "fluxbox" else self.log.info
        async for line in iter_process_lines(
            process.stdout,
            on_error=lambda error: self.log.warn(f"{name}.log_forward_error", exc=error),
        ):
            log(f"{name}.stdout", line=line)

    def _clear_display_artifacts(self) -> None:
        display_number = VNC_DISPLAY.removeprefix(":").split(".", maxsplit=1)[0]
        for path in (
            Path(f"/tmp/.X{display_number}-lock"),
            Path(f"/tmp/.X11-unix/X{display_number}"),
        ):
            path.unlink(missing_ok=True)

    async def _wait_for_path(self, path: Path, process: asyncio.subprocess.Process) -> bool:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + _READINESS_TIMEOUT_SECONDS
        while loop.time() < deadline:
            if process.returncode is not None:
                return False
            if path.exists():
                return True
            await asyncio.sleep(0.1)
        self.log.warn("path_readiness.timeout", path=str(path), timeout=_READINESS_TIMEOUT_SECONDS)
        return False

    async def _wait_for_port(self, port: int) -> bool:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + _READINESS_TIMEOUT_SECONDS
        while loop.time() < deadline:
            try:
                _, writer = await asyncio.open_connection("127.0.0.1", port)
                writer.close()
                await writer.wait_closed()
                return True
            except (ConnectionRefusedError, OSError):
                await asyncio.sleep(0.1)
        self.log.warn("port_readiness.timeout", port=port, timeout=_READINESS_TIMEOUT_SECONDS)
        return False

    async def stop(self) -> None:
        for name, process in (
            ("novnc", self._novnc_process),
            ("x11vnc", self._x11vnc_process),
            ("fluxbox", self._fluxbox_process),
            ("xvfb", self._xvfb_process),
        ):
            if process and process.returncode is None:
                self.log.info(f"{name}.terminating")
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
                        self.log.warn(f"{name}.stop_timeout")
            setattr(self, f"_{name}_process", None)
        Path(VNC_PASSWORD_FILE_PATH).unlink(missing_ok=True)
        self._clear_display_artifacts()

    def crash(self) -> tuple[str, int] | None:
        for name, process in (
            ("xvfb", self._xvfb_process),
            ("fluxbox", self._fluxbox_process),
            ("x11vnc", self._x11vnc_process),
            ("novnc", self._novnc_process),
        ):
            if process and process.returncode is not None:
                return name, process.returncode
        return None

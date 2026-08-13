from __future__ import annotations

import asyncio
import contextlib
import os
from pathlib import Path
from typing import Any

from cryptography.hazmat.decrepit.ciphers.algorithms import TripleDES
from cryptography.hazmat.primitives.ciphers import Cipher, modes

from .constants import (
    CODE_SERVER_PORT,
    CODE_SERVER_PORT_ENV_VAR,
    NOVNC_PORT,
    NOVNC_PORT_ENV_VAR,
    NOVNC_WEB_ROOT,
    TTYD_PORT,
    TTYD_PROXY_PORT,
    TTYD_PROXY_PORT_ENV_VAR,
    VNC_DISPLAY,
    VNC_PASSWORD_FILE_PATH,
    VNC_PASSWORD_MAX_BYTES,
    VNC_PORT,
)
from .process_output import iter_process_lines

_LOG_FORWARD_STREAM_LIMIT_BYTES = 1024 * 1024
_VNC_PASSWORD_FILE_KEY = bytes((0xE8, 0x4A, 0xD6, 0x60, 0xC4, 0x72, 0x1A, 0xE0)) * 3


def _encode_vnc_password(password: bytes) -> bytes:
    encryptor = Cipher(TripleDES(_VNC_PASSWORD_FILE_KEY), modes.ECB()).encryptor()
    return encryptor.update(password.ljust(VNC_PASSWORD_MAX_BYTES, b"\0")) + encryptor.finalize()


def _port_from_env(env_var: str, default: int) -> int:
    raw = os.environ.get(env_var)
    if raw is None:
        return default
    try:
        port = int(raw)
    except ValueError:
        return default
    return port if 1 <= port <= 65535 else default


class AccessServices:
    SIDECAR_TIMEOUT_SECONDS = 5

    def __init__(
        self,
        shutdown_event: asyncio.Event,
        log: Any,
        *,
        vnc_password: str | None,
    ) -> None:
        self.shutdown_event = shutdown_event
        self.log = log
        self._vnc_password = vnc_password
        self._code_server_process: asyncio.subprocess.Process | None = None
        self._ttyd_process: asyncio.subprocess.Process | None = None
        self._ttyd_proxy_process: asyncio.subprocess.Process | None = None
        self._xvfb_process: asyncio.subprocess.Process | None = None
        self._fluxbox_process: asyncio.subprocess.Process | None = None
        self._x11vnc_process: asyncio.subprocess.Process | None = None
        self._novnc_process: asyncio.subprocess.Process | None = None

    async def start_code_server(self, workdir: Path) -> None:
        """Start code-server for browser-based VS Code editing."""
        password = os.environ.get("CODE_SERVER_PASSWORD")
        if not password:
            self.log.info("code_server.skip", reason="no_password")
            return

        code_server_port = _port_from_env(CODE_SERVER_PORT_ENV_VAR, CODE_SERVER_PORT)
        self._code_server_process = await asyncio.create_subprocess_exec(
            "code-server",
            "--bind-addr",
            f"0.0.0.0:{code_server_port}",
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

        asyncio.create_task(self._forward_code_server_logs())
        self.log.info("code_server.started", port=code_server_port)

    async def _forward_code_server_logs(self) -> None:
        """Forward code-server stdout to supervisor stdout."""
        if not self._code_server_process or not self._code_server_process.stdout:
            return
        async for line in iter_process_lines(
            self._code_server_process.stdout,
            on_error=lambda error: self.log.warn("code_server.log_forward_error", exc=error),
        ):
            self.log.info("code_server.stdout", line=line)

    async def start_ttyd(self, workdir: Path) -> None:
        """Start ttyd web terminal if TERMINAL_ENABLED is set."""
        if not os.environ.get("TERMINAL_ENABLED"):
            self.log.info("ttyd.skip", reason="TERMINAL_ENABLED not set")
            return

        cmd = [
            "ttyd",
            "--port",
            str(TTYD_PORT),  # localhost-only internal port; fixed (never exposed)
            "--interface",
            "127.0.0.1",  # localhost only — proxy is the only external gateway
            "--writable",
            "bash",
        ]

        self.log.info("ttyd.starting", port=TTYD_PORT, workdir=workdir)

        self._ttyd_process = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=workdir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=os.environ.copy(),
            limit=_LOG_FORWARD_STREAM_LIMIT_BYTES,
        )

        asyncio.create_task(self._forward_ttyd_logs())
        self.log.info("ttyd.started", pid=self._ttyd_process.pid)

    async def start_ttyd_proxy(self) -> None:
        """Start the JWT-authenticated reverse proxy in front of ttyd."""
        if not os.environ.get("TERMINAL_ENABLED"):
            return

        cmd = ["bun", "run", "/app/sandbox_runtime/ttyd_proxy/server.ts"]

        self.log.info(
            "ttyd_proxy.starting",
            port=_port_from_env(TTYD_PROXY_PORT_ENV_VAR, TTYD_PROXY_PORT),
        )

        self._ttyd_proxy_process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=os.environ.copy(),
            limit=_LOG_FORWARD_STREAM_LIMIT_BYTES,
        )

        asyncio.create_task(self._forward_ttyd_proxy_logs())
        self.log.info("ttyd_proxy.started", pid=self._ttyd_proxy_process.pid)

    async def _forward_ttyd_logs(self) -> None:
        """Forward ttyd stdout to supervisor stdout."""
        if not self._ttyd_process or not self._ttyd_process.stdout:
            return
        async for line in iter_process_lines(
            self._ttyd_process.stdout,
            on_error=lambda error: self.log.warn("ttyd.log_forward_error", exc=error),
        ):
            self.log.info("ttyd.stdout", line=line)

    async def _forward_ttyd_proxy_logs(self) -> None:
        """Forward ttyd proxy stdout to supervisor stdout."""
        if not self._ttyd_proxy_process or not self._ttyd_proxy_process.stdout:
            return
        async for line in iter_process_lines(
            self._ttyd_proxy_process.stdout,
            on_error=lambda error: self.log.warn("ttyd_proxy.log_forward_error", exc=error),
        ):
            self.log.info("ttyd_proxy.stdout", line=line)

    async def start_vnc(self) -> None:
        """Start the optional desktop and browser-facing noVNC sidecar stack."""
        password = self._vnc_password
        if not password:
            Path(VNC_PASSWORD_FILE_PATH).unlink(missing_ok=True)
            self.log.info("vnc.skip", reason="no_password")
            return

        password_bytes = password.encode()
        if len(password_bytes) > VNC_PASSWORD_MAX_BYTES:
            raise ValueError(f"VNC password must not exceed {VNC_PASSWORD_MAX_BYTES} bytes")

        self._clear_vnc_display_artifacts()

        password_path = Path(VNC_PASSWORD_FILE_PATH)
        password_path.unlink(missing_ok=True)
        password_open_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        password_fd = os.open(
            password_path,
            password_open_flags,
            0o600,
        )
        try:
            os.write(password_fd, _encode_vnc_password(password_bytes))
        finally:
            os.close(password_fd)

        child_env = os.environ.copy()
        display_env = {**child_env, "DISPLAY": VNC_DISPLAY}
        xvfb_cmd = [
            "Xvfb",
            VNC_DISPLAY,
            "-screen",
            "0",
            "1280x720x24",
            "-nolisten",
            "tcp",
        ]
        self._xvfb_process = await asyncio.create_subprocess_exec(
            *xvfb_cmd,
            env=child_env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=_LOG_FORWARD_STREAM_LIMIT_BYTES,
        )
        asyncio.create_task(self._forward_vnc_logs("xvfb", self._xvfb_process))

        display_number = VNC_DISPLAY.removeprefix(":").split(".", maxsplit=1)[0]
        display_socket = Path(f"/tmp/.X11-unix/X{display_number}")
        if not await self._wait_for_path(display_socket, self._xvfb_process):
            raise RuntimeError("Xvfb failed to become ready")

        fluxbox_cmd = ["fluxbox"]
        self._fluxbox_process = await asyncio.create_subprocess_exec(
            *fluxbox_cmd,
            env=display_env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=_LOG_FORWARD_STREAM_LIMIT_BYTES,
        )
        asyncio.create_task(self._forward_vnc_logs("fluxbox", self._fluxbox_process))

        x11vnc_cmd = [
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
        ]
        self._x11vnc_process = await asyncio.create_subprocess_exec(
            *x11vnc_cmd,
            env=display_env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=_LOG_FORWARD_STREAM_LIMIT_BYTES,
        )
        asyncio.create_task(self._forward_vnc_logs("x11vnc", self._x11vnc_process))
        if not await self._wait_for_port(VNC_PORT):
            raise RuntimeError("x11vnc failed to become ready")

        novnc_port = _port_from_env(NOVNC_PORT_ENV_VAR, NOVNC_PORT)
        novnc_cmd = [
            "websockify",
            "--web",
            NOVNC_WEB_ROOT,
            f"0.0.0.0:{novnc_port}",
            f"127.0.0.1:{VNC_PORT}",
        ]
        self._novnc_process = await asyncio.create_subprocess_exec(
            *novnc_cmd,
            env=child_env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=_LOG_FORWARD_STREAM_LIMIT_BYTES,
        )
        asyncio.create_task(self._forward_vnc_logs("novnc", self._novnc_process))
        self.log.info("vnc.started", display=VNC_DISPLAY, novnc_port=novnc_port)

    def _clear_vnc_display_artifacts(self) -> None:
        """Remove Xvfb lock/socket files that filesystem snapshots can retain."""
        display_number = VNC_DISPLAY.removeprefix(":").split(".", maxsplit=1)[0]
        for path in (
            Path(f"/tmp/.X{display_number}-lock"),
            Path(f"/tmp/.X11-unix/X{display_number}"),
        ):
            path.unlink(missing_ok=True)

    async def _wait_for_path(
        self,
        path: Path,
        process: asyncio.subprocess.Process,
        timeout_seconds: float | None = None,
    ) -> bool:
        """Wait for a process-owned readiness path while ensuring it stays alive."""
        timeout_seconds = timeout_seconds or self.SIDECAR_TIMEOUT_SECONDS
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_seconds
        while loop.time() < deadline:
            if process.returncode is not None:
                return False
            if path.exists():
                return True
            await asyncio.sleep(0.1)
        self.log.warn("path_readiness.timeout", path=str(path), timeout=timeout_seconds)
        return False

    async def _forward_vnc_logs(
        self,
        process_name: str,
        process: asyncio.subprocess.Process,
    ) -> None:
        """Forward one VNC component's stdout without including credentials."""
        if not process.stdout:
            return
        async for line in iter_process_lines(
            process.stdout,
            on_error=lambda error: self.log.warn(f"{process_name}.log_forward_error", exc=error),
        ):
            self.log.info(f"{process_name}.stdout", line=line)

    async def _stop_vnc(self) -> None:
        """Stop the VNC stack in reverse dependency order and remove its secret."""
        for process_name, process in (
            ("novnc", self._novnc_process),
            ("x11vnc", self._x11vnc_process),
            ("fluxbox", self._fluxbox_process),
            ("xvfb", self._xvfb_process),
        ):
            if process and process.returncode is None:
                self.log.info(f"{process_name}.terminating")
                with contextlib.suppress(ProcessLookupError):
                    process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=self.SIDECAR_TIMEOUT_SECONDS)
                except TimeoutError:
                    with contextlib.suppress(ProcessLookupError):
                        process.kill()
                    await process.wait()
            setattr(self, f"_{process_name}_process", None)
        Path(VNC_PASSWORD_FILE_PATH).unlink(missing_ok=True)
        self._clear_vnc_display_artifacts()

    async def _wait_for_port(self, port: int, timeout_seconds: float | None = None) -> bool:
        timeout_seconds = timeout_seconds or self.SIDECAR_TIMEOUT_SECONDS
        """Wait for a service to start listening on a port. Returns True if ready."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_seconds
        while loop.time() < deadline:
            try:
                _, writer = await asyncio.open_connection("127.0.0.1", port)
                writer.close()
                await writer.wait_closed()
                return True
            except (ConnectionRefusedError, OSError):
                await asyncio.sleep(0.1)
        self.log.warn("port_readiness.timeout", port=port, timeout=timeout_seconds)
        return False

    async def stop_vnc(self) -> None:
        await self._stop_vnc()

    async def wait_for_ttyd(self) -> bool:
        return await self._wait_for_port(TTYD_PORT, timeout_seconds=self.SIDECAR_TIMEOUT_SECONDS)

    async def stop(self) -> None:
        for name, process in (
            ("ttyd_proxy", self._ttyd_proxy_process),
            ("ttyd", self._ttyd_process),
            ("code_server", self._code_server_process),
        ):
            if process and process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=self.SIDECAR_TIMEOUT_SECONDS)
                except TimeoutError:
                    with contextlib.suppress(ProcessLookupError):
                        process.kill()
                    await process.wait()
            setattr(self, f"_{name}_process", None)
        await self._stop_vnc()

    def ttyd_started(self) -> bool:
        """Return whether a ttyd process has been created."""
        return self._ttyd_process is not None

    def code_server_exit_code(self) -> int | None:
        """Return code-server's exit code, or None while absent/running."""
        return self._code_server_process.returncode if self._code_server_process else None

    def ttyd_exit_code(self) -> int | None:
        """Return ttyd's exit code, or None while absent/running."""
        return self._ttyd_process.returncode if self._ttyd_process else None

    def ttyd_proxy_exit_code(self) -> int | None:
        """Return the ttyd proxy's exit code, or None while absent/running."""
        return self._ttyd_proxy_process.returncode if self._ttyd_proxy_process else None

    def abandon_code_server(self) -> None:
        """Discard code-server after its restart budget expires."""
        self._code_server_process = None

    def abandon_ttyd(self) -> None:
        """Discard ttyd after its restart budget expires."""
        self._ttyd_process = None

    def abandon_ttyd_proxy(self) -> None:
        """Discard the ttyd proxy after its restart budget expires."""
        self._ttyd_proxy_process = None

    def crashed_vnc(self) -> tuple[str, int] | None:
        """Return the first exited component in the VNC dependency stack."""
        for name, process in (
            ("xvfb", self._xvfb_process),
            ("fluxbox", self._fluxbox_process),
            ("x11vnc", self._x11vnc_process),
            ("novnc", self._novnc_process),
        ):
            if process and process.returncode is not None:
                return name, process.returncode
        return None

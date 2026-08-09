from __future__ import annotations

import asyncio
import contextlib
import os
from pathlib import Path
from typing import TYPE_CHECKING, Any

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

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from .runtime_config import RuntimeConfig

_LOG_FORWARD_STREAM_LIMIT_BYTES = 1024 * 1024
_TRUNCATED_LINE_NOTICE = "[log line too large to forward; truncated]"
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
        config: RuntimeConfig,
        shutdown_event: asyncio.Event,
        log: Any,
        *,
        vnc_password: str | None,
    ) -> None:
        self.config = config
        self.shutdown_event = shutdown_event
        self.log = log
        self.repo_path = config.repo_path
        self.workdir = config.workspace_path
        self._vnc_password = vnc_password
        self.code_server_process: asyncio.subprocess.Process | None = None
        self.ttyd_process: asyncio.subprocess.Process | None = None
        self.ttyd_proxy_process: asyncio.subprocess.Process | None = None
        self.xvfb_process: asyncio.subprocess.Process | None = None
        self.fluxbox_process: asyncio.subprocess.Process | None = None
        self.x11vnc_process: asyncio.subprocess.Process | None = None
        self.novnc_process: asyncio.subprocess.Process | None = None

    def configure_workdir(self, workdir: Path) -> None:
        self.workdir = workdir

    def _opencode_workdir(self) -> Path:
        return self.workdir

    async def start_code_server(self) -> None:
        """Start code-server for browser-based VS Code editing."""
        password = os.environ.get("CODE_SERVER_PASSWORD")
        if not password:
            self.log.info("code_server.skip", reason="no_password")
            return

        workdir = self._opencode_workdir()

        code_server_port = _port_from_env(CODE_SERVER_PORT_ENV_VAR, CODE_SERVER_PORT)
        self.code_server_process = await asyncio.create_subprocess_exec(
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

    async def _iter_process_lines(
        self, stream: asyncio.StreamReader, *, error_event: str
    ) -> AsyncIterator[str]:
        """Yield decoded stdout lines from a child process, resiliently.

        ``async for line in stream`` reads through ``StreamReader.readline``,
        which raises (rather than returns) once a single line is larger than the
        stream buffer and then ends iteration for good, silently dropping every
        later line; an undecodable byte ends it just as permanently. This keeps
        going instead — an oversized line becomes a truncation notice and bad
        bytes are replaced — so forwarding survives for the life of the process.
        """
        while True:
            try:
                raw = await stream.readline()
            except ValueError:
                # Line exceeded the buffer limit. readline() has already dropped
                # the offending bytes, so flag the gap and keep forwarding.
                yield _TRUNCATED_LINE_NOTICE
                continue
            except Exception as e:
                # An unexpected reader failure (e.g. a closed transport) is
                # terminal for this stream — log once and stop.
                self.log.warn(error_event, exc=e)
                return
            if not raw:
                return  # EOF: the process closed its stdout.
            yield raw.decode("utf-8", errors="replace").rstrip()

    async def _forward_code_server_logs(self) -> None:
        """Forward code-server stdout to supervisor stdout."""
        if not self.code_server_process or not self.code_server_process.stdout:
            return
        async for line in self._iter_process_lines(
            self.code_server_process.stdout,
            error_event="code_server.log_forward_error",
        ):
            self.log.info("code_server.stdout", line=line)

    async def start_ttyd(self) -> None:
        """Start ttyd web terminal if TERMINAL_ENABLED is set."""
        if not os.environ.get("TERMINAL_ENABLED"):
            self.log.info("ttyd.skip", reason="TERMINAL_ENABLED not set")
            return

        workdir = (
            str(self.repo_path)
            if self.repo_path and (self.repo_path / ".git").exists()
            else "/workspace"
        )

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

        self.ttyd_process = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=workdir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=os.environ.copy(),
            limit=_LOG_FORWARD_STREAM_LIMIT_BYTES,
        )

        asyncio.create_task(self._forward_ttyd_logs())
        self.log.info("ttyd.started", pid=self.ttyd_process.pid)

    async def start_ttyd_proxy(self) -> None:
        """Start the JWT-authenticated reverse proxy in front of ttyd."""
        if not os.environ.get("TERMINAL_ENABLED"):
            return

        cmd = ["bun", "run", "/app/sandbox_runtime/ttyd_proxy/server.ts"]

        self.log.info(
            "ttyd_proxy.starting",
            port=_port_from_env(TTYD_PROXY_PORT_ENV_VAR, TTYD_PROXY_PORT),
        )

        self.ttyd_proxy_process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=os.environ.copy(),
            limit=_LOG_FORWARD_STREAM_LIMIT_BYTES,
        )

        asyncio.create_task(self._forward_ttyd_proxy_logs())
        self.log.info("ttyd_proxy.started", pid=self.ttyd_proxy_process.pid)

    async def _forward_ttyd_logs(self) -> None:
        """Forward ttyd stdout to supervisor stdout."""
        if not self.ttyd_process or not self.ttyd_process.stdout:
            return
        async for line in self._iter_process_lines(
            self.ttyd_process.stdout,
            error_event="ttyd.log_forward_error",
        ):
            self.log.info("ttyd.stdout", line=line)

    async def _forward_ttyd_proxy_logs(self) -> None:
        """Forward ttyd proxy stdout to supervisor stdout."""
        if not self.ttyd_proxy_process or not self.ttyd_proxy_process.stdout:
            return
        async for line in self._iter_process_lines(
            self.ttyd_proxy_process.stdout,
            error_event="ttyd_proxy.log_forward_error",
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
        self.xvfb_process = await asyncio.create_subprocess_exec(
            *xvfb_cmd,
            env=child_env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=_LOG_FORWARD_STREAM_LIMIT_BYTES,
        )
        asyncio.create_task(self._forward_vnc_logs("xvfb", self.xvfb_process))

        display_number = VNC_DISPLAY.removeprefix(":").split(".", maxsplit=1)[0]
        display_socket = Path(f"/tmp/.X11-unix/X{display_number}")
        if not await self._wait_for_path(display_socket, self.xvfb_process):
            raise RuntimeError("Xvfb failed to become ready")

        fluxbox_cmd = ["fluxbox"]
        self.fluxbox_process = await asyncio.create_subprocess_exec(
            *fluxbox_cmd,
            env=display_env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=_LOG_FORWARD_STREAM_LIMIT_BYTES,
        )
        asyncio.create_task(self._forward_vnc_logs("fluxbox", self.fluxbox_process))

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
        self.x11vnc_process = await asyncio.create_subprocess_exec(
            *x11vnc_cmd,
            env=display_env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=_LOG_FORWARD_STREAM_LIMIT_BYTES,
        )
        asyncio.create_task(self._forward_vnc_logs("x11vnc", self.x11vnc_process))
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
        self.novnc_process = await asyncio.create_subprocess_exec(
            *novnc_cmd,
            env=child_env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            limit=_LOG_FORWARD_STREAM_LIMIT_BYTES,
        )
        asyncio.create_task(self._forward_vnc_logs("novnc", self.novnc_process))
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
        async for line in self._iter_process_lines(
            process.stdout,
            error_event=f"{process_name}.log_forward_error",
        ):
            self.log.info(f"{process_name}.stdout", line=line)

    async def _stop_vnc(self) -> None:
        """Stop the VNC stack in reverse dependency order and remove its secret."""
        for process_name, process in (
            ("novnc", self.novnc_process),
            ("x11vnc", self.x11vnc_process),
            ("fluxbox", self.fluxbox_process),
            ("xvfb", self.xvfb_process),
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
            setattr(self, f"{process_name}_process", None)
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
        for process in (self.ttyd_proxy_process, self.ttyd_process, self.code_server_process):
            if process and process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=self.SIDECAR_TIMEOUT_SECONDS)
                except TimeoutError:
                    process.kill()
        await self._stop_vnc()

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import socket
import time
import uuid
from typing import TYPE_CHECKING, Any

from .constants import (
    BOOT_FAILURE_SHUTDOWN_GRACE_SECONDS,
    EXECUTION_READY_RESULT_TIMEOUT_SECONDS,
    LOCAL_CONTROL_SEND_TIMEOUT_SECONDS,
    OPENCODE_PORT,
)
from .process_output import iter_process_lines
from .runtime_config import SandboxControlProtocol

if TYPE_CHECKING:
    from .runtime_config import BridgeProcessConfig
    from .types import BootFailureCode, BootPhase

_LOG_FORWARD_STREAM_LIMIT_BYTES = 1024 * 1024


class BridgeStartupError(RuntimeError):
    """The bridge child exited before its startup probe completed."""


class LocalControlDeliveryError(RuntimeError):
    """A supervisor state update could not reach the active bridge child."""

    def __init__(self, message_type: str, reason: str) -> None:
        super().__init__(f"failed to deliver {message_type} to bridge: {reason}")
        self.message_type = message_type
        self.reason = reason


class ExecutionInitializationError(RuntimeError):
    """The bridge connected but could not initialize execution dependencies."""

    def __init__(self, code: str) -> None:
        super().__init__(f"bridge execution initialization failed: {code}")
        self.code = code


class AgentBridgeProcess:
    def __init__(self, config: BridgeProcessConfig, log: Any) -> None:
        self.log = log
        self.sandbox_id = config.sandbox_id
        self.control_plane_url = config.control_plane_url
        self.sandbox_token = config.sandbox_token
        self.session_id = config.session_id
        self.protocol = config.sandbox_control_protocol
        self._process: asyncio.subprocess.Process | None = None
        self._control_socket: socket.socket | None = None
        self._control_send_lock = asyncio.Lock()
        self._desired_state: dict[str, Any] | None = None
        self._local_reader_task: asyncio.Task[None] | None = None
        self._pending_results: dict[str, asyncio.Future[dict[str, Any]]] = {}

    async def start(self) -> None:
        self.log.info("bridge.start")
        if not self.control_plane_url:
            self.log.info("bridge.skip", reason="no_control_plane_url")
            return
        if not self.session_id:
            self.log.info("bridge.skip", reason="no_session_id")
            return

        parent_socket: socket.socket | None = None
        child_socket: socket.socket | None = None
        extra_args: list[str] = []
        pass_fds: tuple[int, ...] = ()
        if self.protocol is SandboxControlProtocol.V2:
            parent_socket, child_socket = socket.socketpair()
            parent_socket.setblocking(False)
            child_socket.setblocking(False)
            extra_args = [
                "--protocol",
                self.protocol.value,
                "--control-fd",
                str(child_socket.fileno()),
            ]
            pass_fds = (child_socket.fileno(),)

        try:
            process = await asyncio.create_subprocess_exec(
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
                *extra_args,
                env=os.environ,
                pass_fds=pass_fds,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                limit=_LOG_FORWARD_STREAM_LIMIT_BYTES,
            )
        except Exception:
            if parent_socket is not None:
                parent_socket.close()
            raise
        finally:
            if child_socket is not None:
                child_socket.close()
        self._process = process
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
            if parent_socket is not None:
                parent_socket.close()
            raise BridgeStartupError(f"Bridge exited during startup with status {exit_code}")
        await self._stop_local_reader()
        if self._control_socket is not None:
            self._control_socket.close()
        self._control_socket = parent_socket
        self._start_local_reader()
        asyncio.create_task(self._forward_logs())
        self.log.info("bridge.started")
        if self._desired_state is not None:
            await self._replay_desired_state()

    async def _send_local(self, message: dict[str, Any]) -> bool:
        if self._control_socket is None:
            if self._process is None:
                return False
            raise LocalControlDeliveryError(str(message.get("type")), "closed")
        payload = json.dumps(message, separators=(",", ":")).encode() + b"\n"
        async with self._control_send_lock:
            try:
                await asyncio.wait_for(
                    asyncio.get_running_loop().sock_sendall(self._control_socket, payload),
                    timeout=LOCAL_CONTROL_SEND_TIMEOUT_SECONDS,
                )
            except TimeoutError:
                raise LocalControlDeliveryError(str(message.get("type")), "timeout") from None
            except (BrokenPipeError, ConnectionError, OSError) as error:
                raise LocalControlDeliveryError(str(message.get("type")), "closed") from error
        return True

    def _start_local_reader(self) -> None:
        if self._control_socket is not None:
            self._local_reader_task = asyncio.create_task(self._local_control_reader())

    async def _stop_local_reader(self) -> None:
        if self._local_reader_task is not None:
            self._local_reader_task.cancel()
            await asyncio.gather(self._local_reader_task, return_exceptions=True)
            self._local_reader_task = None
        self._fail_pending_results("closed")

    async def _local_control_reader(self) -> None:
        if self._control_socket is None:
            return
        buffer = b""
        try:
            while True:
                chunk = await asyncio.get_running_loop().sock_recv(self._control_socket, 4096)
                if not chunk:
                    self._fail_pending_results("eof")
                    return
                buffer += chunk
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    try:
                        result = json.loads(line)
                    except json.JSONDecodeError:
                        self.log.warn("bridge.local_control_result_invalid")
                        continue
                    request_id = result.get("requestId")
                    future = self._pending_results.get(request_id)
                    if future is not None and not future.done():
                        future.set_result(result)
        except asyncio.CancelledError:
            raise
        except (ConnectionError, OSError):
            self._fail_pending_results("closed")

    def _fail_pending_results(self, reason: str) -> None:
        for future in self._pending_results.values():
            if not future.done():
                future.set_exception(LocalControlDeliveryError("result", reason))

    async def _send_and_wait_for_result(
        self, message: dict[str, Any], timeout_seconds: float
    ) -> dict[str, Any]:
        request_id = str(message["requestId"])
        future = asyncio.get_running_loop().create_future()
        self._pending_results[request_id] = future
        try:
            await self._send_local(message)
            try:
                return await asyncio.wait_for(future, timeout=timeout_seconds)
            except TimeoutError:
                raise LocalControlDeliveryError(
                    str(message.get("type")), "result_timeout"
                ) from None
        finally:
            self._pending_results.pop(request_id, None)

    async def _confirm_execution_ready(self, message: dict[str, Any]) -> bool:
        result = await self._send_and_wait_for_result(
            message, EXECUTION_READY_RESULT_TIMEOUT_SECONDS
        )
        if result.get("type") == "execution_initialization_failed":
            raise ExecutionInitializationError(str(result.get("code") or "unknown"))
        if result.get("type") != "execution_ready":
            raise LocalControlDeliveryError("execution_dependencies_ready", "invalid_result")
        return True

    async def _confirm_boot_failure(self, message: dict[str, Any]) -> None:
        result = await self._send_and_wait_for_result(message, BOOT_FAILURE_SHUTDOWN_GRACE_SECONDS)
        if result.get("type") != "boot_failure_reported":
            raise LocalControlDeliveryError("boot_failed", "invalid_result")

    async def _replay_desired_state(self) -> None:
        if self._desired_state is None:
            return
        message_type = self._desired_state.get("type")
        if message_type == "execution_dependencies_ready":
            await self._confirm_execution_ready(self._desired_state)
        elif message_type == "boot_failed":
            await self._confirm_boot_failure(self._desired_state)
        else:
            await self._send_local(self._desired_state)

    async def set_boot_phase(self, phase: BootPhase) -> bool:
        self._desired_state = {
            "type": "boot_phase",
            "phase": phase.value,
            "startedAt": time.time(),
        }
        return await self._send_local(self._desired_state)

    async def execution_dependencies_ready(self) -> bool:
        self._desired_state = {
            "type": "execution_dependencies_ready",
            "requestId": uuid.uuid4().hex,
        }
        return await self._confirm_execution_ready(self._desired_state)

    async def execution_dependencies_unavailable(self, phase: BootPhase) -> bool:
        self._desired_state = {
            "type": "execution_dependencies_unavailable",
            "phase": phase.value,
        }
        return await self._send_local(self._desired_state)

    async def boot_failed(self, code: BootFailureCode) -> None:
        self._desired_state = {
            "type": "boot_failed",
            "code": code.value,
            "requestId": uuid.uuid4().hex,
        }
        await self._confirm_boot_failure(self._desired_state)

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
        await self._stop_local_reader()
        if self._control_socket is not None:
            self._control_socket.close()
            self._control_socket = None

    def exit_code(self) -> int | None:
        return self._process.returncode if self._process else None

    def process_identity(self) -> object | None:
        return self._process

    def started(self) -> bool:
        return self._process is not None

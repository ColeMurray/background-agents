"""Bounded, full-duplex Codex app-server JSONL transport.

No credential frames or vendor error bodies are logged. A request is never
retried: a timeout after a write can mean the operation already executed.
Product policy, authentication and native turn projection belong to the harness.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import signal
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import TYPE_CHECKING, Any

from ...process_output import wait_for_process_exit

if TYPE_CHECKING:
    from pathlib import Path

MAX_FRAME_BYTES = 8 * 1024 * 1024
MAX_NOTIFICATIONS = 4096
# Aggregate cap on undelivered notification bytes. The reader cannot block
# (responses share the pipe), so a stalled consumer fails the transport instead.
MAX_QUEUED_NOTIFICATION_BYTES = 64 * 1024 * 1024
MAX_SERVER_REQUESTS = 64
RPC_TIMEOUT_SECONDS = 30.0
ServerRequestHandler = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]


class CodexTransportError(RuntimeError):
    """The pipe failed; delivery of a submitted request may be uncertain."""


class CodexRpcError(RuntimeError):
    """The server explicitly rejected an RPC. The raw body is intentionally omitted."""


class CodexClient:
    def __init__(
        self,
        *,
        command: Sequence[str],
        cwd: Path,
        env: Mapping[str, str],
        on_request: ServerRequestHandler | None = None,
        containment_owner: bool = False,
    ) -> None:
        self._command = tuple(command)
        self._cwd = cwd
        self._env = dict(env)
        self._on_request = on_request
        self._containment_owner = containment_owner
        self._process: asyncio.subprocess.Process | None = None
        self._spawn: asyncio.Future[asyncio.subprocess.Process] | None = None
        self._late_containment: asyncio.Task[None] | None = None
        self._reader: asyncio.Task[None] | None = None
        self._stderr: asyncio.Task[None] | None = None
        self._handlers: set[asyncio.Task[None]] = set()
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._notifications: asyncio.Queue[tuple[dict[str, Any], int] | None] = asyncio.Queue(
            MAX_NOTIFICATIONS
        )
        self._queued_bytes = 0
        self._write_lock = asyncio.Lock()
        self._sequence = 0
        self._failure: str | None = None
        self._close_task: asyncio.Task[bool] | None = None

    @property
    def handling_requests(self) -> bool:
        """Whether a host callback from the app-server is still running."""
        return bool(self._handlers)

    @property
    def running(self) -> bool:
        return self._process is not None and self._process.returncode is None and not self._failure

    async def open(self) -> None:
        if self._spawn is not None:
            raise CodexTransportError("Codex client is already open")
        # The pending spawn belongs to this client, so every close path joins it
        # and contains the process through the same subreaper protocol.
        self._spawn = asyncio.ensure_future(
            asyncio.create_subprocess_exec(
                *self._command,
                cwd=self._cwd,
                env=self._env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
                limit=MAX_FRAME_BYTES,
            )
        )
        try:
            process = await asyncio.shield(self._spawn)
        except asyncio.CancelledError:
            await self.close()
            raise
        if self._failure:
            # Closed while spawning; close() already contained the process.
            raise CodexTransportError(self._failure)
        self._process = process
        self._reader = asyncio.create_task(self._read(), name="codex-jsonl-reader")
        self._stderr = asyncio.create_task(self._drain_stderr(), name="codex-stderr-drain")

    async def request(
        self,
        method: str,
        params: dict[str, Any],
        *,
        timeout_seconds: float = RPC_TIMEOUT_SECONDS,
    ) -> dict[str, Any]:
        self._sequence += 1
        request_id = f"oi-{self._sequence}"
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            async with asyncio.timeout(timeout_seconds):
                await self._write({"id": request_id, "method": method, "params": params})
                return await future
        except TimeoutError:
            raise CodexTransportError(
                f"Codex {method} response timed out; outcome uncertain"
            ) from None
        finally:
            self._pending.pop(request_id, None)
            if not future.done():
                future.cancel()
            elif not future.cancelled():
                # Consume a concurrent reader failure when writing itself failed.
                future.exception()

    async def notify(self, method: str, params: dict[str, Any]) -> None:
        await self._write({"method": method, "params": params})

    async def next_notification(self) -> dict[str, Any]:
        if self._failure and self._notifications.empty():
            raise CodexTransportError(self._failure)
        item = await self._notifications.get()
        if item is None:
            raise CodexTransportError(self._failure or "Codex transport closed")
        frame, size = item
        self._queued_bytes -= size
        return frame

    async def _write(self, frame: dict[str, Any]) -> None:
        encoded = json.dumps(frame, separators=(",", ":")).encode() + b"\n"
        if len(encoded) > MAX_FRAME_BYTES:
            raise CodexTransportError("Codex request exceeds frame limit")
        async with self._write_lock:
            process = self._process
            if self._failure or process is None or process.stdin is None:
                raise CodexTransportError(self._failure or "Codex transport is not open")
            try:
                process.stdin.write(encoded)
                await process.stdin.drain()
            except (ConnectionError, BrokenPipeError):
                raise CodexTransportError("Codex input pipe closed") from None

    async def _read(self) -> None:
        assert self._process is not None and self._process.stdout is not None
        try:
            while line := await self._process.stdout.readline():
                if len(line) > MAX_FRAME_BYTES:
                    raise ValueError("frame size")
                frame = json.loads(line)
                if not isinstance(frame, dict):
                    raise ValueError("frame type")
                if "method" in frame:
                    if not isinstance(frame["method"], str) or not isinstance(
                        frame.get("params", {}), dict
                    ):
                        raise ValueError("method shape")
                    if "id" in frame:
                        if len(self._handlers) >= MAX_SERVER_REQUESTS:
                            raise ValueError("server request limit")
                        task = asyncio.create_task(
                            self._respond(frame), name="codex-server-request"
                        )
                        self._handlers.add(task)
                        task.add_done_callback(self._handlers.discard)
                    else:
                        if self._queued_bytes + len(line) > MAX_QUEUED_NOTIFICATION_BYTES:
                            raise ValueError("notification backlog")
                        self._notifications.put_nowait((frame, len(line)))
                        self._queued_bytes += len(line)
                elif "id" in frame:
                    future = self._pending.get(frame["id"])
                    if future is None or future.done():
                        continue
                    if "error" in frame:
                        future.set_exception(
                            CodexRpcError("Codex rejected the requested operation")
                        )
                    elif isinstance(frame.get("result"), dict):
                        future.set_result(frame["result"])
                    else:
                        raise ValueError("response shape")
                else:
                    raise ValueError("unknown frame")
            self._fail("Codex output pipe closed")
        except asyncio.CancelledError:
            raise
        except Exception:
            self._fail("Codex emitted an invalid or excessive protocol frame")

    async def _respond(self, frame: dict[str, Any]) -> None:
        try:
            if self._on_request is None:
                reply = {"error": {"code": -32601, "message": "Unsupported host request"}}
            else:
                reply = {"result": await self._on_request(frame["method"], frame.get("params", {}))}
        except asyncio.CancelledError:
            return
        except Exception:
            reply = {"error": {"code": -32603, "message": "Host request failed"}}
        with contextlib.suppress(CodexTransportError):
            await self._write({"id": frame["id"], **reply})

    async def _drain_stderr(self) -> None:
        assert self._process is not None and self._process.stderr is not None
        # Drain without retention: native diagnostics may contain secrets or
        # model/tool content. We report sanitized protocol-stage failures only.
        while await self._process.stderr.read(8192):
            pass

    def _fail(self, message: str) -> None:
        self._failure = self._failure or message
        for future in self._pending.values():
            if not future.done():
                future.set_exception(CodexTransportError(self._failure))
        with contextlib.suppress(asyncio.QueueFull):
            self._notifications.put_nowait(None)

    async def _contain_late_spawn(self, spawn: asyncio.Future[asyncio.subprocess.Process]) -> None:
        try:
            process = await spawn
        except Exception:
            return
        self._process = process
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGTERM)
        try:
            await asyncio.wait_for(wait_for_process_exit(process), 5.0)
        except TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            await wait_for_process_exit(process)

    async def close(self, *, timeout_seconds: float = 5.0) -> bool:
        # A caller's cancellation must not strand the owned process. Concurrent
        # stop paths share one bounded cleanup operation.
        if self._close_task is None or self._close_task.done():
            self._close_task = asyncio.create_task(self._close_owned(timeout_seconds))
        try:
            async with asyncio.timeout(max(0, timeout_seconds)):
                return await asyncio.shield(self._close_task)
        except TimeoutError:
            return False

    async def _close_owned(self, timeout_seconds: float) -> bool:
        deadline = asyncio.get_running_loop().time() + max(0, timeout_seconds)
        self._fail("Codex transport closed")
        tasks = [
            *self._handlers,
            *([self._reader] if self._reader else []),
        ]
        for task in tasks:
            task.cancel()
        if self._process is None and self._spawn is not None:
            # An unpublished process is not proof that no process exists.
            with contextlib.suppress(Exception):
                self._process = await asyncio.wait_for(
                    asyncio.shield(self._spawn),
                    max(0.001, deadline - asyncio.get_running_loop().time()),
                )
            if not self._spawn.done():
                # Report containment as unconfirmed, but keep ownership: the
                # process is contained whenever the spawn finally completes.
                if self._late_containment is None:
                    self._late_containment = asyncio.create_task(
                        self._contain_late_spawn(self._spawn), name="codex-late-containment"
                    )
                return False
        process = self._process
        stopped = process is None
        if process is not None:
            if process.stdin:
                process.stdin.close()
            if process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGTERM)
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(
                        wait_for_process_exit(process), max(0, timeout_seconds * 0.85)
                    )
            # A successful subreaper exit already proves containment. Do not
            # signal a no-longer-owned (potentially recycled) group identifier.
            if process.returncode is None or not self._containment_owner:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
            try:
                await asyncio.wait_for(
                    wait_for_process_exit(process),
                    max(0.001, deadline - asyncio.get_running_loop().time()),
                )
                stopped = not self._containment_owner or process.returncode == 0
            except TimeoutError:
                stopped = False
        if tasks:
            _done, pending = await asyncio.wait(
                tasks, timeout=max(0, deadline - asyncio.get_running_loop().time())
            )
            # A host callback still executing may have external side effects.
            # Do not claim containment until those callbacks stop too.
            stopped = stopped and not pending
        if self._stderr:
            self._stderr.cancel()
            await asyncio.gather(self._stderr, return_exceptions=True)
        return stopped

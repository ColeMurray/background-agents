"""Resilient decoding for child-process output streams."""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Awaitable, Callable

TRUNCATED_LINE_NOTICE = "[log line too large to forward; truncated]"
PROCESS_OUTPUT_TAIL_BYTES = 64 * 1024


class BoundedOutputCollector:
    """Continuously drain a stream while retaining only a bounded byte tail."""

    def __init__(
        self,
        stream: asyncio.StreamReader,
        *,
        max_tail_bytes: int = PROCESS_OUTPUT_TAIL_BYTES,
    ) -> None:
        if max_tail_bytes <= 0:
            raise ValueError("max_tail_bytes must be positive")
        self._stream = stream
        self._max_tail_bytes = max_tail_bytes
        self._tail = bytearray()
        self._retaining = True
        self.task = asyncio.create_task(self._drain())

    async def _drain(self) -> None:
        while chunk := await self._stream.read(16 * 1024):
            if not self._retaining:
                continue
            self._tail.extend(chunk)
            overflow = len(self._tail) - self._max_tail_bytes
            if overflow > 0:
                del self._tail[:overflow]

    async def wait(self) -> None:
        """Wait until every writer has closed the stream."""
        await self.task

    def discard_tail(self) -> None:
        """Continue draining without retaining output."""
        self._retaining = False
        self._tail.clear()

    def tail_lines(self, max_lines: int = 50) -> str:
        """Decode and return at most the requested final lines."""
        return "\n".join(bytes(self._tail).decode(errors="replace").splitlines()[-max_lines:])


async def wait_for_process_exit(process: asyncio.subprocess.Process) -> int:
    """Wait for the process leader without waiting for inherited output pipes to close."""
    wait_task = asyncio.create_task(process.wait())
    try:
        await asyncio.sleep(0)
        while process.returncode is None:
            if wait_task.done():
                return wait_task.result()
            await asyncio.sleep(0.01)
        return process.returncode
    finally:
        if not wait_task.done():
            wait_task.cancel()
        await asyncio.gather(wait_task, return_exceptions=True)


async def terminate_owned_subprocess(
    process: asyncio.subprocess.Process,
    *,
    kill_process_group: Callable[[int, int], None] = os.killpg,
    terminate_grace_seconds: float = 0,
) -> None:
    """Kill a child-owned process group and reap its leader."""
    process_id = getattr(process, "pid", None)

    def send_signal(sig: int) -> None:
        with contextlib.suppress(ProcessLookupError):
            if isinstance(process_id, int):
                kill_process_group(process_id, sig)
            elif process.returncode is None:
                if sig == signal.SIGTERM:
                    process.terminate()
                else:
                    process.kill()

    try:
        if terminate_grace_seconds > 0:
            send_signal(signal.SIGTERM)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(process.wait(), timeout=terminate_grace_seconds)
    finally:
        # The leader may have exited while descendants still hold its output pipes.
        send_signal(signal.SIGKILL)
        await asyncio.shield(process.wait())


async def finish_cancellation_cleanup[ResultT](task: asyncio.Task[ResultT]) -> ResultT:
    """Finish an independent cleanup task despite repeated caller cancellation."""
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            continue
    return task.result()


async def spawn_owned_subprocess(
    process_factory: Callable[[], Awaitable[asyncio.subprocess.Process]],
    *,
    kill_process_group: Callable[[int, int], None] = os.killpg,
) -> asyncio.subprocess.Process:
    """Create a subprocess or clean it up before propagating cancellation."""

    async def spawn() -> asyncio.subprocess.Process:
        return await process_factory()

    spawn_task = asyncio.create_task(spawn())
    try:
        return await asyncio.shield(spawn_task)
    except asyncio.CancelledError:

        async def cleanup_spawned_process() -> None:
            try:
                process = await spawn_task
            except (asyncio.CancelledError, Exception):
                return
            await terminate_owned_subprocess(
                process,
                kill_process_group=kill_process_group,
            )

        cleanup_task = asyncio.create_task(cleanup_spawned_process())
        await finish_cancellation_cleanup(cleanup_task)
        raise


async def communicate_owned_subprocess(
    process: asyncio.subprocess.Process,
    *,
    kill_process_group: Callable[[int, int], None] = os.killpg,
    terminate_grace_seconds: float = 0,
) -> tuple[bytes, bytes]:
    """Communicate with a child, cleaning up its process group on failure."""
    try:
        stdout, stderr = await process.communicate()
        return stdout or b"", stderr or b""
    except (asyncio.CancelledError, Exception):
        await terminate_owned_subprocess(
            process,
            kill_process_group=kill_process_group,
            terminate_grace_seconds=terminate_grace_seconds,
        )
        raise


async def iter_process_lines(
    stream: asyncio.StreamReader,
    *,
    on_error: Callable[[Exception], None],
) -> AsyncIterator[str]:
    """Yield decoded lines while surviving oversized and malformed output."""
    while True:
        try:
            raw = await stream.readline()
        except ValueError:
            yield TRUNCATED_LINE_NOTICE
            continue
        except Exception as error:
            on_error(error)
            return
        if not raw:
            return
        yield raw.decode("utf-8", errors="replace").rstrip()

"""Resilient decoding for child-process output streams."""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Callable

TRUNCATED_LINE_NOTICE = "[log line too large to forward; truncated]"


async def terminate_owned_subprocess(
    process: asyncio.subprocess.Process,
    *,
    kill_process_group: Callable[[int, int], None] = os.killpg,
) -> None:
    """Kill a child-owned process group and reap its leader."""
    if process.returncode is None:
        process_id = getattr(process, "pid", None)
        if isinstance(process_id, int):
            with contextlib.suppress(ProcessLookupError):
                kill_process_group(process_id, signal.SIGKILL)
        else:
            process.kill()
    await asyncio.shield(process.wait())


async def communicate_owned_subprocess(
    process: asyncio.subprocess.Process,
    *,
    kill_process_group: Callable[[int, int], None] = os.killpg,
) -> tuple[bytes, bytes]:
    """Communicate with a child and terminate its process group if cancelled."""
    try:
        stdout, stderr = await process.communicate()
        return stdout or b"", stderr or b""
    except asyncio.CancelledError:
        await terminate_owned_subprocess(process, kill_process_group=kill_process_group)
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

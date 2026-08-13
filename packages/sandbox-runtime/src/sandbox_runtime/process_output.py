"""Resilient decoding for child-process output streams."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import asyncio
    from collections.abc import AsyncIterator, Callable

TRUNCATED_LINE_NOTICE = "[log line too large to forward; truncated]"


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

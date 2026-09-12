"""Translate process shutdown signals into the bridge's bounded async lifecycle."""

from __future__ import annotations

import asyncio
import contextlib
import signal
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .bridge import AgentBridge

# Leave room before AgentBridgeProcess's hard process-kill fallback. This is
# one end-to-end bound, not a new allowance for every shutdown resource.
BRIDGE_SIGNAL_CLEANUP_SECONDS = 4.0


async def run_bridge_with_signals(bridge: AgentBridge) -> None:
    """Keep Python alive for cleanup on SIGTERM/SIGINT, including during boot."""
    loop = asyncio.get_running_loop()
    installed: list[signal.Signals] = []

    def shutdown() -> None:
        bridge.request_shutdown(cleanup_seconds=BRIDGE_SIGNAL_CLEANUP_SECONDS)

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, shutdown)
        installed.append(sig)
    run_task = asyncio.create_task(bridge.run())
    shutdown_task = asyncio.create_task(bridge.shutdown_event.wait())
    try:
        done, _ = await asyncio.wait({run_task, shutdown_task}, return_when=asyncio.FIRST_COMPLETED)
        if shutdown_task in done and not run_task.done():
            # Wake a blocked websocket receive, reconnect delay or startup
            # operation so run() reaches its finally. The prompt task has its
            # own coordinator and receives graceful Stop, not this cancellation.
            run_task.cancel()
        try:
            await run_task
        except asyncio.CancelledError:
            if not bridge.shutdown_event.is_set():
                raise
    finally:
        shutdown_task.cancel()
        if not run_task.done():
            shutdown()
            run_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await run_task
        for sig in installed:
            loop.remove_signal_handler(sig)

"""Application-level deadlines for Modal SDK lifecycle calls."""

import asyncio
from collections.abc import Awaitable

MODAL_SANDBOX_CREATE_TIMEOUT_SECONDS = 300
MODAL_SANDBOX_RPC_TIMEOUT_SECONDS = 30
MODAL_SANDBOX_TERMINATE_TIMEOUT_SECONDS = 60


async def await_modal_call[T](
    awaitable: Awaitable[T], *, operation: str, timeout_seconds: float
) -> T:
    try:
        return await asyncio.wait_for(awaitable, timeout=timeout_seconds)
    except TimeoutError as exc:
        raise TimeoutError(
            f"Modal {operation} timed out after {timeout_seconds:g} seconds"
        ) from exc

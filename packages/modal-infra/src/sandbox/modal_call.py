"""Application-level deadlines for Modal SDK lifecycle calls."""

import asyncio
from collections.abc import Awaitable
from contextlib import suppress
from functools import partial
from typing import Any

import modal

MODAL_SANDBOX_CREATE_TIMEOUT_SECONDS = 300
MODAL_CREATE_RECONCILIATION_ATTEMPTS = 3
MODAL_CREATE_RECONCILIATION_BACKOFF_SECONDS = 1
MODAL_SANDBOX_RPC_TIMEOUT_SECONDS = 30
MODAL_SANDBOX_TERMINATE_TIMEOUT_SECONDS = 60


class ModalCallTimeoutError(TimeoutError):
    """A Modal SDK operation exceeded its application-level deadline."""


def _consume_task_result(task: asyncio.Future[Any]) -> None:
    with suppress(asyncio.CancelledError):
        task.exception()


async def await_modal_call[T](
    awaitable: Awaitable[T], *, operation: str, timeout_seconds: float
) -> T:
    task = asyncio.ensure_future(awaitable)
    try:
        done, _pending = await asyncio.wait({task}, timeout=timeout_seconds)
    except BaseException:
        task.cancel()
        task.add_done_callback(_consume_task_result)
        raise
    if task in done:
        return task.result()

    task.cancel()
    task.add_done_callback(_consume_task_result)
    raise ModalCallTimeoutError(
        f"Modal {operation} deadline exceeded after {timeout_seconds:g} seconds"
    )


async def _find_sandbox_by_tags(tags: dict[str, str]) -> modal.Sandbox | None:
    async def first_match() -> modal.Sandbox | None:
        async for sandbox in modal.Sandbox.list.aio(tags=tags):
            return sandbox
        return None

    return await await_modal_call(
        first_match(),
        operation="sandbox creation reconciliation",
        timeout_seconds=MODAL_SANDBOX_RPC_TIMEOUT_SECONDS,
    )


def _terminate_late_sandbox(
    create_task: asyncio.Future[modal.Sandbox], *, keep_object_id: str | None = None
) -> bool:
    try:
        sandbox = create_task.result()
    except BaseException:
        return False
    if sandbox.object_id == keep_object_id:
        return True

    async def cleanup() -> None:
        await await_modal_call(
            sandbox.terminate.aio(wait=False),
            operation="late sandbox cleanup",
            timeout_seconds=MODAL_SANDBOX_TERMINATE_TIMEOUT_SECONDS,
        )

    cleanup_task = asyncio.create_task(cleanup())
    cleanup_task.add_done_callback(_consume_task_result)
    return True


def _completed_create_result(
    create_task: asyncio.Future[modal.Sandbox],
) -> modal.Sandbox | None:
    if not create_task.done() or create_task.cancelled():
        return None
    try:
        return create_task.result()
    except Exception:
        return None


async def _terminate_sandbox_by_tags(tags: dict[str, str]) -> None:
    for attempt in range(MODAL_CREATE_RECONCILIATION_ATTEMPTS):
        await asyncio.sleep(MODAL_CREATE_RECONCILIATION_BACKOFF_SECONDS * (attempt + 1))
        try:
            sandbox = await _find_sandbox_by_tags(tags)
        except Exception:
            continue
        if sandbox is None:
            continue
        try:
            await await_modal_call(
                sandbox.terminate.aio(wait=False),
                operation="reconciled sandbox cleanup",
                timeout_seconds=MODAL_SANDBOX_TERMINATE_TIMEOUT_SECONDS,
            )
        except Exception:
            continue
        else:
            return


def _schedule_ambiguous_create_cleanup(
    create_task: asyncio.Future[modal.Sandbox], tags: dict[str, str]
) -> None:
    reconciliation_task = asyncio.create_task(_terminate_sandbox_by_tags(tags))
    reconciliation_task.add_done_callback(_consume_task_result)

    def terminate_result(task: asyncio.Future[modal.Sandbox]) -> None:
        if _terminate_late_sandbox(task):
            reconciliation_task.cancel()

    create_task.add_done_callback(terminate_result)


async def create_modal_sandbox(
    awaitable: Awaitable[modal.Sandbox],
    *,
    operation: str,
    tags: dict[str, str],
    timeout_seconds: float,
) -> modal.Sandbox:
    """Create a sandbox and reconcile an accepted create after an ambiguous deadline."""
    create_task = asyncio.ensure_future(awaitable)
    try:
        return await await_modal_call(
            asyncio.shield(create_task),
            operation=operation,
            timeout_seconds=timeout_seconds,
        )
    except asyncio.CancelledError:
        _schedule_ambiguous_create_cleanup(create_task, tags)
        raise
    except ModalCallTimeoutError:
        completed_sandbox = _completed_create_result(create_task)
        if completed_sandbox is not None:
            return completed_sandbox
        try:
            sandbox = await _find_sandbox_by_tags(tags)
        except asyncio.CancelledError:
            _schedule_ambiguous_create_cleanup(create_task, tags)
            raise
        except Exception:
            sandbox = None
        completed_sandbox = _completed_create_result(create_task)
        if completed_sandbox is not None:
            return completed_sandbox
        if sandbox is not None:
            create_task.add_done_callback(
                partial(_terminate_late_sandbox, keep_object_id=sandbox.object_id)
            )
            return sandbox

        _schedule_ambiguous_create_cleanup(create_task, tags)
        raise

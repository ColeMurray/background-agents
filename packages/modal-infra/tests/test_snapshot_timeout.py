"""Tests for Modal filesystem snapshot timeout configuration."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from modal.exception import NotFoundError as ModalNotFoundError

from sandbox_runtime.types import SandboxStatus
from src.sandbox.manager import (
    SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS,
    SandboxHandle,
    SandboxManager,
)


def _async_method(return_value=None):
    method = MagicMock()
    method.aio = AsyncMock(return_value=return_value)
    return method


@pytest.mark.asyncio
async def test_take_snapshot_passes_explicit_timeout():
    """Session snapshots should not rely on Modal's short default timeout."""
    image = SimpleNamespace(object_id="im-session")
    snapshot_filesystem = _async_method(image)
    handle = SandboxHandle(
        sandbox_id="sandbox-1",
        modal_sandbox=SimpleNamespace(snapshot_filesystem=snapshot_filesystem),
        status=SandboxStatus.READY,
        created_at=0,
    )

    image_id = await SandboxManager().take_snapshot(handle)

    assert image_id == "im-session"
    snapshot_filesystem.assert_not_called()
    snapshot_filesystem.aio.assert_awaited_once_with(timeout=SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS)


@pytest.mark.asyncio
async def test_get_sandbox_by_id_awaits_async_lookup(monkeypatch):
    modal_sandbox = SimpleNamespace()
    from_id = _async_method(modal_sandbox)
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.from_id", from_id)

    handle = await SandboxManager().get_sandbox_by_id("sandbox-1")

    assert handle is not None
    assert handle.modal_sandbox is modal_sandbox
    from_id.assert_not_called()
    from_id.aio.assert_awaited_once_with("sandbox-1")


@pytest.mark.asyncio
@pytest.mark.parametrize("budget, expected", [(179.8, 179), (500, 300)])
async def test_take_snapshot_bounds_whole_second_timeout(budget, expected):
    snapshot_filesystem = _async_method(SimpleNamespace(object_id="im-session"))
    handle = SandboxHandle(
        sandbox_id="sandbox-1",
        modal_sandbox=SimpleNamespace(snapshot_filesystem=snapshot_filesystem),
        status=SandboxStatus.READY,
        created_at=0,
    )

    await SandboxManager().take_snapshot(handle, timeout_seconds=budget)

    snapshot_filesystem.aio.assert_awaited_once_with(timeout=expected)


@pytest.mark.asyncio
async def test_take_snapshot_rejects_subsecond_budget_without_provider_call():
    snapshot_filesystem = _async_method()
    handle = SandboxHandle(
        sandbox_id="sandbox-1",
        modal_sandbox=SimpleNamespace(snapshot_filesystem=snapshot_filesystem),
        status=SandboxStatus.READY,
        created_at=0,
    )

    with pytest.raises(TimeoutError):
        await SandboxManager().take_snapshot(handle, timeout_seconds=0.5)

    snapshot_filesystem.aio.assert_not_awaited()


@pytest.mark.asyncio
async def test_stop_sandbox_waits_for_provider_termination(monkeypatch):
    terminate = _async_method()
    modal_sandbox = SimpleNamespace(terminate=terminate)
    from_id = _async_method(modal_sandbox)
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.from_id", from_id)

    await SandboxManager().stop_sandbox("sandbox-1")

    from_id.aio.assert_awaited_once_with("sandbox-1")
    terminate.aio.assert_awaited_once_with(wait=True)


@pytest.mark.asyncio
async def test_stop_sandbox_succeeds_when_provider_object_is_already_absent(monkeypatch):
    from_id = _async_method()
    from_id.aio.side_effect = ModalNotFoundError("sandbox not found")
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.from_id", from_id)

    await SandboxManager().stop_sandbox("sandbox-1")

    from_id.aio.assert_awaited_once_with("sandbox-1")


@pytest.mark.asyncio
async def test_stop_sandbox_succeeds_when_object_disappears_during_termination(monkeypatch):
    terminate = _async_method()
    terminate.aio.side_effect = ModalNotFoundError("sandbox disappeared")
    from_id = _async_method(SimpleNamespace(terminate=terminate))
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.from_id", from_id)

    await SandboxManager().stop_sandbox("sandbox-1")

    terminate.aio.assert_awaited_once_with(wait=True)


@pytest.mark.asyncio
async def test_stop_sandbox_propagates_unrelated_provider_failure(monkeypatch):
    terminate = _async_method()
    terminate.aio.side_effect = RuntimeError("provider unavailable")
    from_id = _async_method(SimpleNamespace(terminate=terminate))
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.from_id", from_id)

    with pytest.raises(RuntimeError, match="provider unavailable"):
        await SandboxManager().stop_sandbox("sandbox-1")


@pytest.mark.asyncio
async def test_stop_sandbox_propagates_explicit_cancellation(monkeypatch):
    terminate = _async_method()
    terminate.aio.side_effect = asyncio.CancelledError
    from_id = _async_method(SimpleNamespace(terminate=terminate))
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.from_id", from_id)

    with pytest.raises(asyncio.CancelledError):
        await SandboxManager().stop_sandbox("sandbox-1")

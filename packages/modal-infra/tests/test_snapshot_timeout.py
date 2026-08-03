"""Tests for Modal filesystem snapshot timeout configuration."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

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

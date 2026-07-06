"""Tests for Modal filesystem snapshot timeout configuration."""

from types import SimpleNamespace
from unittest.mock import MagicMock

from sandbox_runtime.types import SandboxStatus
from src.sandbox.manager import (
    SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS,
    SandboxHandle,
    SandboxManager,
)


def test_take_snapshot_passes_explicit_timeout_and_no_ttl():
    """Session snapshots must not rely on Modal's short default timeout, and
    must pin ttl=None: Modal 1.5 gave snapshots a 30-day default TTL with GC,
    which would silently expire snapshots of long-idle sessions."""
    image = SimpleNamespace(object_id="im-session")
    snapshot_filesystem = MagicMock(return_value=image)
    handle = SandboxHandle(
        sandbox_id="sandbox-1",
        modal_sandbox=SimpleNamespace(snapshot_filesystem=snapshot_filesystem),
        status=SandboxStatus.READY,
        created_at=0,
    )

    image_id = SandboxManager().take_snapshot(handle)

    assert image_id == "im-session"
    snapshot_filesystem.assert_called_once_with(
        timeout=SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS, ttl=None
    )

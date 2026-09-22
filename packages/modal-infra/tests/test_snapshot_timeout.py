"""Tests for Modal filesystem snapshot timeout configuration."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from modal.exception import NotFoundError as ModalNotFoundError

from sandbox_runtime.docker_control import CONTROL_TIMEOUT_SECONDS
from sandbox_runtime.types import SandboxStatus
from src.sandbox.launch_policy import docker_allocation_tags
from src.sandbox.manager import (
    SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS,
    SandboxHandle,
    SandboxManager,
)


@pytest.mark.asyncio
async def test_pending_vm_reference_recovers_owned_allocation(monkeypatch):
    sandbox = SimpleNamespace(
        object_id="sb-owned",
        get_tags=_async_method(docker_allocation_tags("session", "generation")),
    )
    lookup = _async_method(sandbox)
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.from_name", lookup)
    handle = await SandboxManager().get_sandbox_by_id('modal-vm-session:["session","generation"]')
    assert handle is not None and handle.modal_sandbox is sandbox
    assert handle.sandbox_backend == "modal-vm"


@pytest.mark.asyncio
async def test_pending_vm_reference_never_confirms_absence(monkeypatch):
    monkeypatch.setattr(
        "src.sandbox.terminal_snapshot.recorded_vm_source", AsyncMock(return_value=None)
    )
    lookup = _async_method()
    lookup.aio.side_effect = ModalNotFoundError("not visible yet")
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.from_name", lookup)
    with pytest.raises(RuntimeError, match="not yet visible"):
        await SandboxManager().stop_sandbox('modal-vm-session:["session","generation"]')


@pytest.mark.asyncio
async def test_pending_vm_reference_cannot_stop_another_generation(monkeypatch):
    monkeypatch.setattr(
        "src.sandbox.terminal_snapshot.recorded_vm_source", AsyncMock(return_value=None)
    )
    sandbox = SimpleNamespace(
        object_id="sb-owned",
        get_tags=_async_method(docker_allocation_tags("session", "other")),
        terminate=_async_method(),
    )
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.from_name", _async_method(sandbox))
    with pytest.raises(RuntimeError, match="ownership mismatch"):
        await SandboxManager().stop_sandbox('modal-vm-session:["session","generation"]')
    sandbox.terminate.aio.assert_not_awaited()


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
    modal_sandbox = SimpleNamespace(object_id="sb-owned", get_tags=_async_method({}))
    from_id = _async_method(modal_sandbox)
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.from_id", from_id)

    handle = await SandboxManager().get_sandbox_by_id("sandbox-1")

    assert handle is not None
    assert handle.modal_sandbox is modal_sandbox
    assert handle.modal_object_id == "sb-owned"
    from_id.assert_not_called()
    from_id.aio.assert_awaited_once_with("sandbox-1")


@pytest.mark.asyncio
async def test_tag_lookup_failure_is_not_sandbox_absence(monkeypatch):
    tags = _async_method()
    tags.aio.side_effect = RuntimeError("tag service unavailable")
    monkeypatch.setattr(
        "src.sandbox.manager.modal.Sandbox.from_id",
        _async_method(SimpleNamespace(object_id="sb-owned", get_tags=tags)),
    )
    with pytest.raises(RuntimeError, match="tag service unavailable"):
        await SandboxManager().get_sandbox_by_id("sandbox-1")


@pytest.mark.asyncio
async def test_unknown_backend_tag_is_explicitly_rejected(monkeypatch):
    monkeypatch.setattr(
        "src.sandbox.manager.modal.Sandbox.from_id",
        _async_method(
            SimpleNamespace(
                object_id="sb-owned", get_tags=_async_method({"openinspect_backend": "unknown"})
            )
        ),
    )
    with pytest.raises(ValueError, match="Unknown sandbox backend tag"):
        await SandboxManager().get_sandbox_by_id("sandbox-1")


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


@pytest.mark.asyncio
@pytest.mark.parametrize("exit_code", [0, 1])
async def test_vm_capture_requires_docker_preparation(exit_code):
    process = SimpleNamespace(wait=_async_method(exit_code))
    execute = _async_method(process)
    snapshot = _async_method(SimpleNamespace(object_id="im-vm"))
    handle = SandboxHandle(
        sandbox_id="sb-vm",
        sandbox_backend="modal-vm",
        status=SandboxStatus.READY,
        created_at=0,
        modal_sandbox=SimpleNamespace(exec=execute, snapshot_filesystem=snapshot),
    )
    if exit_code:
        with pytest.raises(RuntimeError, match="preparation"):
            await SandboxManager().take_snapshot(handle)
        snapshot.aio.assert_not_awaited()
    else:
        assert await SandboxManager().take_snapshot(handle) == "im-vm"
        snapshot.aio.assert_awaited_once()
    assert execute.aio.call_args.args == (
        "python",
        "-m",
        "sandbox_runtime.docker_control",
        "prepare",
    )
    assert execute.aio.call_args.kwargs["timeout"] == CONTROL_TIMEOUT_SECONDS


@pytest.mark.asyncio
@pytest.mark.parametrize("elapsed", [9, 10])
async def test_vm_preparation_consumes_capture_budget(monkeypatch, elapsed):
    clock = SimpleNamespace(time=lambda: 1000, monotonic=lambda: 0)
    monkeypatch.setattr("src.sandbox.manager.time", clock)

    async def prepare():
        clock.monotonic = lambda: elapsed
        return 0

    wait = _async_method()
    wait.aio.side_effect = prepare
    snapshot = _async_method(SimpleNamespace(object_id="im-vm"))
    handle = SandboxHandle(
        sandbox_id="sb-vm",
        sandbox_backend="modal-vm",
        status=SandboxStatus.READY,
        created_at=0,
        modal_sandbox=SimpleNamespace(
            exec=_async_method(SimpleNamespace(wait=wait)), snapshot_filesystem=snapshot
        ),
    )
    if elapsed == 10:
        with pytest.raises(TimeoutError):
            await SandboxManager().take_snapshot(handle, timeout_seconds=10)
        snapshot.aio.assert_not_awaited()
    else:
        await SandboxManager().take_snapshot(handle, timeout_seconds=10)
        snapshot.aio.assert_awaited_once_with(timeout=1)

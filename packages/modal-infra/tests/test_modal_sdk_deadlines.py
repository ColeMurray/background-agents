"""Outer deadlines for Modal SDK lifecycle operations."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.sandbox.build_session import ModalBuildSessionService
from src.sandbox.manager import SandboxConfig, SandboxManager
from src.sandbox.modal_call import (
    ModalCallTimeoutError,
    await_modal_call,
    create_modal_sandbox,
)

TEST_TIMEOUT_SECONDS = 0.01


def _never_settling_method(cancelled: asyncio.Event | None = None) -> MagicMock:
    async def never_settles(*_args, **_kwargs):
        try:
            await asyncio.Event().wait()
        finally:
            if cancelled is not None:
                cancelled.set()

    method = MagicMock()
    method.aio = AsyncMock(side_effect=never_settles)
    return method


def _late_create_method() -> tuple[MagicMock, asyncio.Event, asyncio.Event]:
    release_create = asyncio.Event()
    terminated = asyncio.Event()

    async def late_create(*_args, **_kwargs):
        await release_create.wait()
        terminate = MagicMock()
        terminate.aio = AsyncMock(side_effect=lambda **_kwargs: terminated.set())
        return SimpleNamespace(object_id="late-sandbox", terminate=terminate)

    method = MagicMock()
    method.aio = AsyncMock(side_effect=late_create)
    return method, release_create, terminated


def _patch_sandbox_list(monkeypatch, sandboxes=()) -> None:
    async def list_aio(**_kwargs):
        for sandbox in sandboxes:
            yield sandbox

    sandbox_list = MagicMock()
    sandbox_list.aio = list_aio
    monkeypatch.setattr("src.sandbox.modal_call.modal.Sandbox.list", sandbox_list)


@pytest.mark.asyncio
async def test_deadline_does_not_wait_for_cancellation_cleanup():
    cancellation_started = asyncio.Event()
    release_cleanup = asyncio.Event()

    async def suppresses_cancellation():
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancellation_started.set()
            await release_cleanup.wait()

    loop = asyncio.get_running_loop()
    started = loop.time()
    with pytest.raises(ModalCallTimeoutError, match="Modal test operation deadline exceeded"):
        await await_modal_call(
            suppresses_cancellation(),
            operation="test operation",
            timeout_seconds=TEST_TIMEOUT_SECONDS,
        )

    assert loop.time() - started < 0.1
    await asyncio.wait_for(cancellation_started.wait(), timeout=0.1)
    release_cleanup.set()
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_sdk_timeout_error_is_not_rewritten():
    async def sdk_timeout():
        raise TimeoutError("SDK timeout")

    with pytest.raises(TimeoutError, match="SDK timeout") as exc_info:
        await await_modal_call(
            sdk_timeout(), operation="test operation", timeout_seconds=TEST_TIMEOUT_SECONDS
        )

    assert not isinstance(exc_info.value, ModalCallTimeoutError)


@pytest.mark.asyncio
async def test_interactive_create_times_out_and_cleans_up_late_sdk_result(monkeypatch):
    create, release_create, terminated = _late_create_method()
    _patch_sandbox_list(monkeypatch)
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", create)
    monkeypatch.setattr(
        "src.sandbox.manager.MODAL_SANDBOX_CREATE_TIMEOUT_SECONDS", TEST_TIMEOUT_SECONDS
    )

    with pytest.raises(ModalCallTimeoutError, match="Modal sandbox creation deadline exceeded"):
        await SandboxManager().create_sandbox(SandboxConfig(repo_owner="acme", repo_name="repo"))

    release_create.set()
    await asyncio.wait_for(terminated.wait(), timeout=0.1)


@pytest.mark.asyncio
async def test_build_create_times_out_independently_of_sandbox_lifetime(monkeypatch):
    create, release_create, terminated = _late_create_method()
    _patch_sandbox_list(monkeypatch)
    monkeypatch.setattr("src.sandbox.build_session.modal.Sandbox.create", create)
    monkeypatch.setattr(
        "src.sandbox.build_session.MODAL_SANDBOX_CREATE_TIMEOUT_SECONDS", TEST_TIMEOUT_SECONDS
    )

    with pytest.raises(
        ModalCallTimeoutError, match="Modal build sandbox creation deadline exceeded"
    ):
        await ModalBuildSessionService().create(
            build_id="build-1",
            scope_kind="repo",
            scope_id="acme/repo",
            repositories=[{"repo_owner": "acme", "repo_name": "repo", "branch": "main"}],
            callback_url="https://control.test/build-complete",
            failure_callback_url="https://control.test/build-failed",
            timeout_seconds=1800,
        )

    assert create.aio.await_args.kwargs["timeout"] == 1800
    release_create.set()
    await asyncio.wait_for(terminated.wait(), timeout=0.1)


@pytest.mark.asyncio
async def test_create_deadline_adopts_sandbox_found_by_identity_tags(monkeypatch):
    adopted = SimpleNamespace(object_id="modal-session-1")
    release_create = asyncio.Event()

    async def delayed_adopted_sandbox():
        await release_create.wait()
        return adopted

    _patch_sandbox_list(monkeypatch, [adopted])

    sandbox = await create_modal_sandbox(
        delayed_adopted_sandbox(),
        operation="sandbox creation",
        tags={"openinspect_sandbox_id": "sandbox-1"},
        timeout_seconds=TEST_TIMEOUT_SECONDS,
    )

    assert sandbox is adopted
    release_create.set()
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_create_deadline_uses_exact_handle_that_completes_during_reconciliation(monkeypatch):
    release_create = asyncio.Event()
    sandbox = SimpleNamespace(object_id="modal-session-1")

    async def delayed_create():
        await release_create.wait()
        return sandbox

    async def empty_list(**_kwargs):
        release_create.set()
        await asyncio.sleep(0)
        if False:
            yield

    sandbox_list = MagicMock()
    sandbox_list.aio = empty_list
    monkeypatch.setattr("src.sandbox.modal_call.modal.Sandbox.list", sandbox_list)

    result = await create_modal_sandbox(
        delayed_create(),
        operation="sandbox creation",
        tags={"openinspect_create_id": "attempt-1"},
        timeout_seconds=TEST_TIMEOUT_SECONDS,
    )

    assert result is sandbox


@pytest.mark.asyncio
async def test_create_deadline_terminates_late_sandbox(monkeypatch):
    release_create = asyncio.Event()
    terminated = asyncio.Event()

    async def late_create():
        await release_create.wait()
        terminate = MagicMock()
        terminate.aio = AsyncMock(side_effect=lambda **_kwargs: terminated.set())
        return SimpleNamespace(object_id="late-sandbox", terminate=terminate)

    _patch_sandbox_list(monkeypatch)
    with pytest.raises(ModalCallTimeoutError):
        await create_modal_sandbox(
            late_create(),
            operation="sandbox creation",
            tags={"openinspect_sandbox_id": "sandbox-1"},
            timeout_seconds=TEST_TIMEOUT_SECONDS,
        )

    release_create.set()
    await asyncio.wait_for(terminated.wait(), timeout=0.1)


@pytest.mark.asyncio
async def test_create_deadline_reconciles_sandbox_when_sdk_call_stays_pending(monkeypatch):
    release_create = asyncio.Event()
    terminated = asyncio.Event()
    terminate = MagicMock()
    terminate.aio = AsyncMock(side_effect=lambda **_kwargs: terminated.set())
    sandbox = SimpleNamespace(object_id="accepted-sandbox", terminate=terminate)
    list_calls = 0

    async def stalled_create():
        await release_create.wait()
        return sandbox

    async def eventually_visible_list(**_kwargs):
        nonlocal list_calls
        list_calls += 1
        if list_calls > 1:
            yield sandbox

    sandbox_list = MagicMock()
    sandbox_list.aio = eventually_visible_list
    monkeypatch.setattr("src.sandbox.modal_call.modal.Sandbox.list", sandbox_list)
    monkeypatch.setattr("src.sandbox.modal_call.MODAL_CREATE_RECONCILIATION_BACKOFF_SECONDS", 0)

    with pytest.raises(ModalCallTimeoutError):
        await create_modal_sandbox(
            stalled_create(),
            operation="sandbox creation",
            tags={"openinspect_create_id": "attempt-1"},
            timeout_seconds=TEST_TIMEOUT_SECONDS,
        )

    await asyncio.wait_for(terminated.wait(), timeout=0.1)
    assert list_calls == 2
    release_create.set()
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_create_deadline_keeps_reconciling_after_sdk_call_fails(monkeypatch):
    release_create = asyncio.Event()
    create_failed = asyncio.Event()
    terminated = asyncio.Event()
    terminate = MagicMock()
    terminate.aio = AsyncMock(side_effect=lambda **_kwargs: terminated.set())
    sandbox = SimpleNamespace(object_id="accepted-sandbox", terminate=terminate)
    list_calls = 0

    async def failed_create():
        await release_create.wait()
        create_failed.set()
        raise RuntimeError("response failed after acceptance")

    async def eventually_visible_list(**_kwargs):
        nonlocal list_calls
        list_calls += 1
        if list_calls > 1:
            await create_failed.wait()
            yield sandbox

    sandbox_list = MagicMock()
    sandbox_list.aio = eventually_visible_list
    monkeypatch.setattr("src.sandbox.modal_call.modal.Sandbox.list", sandbox_list)
    monkeypatch.setattr("src.sandbox.modal_call.MODAL_CREATE_RECONCILIATION_BACKOFF_SECONDS", 0)

    with pytest.raises(ModalCallTimeoutError):
        await create_modal_sandbox(
            failed_create(),
            operation="sandbox creation",
            tags={"openinspect_create_id": "attempt-1"},
            timeout_seconds=TEST_TIMEOUT_SECONDS,
        )

    release_create.set()
    await asyncio.wait_for(terminated.wait(), timeout=0.1)
    assert list_calls == 2


@pytest.mark.asyncio
async def test_post_create_setup_failure_terminates_sandbox(monkeypatch):
    terminate = MagicMock()
    terminate.aio = AsyncMock()
    sandbox = SimpleNamespace(object_id="modal-session-1", terminate=terminate)
    create = MagicMock()
    create.aio = AsyncMock(return_value=sandbox)
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", create)
    monkeypatch.setattr(
        SandboxManager,
        "_resolve_and_setup_tunnels",
        AsyncMock(side_effect=RuntimeError("setup failed")),
    )

    with pytest.raises(RuntimeError, match="setup failed"):
        await SandboxManager().create_sandbox(
            SandboxConfig(repo_owner="acme", repo_name="repo", sandbox_id="sandbox-1")
        )

    terminate.aio.assert_awaited_once_with(wait=False)


@pytest.mark.asyncio
async def test_interactive_lookup_timeout_propagates_transient_error(monkeypatch):
    from_id = _never_settling_method()
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.from_id", from_id)
    monkeypatch.setattr(
        "src.sandbox.manager.MODAL_SANDBOX_RPC_TIMEOUT_SECONDS", TEST_TIMEOUT_SECONDS
    )

    with pytest.raises(ModalCallTimeoutError, match="Modal sandbox lookup deadline exceeded"):
        await SandboxManager().get_sandbox_by_id("sandbox-1")


@pytest.mark.asyncio
async def test_build_tag_lookup_times_out(monkeypatch):
    sandbox = SimpleNamespace(get_tags=_never_settling_method())
    from_id = MagicMock()
    from_id.aio = AsyncMock(return_value=sandbox)
    monkeypatch.setattr("src.sandbox.build_session.modal.Sandbox.from_id", from_id)
    monkeypatch.setattr(
        "src.sandbox.build_session.MODAL_SANDBOX_RPC_TIMEOUT_SECONDS", TEST_TIMEOUT_SECONDS
    )

    with pytest.raises(
        ModalCallTimeoutError, match="Modal build sandbox tag lookup deadline exceeded"
    ):
        await ModalBuildSessionService()._resolve("build-1", "modal-session-1")


@pytest.mark.asyncio
async def test_build_stdin_drain_times_out(monkeypatch):
    sandbox = SimpleNamespace(
        stdin=SimpleNamespace(write=MagicMock(), drain=_never_settling_method())
    )
    service = ModalBuildSessionService()
    monkeypatch.setattr(
        service,
        "_resolve",
        AsyncMock(
            return_value=(
                sandbox,
                {
                    "openinspect_kind": "image-build",
                    "openinspect_build_id": "build-1",
                    "openinspect_launch_protocol": "stdin-token-v1",
                },
            )
        ),
    )
    monkeypatch.setattr(
        "src.sandbox.build_session.MODAL_SANDBOX_RPC_TIMEOUT_SECONDS", TEST_TIMEOUT_SECONDS
    )

    with pytest.raises(
        ModalCallTimeoutError, match="Modal build sandbox stdin drain deadline exceeded"
    ):
        await service.start(
            build_id="build-1",
            provider_session_id="modal-session-1",
            callback_token="callback-token",
        )


@pytest.mark.asyncio
async def test_tunnel_metadata_write_timeout_remains_non_fatal(monkeypatch):
    sandbox = SimpleNamespace(filesystem=SimpleNamespace(write_text=_never_settling_method()))
    monkeypatch.setattr(
        "src.sandbox.manager.MODAL_SANDBOX_RPC_TIMEOUT_SECONDS", TEST_TIMEOUT_SECONDS
    )

    with patch("src.sandbox.manager.log") as mock_log:
        await SandboxManager._write_tunnel_env_file(
            sandbox, "sandbox-1", {3000: "https://tunnel.example"}
        )

    mock_log.warn.assert_called_once()
    assert isinstance(mock_log.warn.call_args.kwargs["exc"], ModalCallTimeoutError)


@pytest.mark.asyncio
async def test_terminate_wait_has_bounded_total_duration(monkeypatch):
    sandbox = SimpleNamespace(terminate=_never_settling_method())
    service = ModalBuildSessionService()
    monkeypatch.setattr(service, "_resolve", AsyncMock(return_value=(sandbox, {})))
    monkeypatch.setattr(
        "src.sandbox.build_session.MODAL_SANDBOX_TERMINATE_TIMEOUT_SECONDS",
        TEST_TIMEOUT_SECONDS,
    )

    with pytest.raises(
        ModalCallTimeoutError, match="Modal build sandbox termination deadline exceeded"
    ):
        await service.terminate(
            build_id="build-1",
            provider_session_id="modal-session-1",
            reason="image_build_complete",
        )

    sandbox.terminate.aio.assert_awaited_once_with(wait=True)

"""Outer deadlines for Modal SDK lifecycle operations."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.sandbox.build_session import ModalBuildSessionService
from src.sandbox.manager import SandboxConfig, SandboxManager

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


@pytest.mark.asyncio
async def test_interactive_create_times_out_and_cancels_sdk_call(monkeypatch):
    cancelled = asyncio.Event()
    create = _never_settling_method(cancelled)
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", create)
    monkeypatch.setattr(
        "src.sandbox.manager.MODAL_SANDBOX_CREATE_TIMEOUT_SECONDS", TEST_TIMEOUT_SECONDS
    )

    with pytest.raises(TimeoutError, match="Modal sandbox creation timed out"):
        await SandboxManager().create_sandbox(SandboxConfig(repo_owner="acme", repo_name="repo"))

    assert cancelled.is_set()


@pytest.mark.asyncio
async def test_build_create_times_out_independently_of_sandbox_lifetime(monkeypatch):
    create = _never_settling_method()
    monkeypatch.setattr("src.sandbox.build_session.modal.Sandbox.create", create)
    monkeypatch.setattr(
        "src.sandbox.build_session.MODAL_SANDBOX_CREATE_TIMEOUT_SECONDS", TEST_TIMEOUT_SECONDS
    )

    with pytest.raises(TimeoutError, match="Modal build sandbox creation timed out"):
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


@pytest.mark.asyncio
async def test_interactive_lookup_timeout_preserves_not_found_semantics(monkeypatch):
    from_id = _never_settling_method()
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.from_id", from_id)
    monkeypatch.setattr(
        "src.sandbox.manager.MODAL_SANDBOX_RPC_TIMEOUT_SECONDS", TEST_TIMEOUT_SECONDS
    )

    with patch("src.sandbox.manager.log") as mock_log:
        handle = await SandboxManager().get_sandbox_by_id("sandbox-1")

    assert handle is None
    mock_log.warn.assert_called_once()


@pytest.mark.asyncio
async def test_build_tag_lookup_times_out(monkeypatch):
    sandbox = SimpleNamespace(get_tags=_never_settling_method())
    from_id = MagicMock()
    from_id.aio = AsyncMock(return_value=sandbox)
    monkeypatch.setattr("src.sandbox.build_session.modal.Sandbox.from_id", from_id)
    monkeypatch.setattr(
        "src.sandbox.build_session.MODAL_SANDBOX_RPC_TIMEOUT_SECONDS", TEST_TIMEOUT_SECONDS
    )

    with pytest.raises(TimeoutError, match="Modal build sandbox tag lookup timed out"):
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

    with pytest.raises(TimeoutError, match="Modal build sandbox stdin drain timed out"):
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
    assert isinstance(mock_log.warn.call_args.kwargs["exc"], TimeoutError)


@pytest.mark.asyncio
async def test_terminate_wait_has_bounded_total_duration(monkeypatch):
    sandbox = SimpleNamespace(terminate=_never_settling_method())
    service = ModalBuildSessionService()
    monkeypatch.setattr(service, "_resolve", AsyncMock(return_value=(sandbox, {})))
    monkeypatch.setattr(
        "src.sandbox.build_session.MODAL_SANDBOX_TERMINATE_TIMEOUT_SECONDS",
        TEST_TIMEOUT_SECONDS,
    )

    with pytest.raises(TimeoutError, match="Modal build sandbox termination timed out"):
        await service.terminate(
            build_id="build-1",
            provider_session_id="modal-session-1",
            reason="image_build_complete",
        )

    sandbox.terminate.aio.assert_awaited_once_with(wait=True)

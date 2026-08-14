"""Behavioral tests for Modal's token-gated image-build entrypoint."""

import asyncio
import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.modal_image_build_start import (
    MODAL_IMAGE_BUILD_START_ARGUMENT,
    MODAL_SANDBOX_ID_ENV,
    ModalImageBuildStartCancelled,
    create_modal_callback,
    read_modal_callback_token,
)
from sandbox_runtime.repo_image_callback import (
    BUILD_ID_ENV,
    CALLBACK_TOKEN_ENV,
    CALLBACK_URL_ENV,
    FAILURE_CALLBACK_URL_ENV,
)


def _set_modal_build_context(monkeypatch):
    monkeypatch.setenv("IMAGE_BUILD_MODE", "true")
    monkeypatch.setenv("SANDBOX_ID", "build-imgb-acme-repo-123-abc")
    monkeypatch.setenv("REPO_OWNER", "acme")
    monkeypatch.setenv("REPO_NAME", "repo")
    monkeypatch.setenv("SESSION_CONFIG", "{}")
    monkeypatch.setenv(BUILD_ID_ENV, "imgb-acme-repo-123-abc")
    monkeypatch.setenv(
        CALLBACK_URL_ENV,
        "https://control-plane.test/image-builds/build-complete",
    )
    monkeypatch.setenv(
        FAILURE_CALLBACK_URL_ENV,
        "https://control-plane.test/image-builds/build-failed",
    )
    monkeypatch.setenv(MODAL_SANDBOX_ID_ENV, "sb-provider-123")
    monkeypatch.delenv(CALLBACK_TOKEN_ENV, raising=False)


def test_create_modal_callback_uses_create_context_and_modal_identity(monkeypatch):
    _set_modal_build_context(monkeypatch)

    reporter = create_modal_callback("a" * 64)

    assert reporter.build_id == "imgb-acme-repo-123-abc"
    assert reporter.provider_session_id == "sb-provider-123"
    assert reporter.callback_url == "https://control-plane.test/image-builds/build-complete"
    assert reporter.failure_callback_url == "https://control-plane.test/image-builds/build-failed"
    assert reporter.token == "a" * 64


def test_create_modal_callback_rejects_invalid_token(monkeypatch):
    _set_modal_build_context(monkeypatch)

    with pytest.raises(ValueError, match="invalid callback token"):
        create_modal_callback("callback-token")


def test_create_modal_callback_rejects_missing_create_context(monkeypatch):
    _set_modal_build_context(monkeypatch)
    monkeypatch.delenv(MODAL_SANDBOX_ID_ENV)

    with pytest.raises(ValueError, match=MODAL_SANDBOX_ID_ENV):
        create_modal_callback("a" * 64)


@pytest.mark.asyncio
async def test_reads_one_modal_callback_token_line():
    reader = asyncio.StreamReader()
    reader.feed_data(("a" * 64 + "\n").encode())

    token = await read_modal_callback_token(reader, asyncio.Event())

    assert token == "a" * 64


@pytest.mark.asyncio
async def test_completed_token_read_wins_when_shutdown_is_also_ready():
    reader = asyncio.StreamReader()
    reader.feed_data(("a" * 64 + "\n").encode())
    shutdown_event = asyncio.Event()
    shutdown_event.set()

    token = await read_modal_callback_token(reader, shutdown_event)

    assert token == "a" * 64


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("payload", "reason"),
    [
        (b"not-a-token\n", "invalid callback token"),
        (("a" * 65 + "\n").encode(), "callback token too large"),
        (("a" * 64).encode(), "incomplete callback token"),
        (b"", "stdin closed"),
    ],
)
async def test_rejects_invalid_modal_callback_token_lines(payload, reason):
    reader = asyncio.StreamReader()
    if payload:
        reader.feed_data(payload)
    reader.feed_eof()

    with pytest.raises(ValueError, match=reason):
        await read_modal_callback_token(reader, asyncio.Event())


@pytest.mark.asyncio
async def test_shutdown_cancels_modal_callback_token_read():
    reader = asyncio.StreamReader()
    reader.feed_data(b"a")
    shutdown_event = asyncio.Event()
    operation = asyncio.create_task(read_modal_callback_token(reader, shutdown_event))
    await asyncio.sleep(0)

    shutdown_event.set()

    with pytest.raises(ModalImageBuildStartCancelled):
        await operation


@pytest.mark.asyncio
async def test_cancelling_modal_callback_token_read_cleans_up_reader_task():
    read_cancelled = asyncio.Event()

    class BlockingReader:
        async def readline(self):
            try:
                await asyncio.Event().wait()
            finally:
                read_cancelled.set()

    operation = asyncio.create_task(read_modal_callback_token(BlockingReader(), asyncio.Event()))
    await asyncio.sleep(0)

    operation.cancel()
    with pytest.raises(asyncio.CancelledError):
        await operation

    assert read_cancelled.is_set()


@pytest.mark.asyncio
async def test_modal_entrypoint_runs_supervisor_with_memory_only_callback_token(monkeypatch):
    from sandbox_runtime import entrypoint, modal_image_build_start
    from sandbox_runtime.repository_boot import RepositoryBootResult

    _set_modal_build_context(monkeypatch)
    reader = asyncio.StreamReader()
    reader.feed_data(("a" * 64 + "\n").encode())
    transport = MagicMock()
    monkeypatch.setattr(
        modal_image_build_start,
        "_connect_start_reader",
        AsyncMock(return_value=(reader, transport)),
    )
    monkeypatch.setattr(entrypoint, "install_signal_handlers", MagicMock())

    observed_hook_env = {}
    observed_supervisor = {}

    async def finish_build(supervisor, _expected_tunnel_ports):
        observed_supervisor["value"] = supervisor
        observed_hook_env.update(os.environ)
        return RepositoryBootResult(
            git_sync_success=True,
            repository_shas=[],
            setup_success=True,
            start_success=None,
            repositories=(),
            workdir=Path("/workspace"),
        )

    monkeypatch.setattr(entrypoint.SandboxSupervisor, "_run_image_build_execution", finish_build)

    async def report_success_and_release(**_kwargs):
        observed_supervisor["value"].shutdown_event.set()
        return True

    report_success = AsyncMock(side_effect=report_success_and_release)
    monkeypatch.setattr(
        "sandbox_runtime.repo_image_callback.RepoImageBuildCallback.report_success",
        report_success,
    )

    exit_code = await entrypoint.main([MODAL_IMAGE_BUILD_START_ARGUMENT])

    assert exit_code == 0
    report_success.assert_awaited_once()
    assert CALLBACK_TOKEN_ENV not in entrypoint.os.environ
    assert CALLBACK_TOKEN_ENV not in observed_hook_env
    assert BUILD_ID_ENV not in observed_hook_env
    assert CALLBACK_URL_ENV not in observed_hook_env
    assert FAILURE_CALLBACK_URL_ENV not in observed_hook_env
    transport.close.assert_called_once_with()


@pytest.mark.asyncio
async def test_unflagged_entrypoint_keeps_legacy_environment_path(monkeypatch):
    from sandbox_runtime import entrypoint

    run = AsyncMock()
    supervisor = MagicMock(run=run, shutdown_event=asyncio.Event())
    monkeypatch.setattr(entrypoint, "SandboxSupervisor", MagicMock(return_value=supervisor))
    monkeypatch.setattr(entrypoint, "install_signal_handlers", MagicMock())

    exit_code = await entrypoint.main([])

    assert exit_code == 0
    run.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_modal_entrypoint_fails_closed_outside_image_build_mode(monkeypatch):
    from sandbox_runtime import entrypoint

    _set_modal_build_context(monkeypatch)
    monkeypatch.delenv("IMAGE_BUILD_MODE")
    run = AsyncMock()
    supervisor = MagicMock(run=run, shutdown_event=asyncio.Event())
    monkeypatch.setattr(entrypoint, "SandboxSupervisor", MagicMock(return_value=supervisor))
    monkeypatch.setattr(entrypoint, "install_signal_handlers", MagicMock())

    exit_code = await entrypoint.main([MODAL_IMAGE_BUILD_START_ARGUMENT])

    assert exit_code == 1
    run.assert_not_awaited()
    supervisor.log.error.assert_called_once_with(
        "image_build.launch_failed", reason="invalid_build_mode"
    )


@pytest.mark.asyncio
async def test_modal_entrypoint_requires_build_identity(monkeypatch):
    from sandbox_runtime import entrypoint

    _set_modal_build_context(monkeypatch)
    monkeypatch.delenv(BUILD_ID_ENV)
    run = AsyncMock()
    supervisor = MagicMock(run=run, shutdown_event=asyncio.Event())
    monkeypatch.setattr(entrypoint, "SandboxSupervisor", MagicMock(return_value=supervisor))
    monkeypatch.setattr(entrypoint, "install_signal_handlers", MagicMock())

    exit_code = await entrypoint.main([MODAL_IMAGE_BUILD_START_ARGUMENT])

    assert exit_code == 1
    run.assert_not_awaited()
    supervisor.log.error.assert_called_once_with(
        "image_build.launch_failed", reason="missing_build_identity"
    )


@pytest.mark.asyncio
async def test_modal_entrypoint_exits_cleanly_when_shutdown_wins(monkeypatch):
    from sandbox_runtime import entrypoint, modal_image_build_start

    _set_modal_build_context(monkeypatch)
    reader = asyncio.StreamReader()
    transport = MagicMock()
    run = AsyncMock()
    shutdown_event = asyncio.Event()
    shutdown_event.set()
    supervisor = MagicMock(run=run, shutdown_event=shutdown_event)
    monkeypatch.setattr(entrypoint, "SandboxSupervisor", MagicMock(return_value=supervisor))
    monkeypatch.setattr(entrypoint, "install_signal_handlers", MagicMock())
    monkeypatch.setattr(
        modal_image_build_start,
        "_connect_start_reader",
        AsyncMock(return_value=(reader, transport)),
    )

    exit_code = await entrypoint.main([MODAL_IMAGE_BUILD_START_ARGUMENT])

    assert exit_code == 0
    run.assert_not_awaited()
    transport.close.assert_called_once_with()


@pytest.mark.asyncio
async def test_modal_entrypoint_rejects_invalid_token_without_starting(monkeypatch):
    from sandbox_runtime import entrypoint, modal_image_build_start

    _set_modal_build_context(monkeypatch)
    reader = asyncio.StreamReader()
    reader.feed_data(b"not-a-token\n")
    transport = MagicMock()
    run = AsyncMock()
    supervisor = MagicMock(run=run, shutdown_event=asyncio.Event())
    monkeypatch.setattr(entrypoint, "SandboxSupervisor", MagicMock(return_value=supervisor))
    monkeypatch.setattr(entrypoint, "install_signal_handlers", MagicMock())
    monkeypatch.setattr(
        modal_image_build_start,
        "_connect_start_reader",
        AsyncMock(return_value=(reader, transport)),
    )

    exit_code = await entrypoint.main([MODAL_IMAGE_BUILD_START_ARGUMENT])

    assert exit_code == 1
    run.assert_not_awaited()
    supervisor.log.error.assert_called_once_with(
        "image_build.launch_failed",
        build_id="imgb-acme-repo-123-abc",
        reason="invalid callback token",
    )
    transport.close.assert_called_once_with()


@pytest.mark.asyncio
async def test_modal_entrypoint_returns_failure_when_supervisor_reports_failed_build(monkeypatch):
    from sandbox_runtime import entrypoint, modal_image_build_start

    _set_modal_build_context(monkeypatch)
    reader = asyncio.StreamReader()
    reader.feed_data(("a" * 64 + "\n").encode())
    transport = MagicMock()
    supervisor = MagicMock(run=AsyncMock(return_value=False), shutdown_event=asyncio.Event())
    monkeypatch.setattr(entrypoint, "SandboxSupervisor", MagicMock(return_value=supervisor))
    monkeypatch.setattr(entrypoint, "install_signal_handlers", MagicMock())
    monkeypatch.setattr(
        modal_image_build_start,
        "_connect_start_reader",
        AsyncMock(return_value=(reader, transport)),
    )

    exit_code = await entrypoint.main([MODAL_IMAGE_BUILD_START_ARGUMENT])

    assert exit_code == 1
    supervisor.run.assert_awaited_once()
    transport.close.assert_called_once_with()


@pytest.mark.asyncio
async def test_modal_entrypoint_does_not_relabel_supervisor_errors_as_launch_failures(monkeypatch):
    from sandbox_runtime import entrypoint, modal_image_build_start

    _set_modal_build_context(monkeypatch)
    reader = asyncio.StreamReader()
    reader.feed_data(("a" * 64 + "\n").encode())
    transport = MagicMock()
    supervisor = MagicMock(
        run=AsyncMock(side_effect=ValueError("unexpected build error")),
        shutdown_event=asyncio.Event(),
    )
    monkeypatch.setattr(entrypoint, "SandboxSupervisor", MagicMock(return_value=supervisor))
    monkeypatch.setattr(entrypoint, "install_signal_handlers", MagicMock())
    monkeypatch.setattr(
        modal_image_build_start,
        "_connect_start_reader",
        AsyncMock(return_value=(reader, transport)),
    )

    with pytest.raises(ValueError, match="unexpected build error"):
        await entrypoint.main([MODAL_IMAGE_BUILD_START_ARGUMENT])

    supervisor.run.assert_awaited_once()
    assert all(
        call.args != ("image_build.launch_failed",) for call in supervisor.log.error.call_args_list
    )
    transport.close.assert_called_once_with()

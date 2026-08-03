"""Behavioral tests for Modal's token-gated image-build entrypoint."""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.repo_image_callback import (
    BUILD_ID_ENV,
    CALLBACK_TOKEN_ENV,
    CALLBACK_URL_ENV,
    FAILURE_CALLBACK_URL_ENV,
    MODAL_IMAGE_BUILD_START_ARGUMENT,
    MODAL_SANDBOX_ID_ENV,
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


@pytest.mark.asyncio
async def test_modal_entrypoint_runs_supervisor_with_memory_only_callback_token(monkeypatch):
    from sandbox_runtime import entrypoint

    _set_modal_build_context(monkeypatch)
    reader = asyncio.StreamReader()
    reader.feed_data(("a" * 64 + "\n").encode())
    transport = MagicMock()
    monkeypatch.setattr(
        entrypoint,
        "_connect_modal_start_reader",
        AsyncMock(return_value=(reader, transport)),
    )
    monkeypatch.setattr(entrypoint, "install_signal_handlers", MagicMock())

    observed_hook_env = {}
    observed_supervisor = {}

    async def finish_build(supervisor, _expected_tunnel_ports):
        observed_supervisor["value"] = supervisor
        observed_hook_env.update(supervisor._hook_env())
        return entrypoint.RepositoryBootResult(True, "abc123", [], True, None)

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
async def test_modal_entrypoint_rejects_invalid_token_without_starting(monkeypatch):
    from sandbox_runtime import entrypoint

    _set_modal_build_context(monkeypatch)
    reader = asyncio.StreamReader()
    reader.feed_data(b"not-a-token\n")
    transport = MagicMock()
    run = AsyncMock()
    supervisor = MagicMock(run=run, shutdown_event=asyncio.Event())
    monkeypatch.setattr(entrypoint, "SandboxSupervisor", MagicMock(return_value=supervisor))
    monkeypatch.setattr(entrypoint, "install_signal_handlers", MagicMock())
    monkeypatch.setattr(
        entrypoint,
        "_connect_modal_start_reader",
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

import asyncio
import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.hook_logs import HookLogs
from sandbox_runtime.repository_boot import RepositoryBootResult
from sandbox_runtime.repository_hooks import RepositoryHooks
from sandbox_runtime.runtime_config import BootMode, RuntimeConfig
from sandbox_runtime.supervisor import SandboxSupervisor


def _supervisor(tmp_path, events):
    config = RuntimeConfig.from_env(
        {"SANDBOX_ID": "sandbox-1", "REPO_OWNER": "acme", "REPO_NAME": "repo"},
        workspace_path=tmp_path,
    )
    result = RepositoryBootResult(True, [], True, True, (), Path(tmp_path))
    repository = MagicMock()
    repository.prepare_tunnel_environment.return_value = []
    repository.hooks.discard_logs = AsyncMock()
    repository.hooks.shutdown = AsyncMock()
    repository.boot = AsyncMock(
        side_effect=lambda mode, _ports: events.append(f"repository:{mode.value}") or result
    )

    opencode_server = MagicMock()
    opencode_server.exit_code.return_value = None
    opencode_server.start = AsyncMock(
        side_effect=lambda _repos, _workdir: events.append("opencode")
    )
    opencode_server.stop = AsyncMock()
    agent_bridge = MagicMock()
    agent_bridge.exit_code.return_value = None
    agent_bridge.start = AsyncMock(side_effect=lambda: events.append("bridge"))
    agent_bridge.stop = AsyncMock()
    code_server = MagicMock()
    code_server.exit_code.return_value = None
    code_server.start = AsyncMock(side_effect=lambda _workdir: events.append("code_server"))
    code_server.stop = AsyncMock()
    terminal = MagicMock()
    terminal.crash.return_value = None
    terminal.start = AsyncMock(side_effect=lambda _workdir: events.append("terminal"))
    terminal.stop = AsyncMock()
    desktop = MagicMock()
    desktop.crash.return_value = None
    desktop.start = AsyncMock(side_effect=lambda: events.append("desktop"))
    desktop.stop = AsyncMock()
    managed_skills = MagicMock()
    managed_skills.materialize = AsyncMock(side_effect=lambda *_args: events.append("skills"))

    supervisor = SandboxSupervisor(
        config,
        repository,
        opencode_server,
        agent_bridge,
        code_server,
        terminal,
        desktop,
        managed_skills,
        asyncio.Event(),
        MagicMock(),
    )
    supervisor.monitor_processes = AsyncMock()
    return supervisor, repository, opencode_server, agent_bridge, code_server, terminal, desktop


async def test_regular_boot_phase_order(tmp_path, monkeypatch):
    events = []
    supervisor, *_ = _supervisor(tmp_path, events)
    monkeypatch.delenv("IMAGE_BUILD_MODE", raising=False)
    monkeypatch.delenv("RESTORED_FROM_SNAPSHOT", raising=False)
    monkeypatch.delenv("FROM_REPO_IMAGE", raising=False)

    assert await supervisor.run() is True
    supervisor.repository_boot.prepare_tunnel_environment.assert_called_once_with(BootMode.FRESH)
    supervisor.repository_boot.hooks.shutdown.assert_awaited_once()
    assert events == [
        "desktop",
        "repository:fresh",
        "skills",
        "code_server",
        "terminal",
        "opencode",
        "bridge",
    ]


async def test_regular_boot_passes_repository_workspace_to_services(tmp_path, monkeypatch):
    supervisor, repository, opencode_server, _agent_bridge, code_server, terminal, _desktop = (
        _supervisor(tmp_path, [])
    )
    repositories = (MagicMock(),)
    workdir = tmp_path / "repo"
    repository.boot.side_effect = None
    repository.boot.return_value = RepositoryBootResult(True, [], True, True, repositories, workdir)
    monkeypatch.delenv("IMAGE_BUILD_MODE", raising=False)
    monkeypatch.delenv("RESTORED_FROM_SNAPSHOT", raising=False)
    monkeypatch.delenv("FROM_REPO_IMAGE", raising=False)

    await supervisor.run()

    opencode_server.start.assert_awaited_once_with(repositories, workdir)
    supervisor.managed_skills.materialize.assert_awaited_once_with(repositories, workdir)
    code_server.start.assert_awaited_once_with(workdir)
    terminal.start.assert_awaited_once_with(workdir)


async def test_build_boot_excludes_runtime_services(tmp_path, monkeypatch):
    supervisor, repository, opencode_server, agent_bridge, _code_server, _terminal, desktop = (
        _supervisor(tmp_path, [])
    )
    monkeypatch.setenv("IMAGE_BUILD_MODE", "true")
    callback = MagicMock()

    async def report_success(**_kwargs):
        repository.hooks.discard_logs.assert_awaited_once()
        supervisor.shutdown_event.set()
        return True

    callback.report_success = AsyncMock(side_effect=report_success)
    callback.report_failure = AsyncMock()

    assert await supervisor.run(callback) is True
    repository.boot.assert_awaited_once_with(BootMode.BUILD, [])
    repository.hooks.shutdown.assert_awaited_once()
    desktop.start.assert_not_awaited()
    supervisor.managed_skills.materialize.assert_not_awaited()
    opencode_server.start.assert_not_awaited()
    agent_bridge.start.assert_not_awaited()


async def test_graceful_bridge_exit_requests_shutdown(tmp_path):
    supervisor, _repository, _opencode_server, agent_bridge, *_ = _supervisor(tmp_path, [])
    agent_bridge.exit_code.return_value = 0

    await SandboxSupervisor.monitor_processes(supervisor)

    assert supervisor.shutdown_event.is_set()
    agent_bridge.start.assert_not_awaited()


async def test_bridge_restart_exhaustion_is_fatal(tmp_path, monkeypatch):
    supervisor, _repository, _opencode_server, agent_bridge, *_ = _supervisor(tmp_path, [])
    agent_bridge.exit_code.return_value = 1
    supervisor._report_fatal_error = AsyncMock()
    monkeypatch.setattr(supervisor, "_wait_for_shutdown", AsyncMock(return_value=False))

    await SandboxSupervisor.monitor_processes(supervisor)

    assert agent_bridge.start.await_count == supervisor.MAX_RESTARTS
    supervisor._report_fatal_error.assert_awaited_once()
    assert supervisor.shutdown_event.is_set()


async def test_opencode_restarts_do_not_rematerialize_managed_skills(tmp_path, monkeypatch):
    supervisor, _repository, opencode_server, *_ = _supervisor(tmp_path, [])
    supervisor._repository_boot_result = RepositoryBootResult(True, [], True, True, (), tmp_path)
    opencode_server.exit_code.return_value = 1
    supervisor._report_fatal_error = AsyncMock()
    monkeypatch.setattr(supervisor, "_wait_for_shutdown", AsyncMock(return_value=False))

    await SandboxSupervisor.monitor_processes(supervisor)

    assert opencode_server.start.await_count == supervisor.MAX_RESTARTS
    supervisor.managed_skills.materialize.assert_not_awaited()


async def test_code_server_restart_exhaustion_is_nonfatal(tmp_path, monkeypatch):
    supervisor, _repository, _opencode_server, _agent_bridge, code_server, *_ = _supervisor(
        tmp_path, []
    )
    code_server.exit_code.return_value = 1
    supervisor._report_fatal_error = AsyncMock()

    monkeypatch.setattr(
        supervisor,
        "_wait_for_shutdown",
        AsyncMock(side_effect=[False] * supervisor.MAX_RESTARTS + [True]),
    )
    await SandboxSupervisor.monitor_processes(supervisor)

    supervisor._report_fatal_error.assert_not_awaited()


@pytest.mark.parametrize(
    "failing_services",
    [
        ("bridge",),
        ("terminal",),
        ("code_server",),
        ("desktop",),
        ("harness",),
        ("bridge", "terminal", "harness", "hooks"),
    ],
)
async def test_shutdown_attempts_all_cleanup_before_reporting_errors(tmp_path, failing_services):
    supervisor, repository, harness, bridge, code_server, terminal, desktop = _supervisor(
        tmp_path, []
    )
    events = []
    failures = {name: RuntimeError(f"{name} cleanup failed") for name in failing_services}

    def stop_operation(name):
        async def stop():
            events.append(name)
            supervisor.log.error.assert_not_called()
            if name in failures:
                raise failures[name]

        return AsyncMock(side_effect=stop)

    for name, service in (
        ("bridge", bridge),
        ("terminal", terminal),
        ("code_server", code_server),
        ("desktop", desktop),
        ("harness", harness),
    ):
        service.stop = stop_operation(name)
    repository.hooks.shutdown = stop_operation("hooks")

    with pytest.raises(ExceptionGroup, match="sandbox shutdown cleanup failed") as raised:
        await supervisor.shutdown()

    assert events == ["bridge", "terminal", "code_server", "desktop", "harness", "hooks"]
    assert raised.value.exceptions == tuple(failures.values())
    supervisor.log.error.assert_called_once_with("supervisor.shutdown_failed", exc=raised.value)
    assert not any(
        call.args == ("supervisor.shutdown_complete",)
        for call in supervisor.log.info.call_args_list
    )


async def test_bridge_stop_failure_still_discards_private_hook_logs(tmp_path):
    supervisor, repository, harness, bridge, code_server, terminal, desktop = _supervisor(
        tmp_path, []
    )
    hooks = RepositoryHooks(MagicMock())
    hooks.logs = HookLogs(tmp_path, hooks.log)
    repository.hooks = hooks
    log_path, fd = hooks.logs.open("acme", "repo", "setup")
    os.write(fd, b"private repository output")
    bridge.stop.side_effect = RuntimeError("bridge stop failed")

    try:
        with pytest.raises(ExceptionGroup, match="sandbox shutdown cleanup failed"):
            await supervisor.shutdown()

        assert not log_path.exists()
        assert not hooks.logs.path.exists()
        with pytest.raises(OSError):
            os.fstat(fd)
        bridge.stop.assert_awaited_once()
        terminal.stop.assert_awaited_once()
        code_server.stop.assert_awaited_once()
        desktop.stop.assert_awaited_once()
        harness.stop.assert_awaited_once()
    finally:
        await hooks.shutdown()


async def test_cancelled_service_stop_still_attempts_other_owners(tmp_path):
    supervisor, repository, harness, bridge, code_server, terminal, desktop = _supervisor(
        tmp_path, []
    )
    bridge.stop.side_effect = asyncio.CancelledError()

    with pytest.raises(BaseExceptionGroup, match="sandbox shutdown cleanup failed") as raised:
        await supervisor.shutdown()

    assert isinstance(raised.value.exceptions[0], asyncio.CancelledError)
    terminal.stop.assert_awaited_once()
    code_server.stop.assert_awaited_once()
    desktop.stop.assert_awaited_once()
    harness.stop.assert_awaited_once()
    repository.hooks.shutdown.assert_awaited_once()


@pytest.mark.parametrize("raises_during_cancel", [False, True])
async def test_shutdown_collects_desktop_task_cleanup_failure(tmp_path, raises_during_cancel):
    supervisor, repository, harness, bridge, code_server, terminal, desktop = _supervisor(
        tmp_path, []
    )
    started = asyncio.Event()
    failure = RuntimeError("desktop restart cleanup failed")

    async def restart_desktop():
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            if raises_during_cancel:
                raise failure

    restart_task = asyncio.create_task(restart_desktop())
    supervisor._desktop_restart_task = restart_task
    await started.wait()

    if raises_during_cancel:
        with pytest.raises(ExceptionGroup, match="sandbox shutdown cleanup failed") as raised:
            await supervisor.shutdown()
        assert raised.value.exceptions == (failure,)
        supervisor.log.error.assert_called_once_with("supervisor.shutdown_failed", exc=raised.value)
    else:
        await supervisor.shutdown()
        assert restart_task.cancelled()
        supervisor.log.error.assert_not_called()

    assert supervisor._desktop_restart_task is None
    bridge.stop.assert_awaited_once()
    terminal.stop.assert_awaited_once()
    code_server.stop.assert_awaited_once()
    desktop.stop.assert_awaited_once()
    harness.stop.assert_awaited_once()
    repository.hooks.shutdown.assert_awaited_once()

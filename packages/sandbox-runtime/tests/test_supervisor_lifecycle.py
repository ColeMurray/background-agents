import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.repository_boot import RepositoryBootResult
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
    monkeypatch.delenv("EARLY_SANDBOX_CONNECTION", raising=False)

    assert await supervisor.run() is True
    supervisor.repository_boot.prepare_tunnel_environment.assert_called_once_with(BootMode.FRESH)
    assert events == [
        "desktop",
        "repository:fresh",
        "skills",
        "code_server",
        "terminal",
        "opencode",
        "bridge",
    ]


async def test_early_connection_starts_bridge_before_repository_boot(tmp_path, monkeypatch):
    events = []
    supervisor, *_ = _supervisor(tmp_path, events)
    monkeypatch.setenv("EARLY_SANDBOX_CONNECTION", "1")
    monkeypatch.delenv("IMAGE_BUILD_MODE", raising=False)
    monkeypatch.delenv("RESTORED_FROM_SNAPSHOT", raising=False)
    monkeypatch.delenv("FROM_REPO_IMAGE", raising=False)

    assert await supervisor.run() is True
    assert events == [
        "bridge",
        "desktop",
        "repository:fresh",
        "skills",
        "code_server",
        "terminal",
        "opencode",
    ]


async def test_early_connection_repository_failure_stops_bridge(tmp_path, monkeypatch):
    supervisor, repository, _opencode_server, agent_bridge, *_ = _supervisor(tmp_path, [])
    repository.boot.side_effect = RuntimeError("clone failed")
    supervisor._report_fatal_error = AsyncMock()
    monkeypatch.setenv("EARLY_SANDBOX_CONNECTION", "1")
    monkeypatch.delenv("IMAGE_BUILD_MODE", raising=False)

    assert await supervisor.run() is False

    agent_bridge.start.assert_awaited_once()
    agent_bridge.stop.assert_awaited_once()
    supervisor._report_fatal_error.assert_awaited_once_with("clone failed")


async def test_early_connection_restarts_bridge_while_repository_boot_is_blocked(
    tmp_path, monkeypatch
):
    supervisor, repository, _opencode_server, agent_bridge, *_ = _supervisor(tmp_path, [])
    release_boot = asyncio.Event()
    boot_started = asyncio.Event()

    async def blocked_boot(_mode, _ports):
        boot_started.set()
        await release_boot.wait()
        return RepositoryBootResult(True, [], True, True, (), tmp_path)

    repository.boot.side_effect = blocked_boot
    agent_bridge.exit_code.side_effect = [1, None]

    async def restart_bridge():
        if agent_bridge.start.await_count == 2:
            release_boot.set()

    agent_bridge.start.side_effect = restart_bridge
    monkeypatch.setattr(supervisor, "_wait_for_shutdown", AsyncMock(return_value=False))
    monkeypatch.setattr(supervisor, "EARLY_BRIDGE_MONITOR_INTERVAL_SECONDS", 0.01, raising=False)
    monkeypatch.setenv("EARLY_SANDBOX_CONNECTION", "1")
    monkeypatch.delenv("IMAGE_BUILD_MODE", raising=False)

    run_task = asyncio.create_task(supervisor.run())
    await boot_started.wait()

    assert await asyncio.wait_for(run_task, timeout=1) is True
    assert agent_bridge.start.await_count == 2


@pytest.mark.parametrize("blocked_stage", ["repository", "skills", "opencode"])
async def test_clean_early_bridge_exit_cancels_pre_ready_startup(
    tmp_path, monkeypatch, blocked_stage
):
    supervisor, repository, opencode_server, agent_bridge, *_ = _supervisor(tmp_path, [])
    stage_started = asyncio.Event()
    stage_cancelled = asyncio.Event()

    async def block_stage(*_args):
        stage_started.set()
        try:
            await asyncio.Event().wait()
        finally:
            stage_cancelled.set()

    if blocked_stage == "repository":
        repository.boot.side_effect = block_stage
    elif blocked_stage == "skills":
        supervisor.managed_skills.materialize.side_effect = block_stage
    else:
        opencode_server.start.side_effect = block_stage

    agent_bridge.exit_code.return_value = 0
    supervisor._report_fatal_error = AsyncMock()
    monkeypatch.setattr(supervisor, "EARLY_BRIDGE_MONITOR_INTERVAL_SECONDS", 0.01)
    monkeypatch.setenv("EARLY_SANDBOX_CONNECTION", "1")
    monkeypatch.delenv("IMAGE_BUILD_MODE", raising=False)

    run_task = asyncio.create_task(supervisor.run())
    await stage_started.wait()

    assert await asyncio.wait_for(run_task, timeout=1) is True
    assert stage_cancelled.is_set()
    supervisor._report_fatal_error.assert_not_awaited()
    opencode_server.stop.assert_awaited_once()


async def test_early_bridge_crash_restarts_during_post_repository_startup(tmp_path, monkeypatch):
    supervisor, _repository, _opencode_server, agent_bridge, *_ = _supervisor(tmp_path, [])
    release_skills = asyncio.Event()
    skills_started = asyncio.Event()

    async def blocked_skills(*_args):
        skills_started.set()
        await release_skills.wait()

    async def start_bridge():
        if agent_bridge.start.await_count == 2:
            release_skills.set()

    supervisor.managed_skills.materialize.side_effect = blocked_skills
    agent_bridge.start.side_effect = start_bridge
    agent_bridge.exit_code.side_effect = [1, None]
    monkeypatch.setattr(supervisor, "_wait_for_shutdown", AsyncMock(return_value=False))
    monkeypatch.setattr(supervisor, "EARLY_BRIDGE_MONITOR_INTERVAL_SECONDS", 0.01)
    monkeypatch.setenv("EARLY_SANDBOX_CONNECTION", "1")
    monkeypatch.delenv("IMAGE_BUILD_MODE", raising=False)

    run_task = asyncio.create_task(supervisor.run())
    await skills_started.wait()

    assert await asyncio.wait_for(run_task, timeout=1) is True
    assert agent_bridge.start.await_count == 2


async def test_early_bridge_restart_budget_carries_into_steady_monitoring(tmp_path, monkeypatch):
    supervisor, _repository, _opencode_server, agent_bridge, *_ = _supervisor(tmp_path, [])
    release_terminal = asyncio.Event()
    terminal_started = asyncio.Event()

    async def blocked_terminal(*_args):
        terminal_started.set()
        await release_terminal.wait()

    async def start_bridge():
        if agent_bridge.start.await_count == 2:
            release_terminal.set()

    supervisor.web_terminal.start.side_effect = blocked_terminal
    agent_bridge.start.side_effect = start_bridge
    agent_bridge.exit_code.side_effect = [1, None]
    monkeypatch.setattr(supervisor, "_wait_for_shutdown", AsyncMock(return_value=False))
    monkeypatch.setattr(supervisor, "EARLY_BRIDGE_MONITOR_INTERVAL_SECONDS", 0.01)
    monkeypatch.setenv("EARLY_SANDBOX_CONNECTION", "1")
    monkeypatch.delenv("IMAGE_BUILD_MODE", raising=False)

    run_task = asyncio.create_task(supervisor.run())
    await terminal_started.wait()

    assert await asyncio.wait_for(run_task, timeout=1) is True
    supervisor.monitor_processes.assert_awaited_once_with(bridge_restarts=1)


async def test_early_bridge_restart_exhaustion_cancels_startup_and_reports_fatal(
    tmp_path, monkeypatch
):
    supervisor, _repository, opencode_server, agent_bridge, *_ = _supervisor(tmp_path, [])
    opencode_started = asyncio.Event()
    opencode_cancelled = asyncio.Event()

    async def blocked_opencode(*_args):
        opencode_started.set()
        try:
            await asyncio.Event().wait()
        finally:
            opencode_cancelled.set()

    opencode_server.start.side_effect = blocked_opencode
    agent_bridge.exit_code.return_value = 1
    supervisor.MAX_RESTARTS = 1
    supervisor._report_fatal_error = AsyncMock()
    monkeypatch.setattr(supervisor, "_wait_for_shutdown", AsyncMock(return_value=False))
    monkeypatch.setattr(supervisor, "EARLY_BRIDGE_MONITOR_INTERVAL_SECONDS", 0.01)
    monkeypatch.setenv("EARLY_SANDBOX_CONNECTION", "1")
    monkeypatch.delenv("IMAGE_BUILD_MODE", raising=False)

    run_task = asyncio.create_task(supervisor.run())
    await opencode_started.wait()

    assert await asyncio.wait_for(run_task, timeout=1) is False
    assert opencode_cancelled.is_set()
    assert agent_bridge.start.await_count == 2
    supervisor._report_fatal_error.assert_awaited_once_with("Bridge crashed 2 times, giving up")


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
    monkeypatch.setenv("EARLY_SANDBOX_CONNECTION", "1")
    callback = MagicMock()

    async def report_success(**_kwargs):
        supervisor.shutdown_event.set()
        return True

    callback.report_success = AsyncMock(side_effect=report_success)
    callback.report_failure = AsyncMock()

    assert await supervisor.run(callback) is True
    repository.boot.assert_awaited_once_with(BootMode.BUILD, [])
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
    monkeypatch.setattr("sandbox_runtime.supervisor.asyncio.sleep", AsyncMock())

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

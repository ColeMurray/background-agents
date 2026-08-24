import asyncio
from contextlib import suppress
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import httpx

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


async def test_boot_progress_runs_during_boot_and_is_awaited_before_bridge(tmp_path, monkeypatch):
    supervisor, repository, _opencode, agent_bridge, *_ = _supervisor(tmp_path, [])
    progress_started = asyncio.Event()
    progress_cancelled = asyncio.Event()
    release_boot = asyncio.Event()

    async def report_progress():
        progress_started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            progress_cancelled.set()
            raise

    async def boot(_mode, _ports):
        await progress_started.wait()
        await release_boot.wait()
        return RepositoryBootResult(True, [], True, True, (), tmp_path)

    async def start_bridge():
        assert supervisor._boot_progress_task is None

    supervisor._report_boot_progress = AsyncMock(side_effect=report_progress)
    repository.boot.side_effect = boot
    agent_bridge.start.side_effect = start_bridge
    monkeypatch.delenv("IMAGE_BUILD_MODE", raising=False)

    run_task = asyncio.create_task(supervisor.run())
    await progress_started.wait()
    assert not supervisor._boot_progress_task.done()
    release_boot.set()
    assert await run_task is True

    supervisor._report_boot_progress.assert_awaited()
    assert progress_cancelled.is_set()
    agent_bridge.start.assert_awaited_once()
    assert supervisor._boot_progress_task is None


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
    supervisor._report_boot_progress = AsyncMock()
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
    supervisor._report_boot_progress.assert_not_awaited()
    assert supervisor._boot_progress_task is None


async def test_boot_progress_network_failure_is_nonfatal_and_redacted(tmp_path, monkeypatch):
    supervisor, *_ = _supervisor(tmp_path, [])
    supervisor.config = RuntimeConfig.from_env(
        {
            "SANDBOX_ID": "sandbox-1",
            "REPO_OWNER": "acme",
            "REPO_NAME": "repo",
            "CONTROL_PLANE_URL": "https://control.example.com",
            "SANDBOX_AUTH_TOKEN": "secret-token",
            "SESSION_CONFIG": '{"session_id":"session/1"}',
        },
        workspace_path=tmp_path,
    )
    client = MagicMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    client.post = AsyncMock(side_effect=httpx.ConnectError("secret-token"))
    monkeypatch.setattr("sandbox_runtime.supervisor.httpx.AsyncClient", lambda: client)

    await supervisor._report_boot_progress()

    request_url = client.post.await_args.args[0]
    assert request_url.endswith("/sessions/session%2F1/boot-progress")
    supervisor.log.warn.assert_called_once_with(
        "supervisor.boot_progress_failed", error="ConnectError"
    )
    assert "secret-token" not in str(supervisor.log.warn.call_args)


async def test_boot_progress_loop_continues_after_unexpected_failure(tmp_path, monkeypatch):
    supervisor, *_ = _supervisor(tmp_path, [])
    supervisor._report_boot_progress = AsyncMock(
        side_effect=[RuntimeError("secret-token"), asyncio.CancelledError]
    )
    monkeypatch.setattr("sandbox_runtime.supervisor.asyncio.sleep", AsyncMock())

    with suppress(asyncio.CancelledError):
        await supervisor._boot_progress_loop()

    assert supervisor._report_boot_progress.await_count == 2
    supervisor.log.warn.assert_called_once_with(
        "supervisor.boot_progress_failed", error="RuntimeError"
    )
    assert "secret-token" not in str(supervisor.log.warn.call_args)


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

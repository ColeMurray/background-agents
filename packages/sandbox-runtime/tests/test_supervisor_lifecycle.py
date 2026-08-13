from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from sandbox_runtime.repository_boot import BootstrapResult
from sandbox_runtime.runtime_config import BootMode, RuntimeConfig
from sandbox_runtime.supervisor import SandboxSupervisor


def _process(returncode=None):
    return SimpleNamespace(returncode=returncode)


def _supervisor(tmp_path, events):
    config = RuntimeConfig.from_env(
        {"SANDBOX_ID": "sandbox-1", "REPO_OWNER": "acme", "REPO_NAME": "repo"},
        workspace_path=tmp_path,
    )
    result = BootstrapResult(
        git_sync_success=True,
        repository_shas=[],
        setup_success=True,
        start_success=True,
        repositories=(),
        workdir=Path(tmp_path),
    )
    repository = MagicMock()
    repository.expected_tunnel_ports.return_value = []

    async def bootstrap(mode, _ports):
        events.append(f"repository:{mode.value}")
        return result

    repository.bootstrap = AsyncMock(side_effect=bootstrap)
    core = MagicMock()
    core.opencode_exit_code.return_value = None
    core.bridge_exit_code.return_value = None

    async def start_opencode(_repositories, _workdir):
        events.append("opencode")

    async def start_bridge():
        events.append("bridge")

    core.start_opencode = AsyncMock(side_effect=start_opencode)
    core.start_bridge = AsyncMock(side_effect=start_bridge)
    core.stop_bridge = AsyncMock()
    core.stop_opencode = AsyncMock()
    access = MagicMock()
    access.ttyd_started.return_value = False
    access.code_server_exit_code.return_value = None
    access.ttyd_exit_code.return_value = None
    access.ttyd_proxy_exit_code.return_value = None
    access.crashed_vnc.return_value = None

    async def start_vnc():
        events.append("vnc")

    access.start_vnc = AsyncMock(side_effect=start_vnc)
    access.start_code_server = AsyncMock(side_effect=lambda _workdir: events.append("code_server"))
    access.start_ttyd = AsyncMock(side_effect=lambda _workdir: events.append("ttyd"))
    access.stop_vnc = AsyncMock()
    access.stop = AsyncMock()
    supervisor = SandboxSupervisor(
        config, repository, core, access, __import__("asyncio").Event(), MagicMock()
    )
    supervisor.monitor_processes = AsyncMock()
    return supervisor, repository, core, access


async def test_regular_boot_phase_order(tmp_path, monkeypatch):
    events = []
    supervisor, _repository, _core, _access = _supervisor(tmp_path, events)
    monkeypatch.delenv("IMAGE_BUILD_MODE", raising=False)
    monkeypatch.delenv("RESTORED_FROM_SNAPSHOT", raising=False)
    monkeypatch.delenv("FROM_REPO_IMAGE", raising=False)

    assert await supervisor.run() is True

    assert events == ["vnc", "repository:fresh", "code_server", "ttyd", "opencode", "bridge"]


async def test_regular_boot_passes_bootstrap_workspace_to_services(tmp_path, monkeypatch):
    supervisor, repository, core, access = _supervisor(tmp_path, [])
    repositories = (MagicMock(),)
    workdir = tmp_path / "repo"
    repository.bootstrap.side_effect = None
    repository.bootstrap.return_value = BootstrapResult(
        git_sync_success=True,
        repository_shas=[],
        setup_success=True,
        start_success=True,
        repositories=repositories,
        workdir=workdir,
    )
    monkeypatch.delenv("IMAGE_BUILD_MODE", raising=False)
    monkeypatch.delenv("RESTORED_FROM_SNAPSHOT", raising=False)
    monkeypatch.delenv("FROM_REPO_IMAGE", raising=False)

    await supervisor.run()

    core.start_opencode.assert_awaited_once_with(repositories, workdir)
    access.start_code_server.assert_awaited_once_with(workdir)
    access.start_ttyd.assert_awaited_once_with(workdir)


async def test_build_boot_excludes_runtime_services(tmp_path, monkeypatch):
    events = []
    supervisor, repository, core, access = _supervisor(tmp_path, events)
    monkeypatch.setenv("IMAGE_BUILD_MODE", "true")
    callback = MagicMock()

    async def report_success(**_kwargs):
        supervisor.shutdown_event.set()
        return True

    callback.report_success = AsyncMock(side_effect=report_success)
    callback.report_failure = AsyncMock()

    assert await supervisor.run(callback) is True

    repository.bootstrap.assert_awaited_once_with(BootMode.BUILD, [])
    access.start_vnc.assert_not_awaited()
    core.start_opencode.assert_not_awaited()
    core.start_bridge.assert_not_awaited()


async def test_graceful_bridge_exit_requests_shutdown(tmp_path):
    supervisor, _repository, core, _access = _supervisor(tmp_path, [])
    core.bridge_exit_code.return_value = 0

    await SandboxSupervisor.monitor_processes(supervisor)

    assert supervisor.shutdown_event.is_set()
    core.start_bridge.assert_not_awaited()


async def test_bridge_restart_exhaustion_is_fatal(tmp_path, monkeypatch):
    supervisor, _repository, core, _access = _supervisor(tmp_path, [])
    core.bridge_exit_code.return_value = 1
    supervisor._report_fatal_error = AsyncMock()

    async def no_delay(_seconds):
        return None

    monkeypatch.setattr("sandbox_runtime.supervisor.asyncio.sleep", no_delay)
    await SandboxSupervisor.monitor_processes(supervisor)

    assert core.start_bridge.await_count == supervisor.MAX_RESTARTS
    supervisor._report_fatal_error.assert_awaited_once()
    assert supervisor.shutdown_event.is_set()


async def test_optional_service_restart_exhaustion_is_nonfatal(tmp_path, monkeypatch):
    supervisor, _repository, _core, access = _supervisor(tmp_path, [])
    access.code_server_exit_code.return_value = 1
    supervisor._report_fatal_error = AsyncMock()

    async def no_delay(_seconds):
        if access.abandon_code_server.called:
            supervisor.shutdown_event.set()

    monkeypatch.setattr("sandbox_runtime.supervisor.asyncio.sleep", no_delay)
    await SandboxSupervisor.monitor_processes(supervisor)

    supervisor._report_fatal_error.assert_not_awaited()

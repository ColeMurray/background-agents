import asyncio
import json
import socket
from contextlib import suppress
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import httpx

from sandbox_runtime.agent_bridge_process import (
    AgentBridgeProcess,
    BridgeStartupError,
    LocalControlDeliveryError,
)
from sandbox_runtime.opencode_server import OpenCodeHealthTimeoutError
from sandbox_runtime.repository_boot import PrimaryStartError, RepositoryBootResult
from sandbox_runtime.runtime_config import BootMode, RuntimeConfig
from sandbox_runtime.supervisor import SandboxSupervisor
from sandbox_runtime.types import BootFailureCode, BootPhase

TEST_ASYNC_TIMEOUT_SECONDS = 1.0


def _supervisor(tmp_path, events):
    config = RuntimeConfig.from_env(
        {"SANDBOX_ID": "sandbox-1", "REPO_OWNER": "acme", "REPO_NAME": "repo"},
        workspace_path=tmp_path,
    )
    result = RepositoryBootResult(True, [], True, True, (), Path(tmp_path))
    repository = MagicMock()
    repository.prepare_tunnel_environment.return_value = []
    repository.boot = AsyncMock(
        side_effect=lambda mode, _ports, *_args: events.append(f"repository:{mode.value}") or result
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
    agent_bridge.set_boot_phase = AsyncMock()
    agent_bridge.execution_dependencies_ready = AsyncMock()
    agent_bridge.execution_dependencies_unavailable = AsyncMock()
    agent_bridge.boot_failed = AsyncMock()
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


async def test_v2_bridge_starts_before_interactive_boot_and_signals_ready(tmp_path, monkeypatch):
    events = []
    supervisor, _repository, _opencode, bridge, *_ = _supervisor(tmp_path, events)
    supervisor.config = RuntimeConfig.from_env(
        {
            "SANDBOX_ID": "sandbox-1",
            "REPO_OWNER": "acme",
            "REPO_NAME": "repo",
            "SANDBOX_CONTROL_PROTOCOL_VERSION": "2",
        },
        workspace_path=tmp_path,
    )
    supervisor._report_boot_progress = AsyncMock()
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
    bridge.execution_dependencies_ready.assert_awaited_once()
    supervisor.monitor_processes.assert_awaited_once()
    supervisor._report_boot_progress.assert_not_called()


async def test_v2_bridge_restarts_while_repository_boot_is_blocked(tmp_path, monkeypatch):
    supervisor, repository, _opencode, bridge, *_ = _supervisor(tmp_path, [])
    supervisor.config = RuntimeConfig.from_env(
        {"SANDBOX_CONTROL_PROTOCOL_VERSION": "2"}, workspace_path=tmp_path
    )
    supervisor.monitor_processes = SandboxSupervisor.monitor_processes.__get__(supervisor)
    supervisor._report_fatal_error = AsyncMock()
    repository_blocked = asyncio.Event()
    release_repository = asyncio.Event()
    bridge_crashed = False

    async def boot(_mode, _ports, _phase_callback):
        repository_blocked.set()
        await release_repository.wait()
        return RepositoryBootResult(True, [], True, True, (), tmp_path)

    async def start_bridge():
        nonlocal bridge_crashed
        if bridge.start.await_count > 1:
            bridge_crashed = False
            release_repository.set()
            supervisor.shutdown_event.set()

    async def wait_for_shutdown(_delay):
        await asyncio.sleep(0)
        return supervisor.shutdown_event.is_set()

    repository.boot.side_effect = boot
    bridge.start.side_effect = start_bridge
    bridge.exit_code.side_effect = lambda: 1 if bridge_crashed else None
    monkeypatch.setattr(supervisor, "_wait_for_shutdown", wait_for_shutdown)
    monkeypatch.delenv("IMAGE_BUILD_MODE", raising=False)
    monkeypatch.delenv("RESTORED_FROM_SNAPSHOT", raising=False)
    monkeypatch.delenv("FROM_REPO_IMAGE", raising=False)

    run_task = asyncio.create_task(supervisor.run())
    await repository_blocked.wait()
    bridge_crashed = True
    assert await asyncio.wait_for(run_task, timeout=1) is True

    assert bridge.start.await_count == 2


async def test_v2_bridge_restart_consumes_startup_failures_while_repository_is_blocked(
    tmp_path, monkeypatch
):
    supervisor, repository, _opencode, bridge, *_ = _supervisor(tmp_path, [])
    supervisor.config = RuntimeConfig.from_env(
        {"SANDBOX_CONTROL_PROTOCOL_VERSION": "2"}, workspace_path=tmp_path
    )
    supervisor.monitor_processes = SandboxSupervisor.monitor_processes.__get__(supervisor)
    supervisor._report_fatal_error = AsyncMock()
    repository_blocked = asyncio.Event()
    release_repository = asyncio.Event()
    bridge_crashed = False

    async def boot(_mode, _ports, _phase_callback):
        repository_blocked.set()
        await release_repository.wait()
        return RepositoryBootResult(True, [], True, True, (), tmp_path)

    async def start_bridge():
        nonlocal bridge_crashed
        if bridge.start.await_count == 2:
            raise BridgeStartupError("replacement failed")
        if bridge.start.await_count == 3:
            bridge_crashed = False
            release_repository.set()
            supervisor.shutdown_event.set()

    async def wait_for_shutdown(_delay):
        await asyncio.sleep(0)
        return supervisor.shutdown_event.is_set()

    repository.boot.side_effect = boot
    bridge.start.side_effect = start_bridge
    bridge.exit_code.side_effect = lambda: 1 if bridge_crashed else None
    monkeypatch.setattr(supervisor, "_wait_for_shutdown", wait_for_shutdown)
    monkeypatch.delenv("IMAGE_BUILD_MODE", raising=False)
    monkeypatch.delenv("RESTORED_FROM_SNAPSHOT", raising=False)
    monkeypatch.delenv("FROM_REPO_IMAGE", raising=False)

    run_task = asyncio.create_task(supervisor.run())
    await repository_blocked.wait()
    bridge_crashed = True
    assert await asyncio.wait_for(run_task, timeout=1) is True

    assert bridge.start.await_count == 3
    supervisor._report_fatal_error.assert_not_awaited()


async def test_ready_result_timeout_restarts_bridge_and_replays_ready_state(tmp_path, monkeypatch):
    supervisor, _repository, _opencode, bridge, *_ = _supervisor(tmp_path, [])
    supervisor.config = RuntimeConfig.from_env(
        {"SANDBOX_CONTROL_PROTOCOL_VERSION": "2"}, workspace_path=tmp_path
    )
    replacement_states = []

    async def signal_ready():
        bridge._desired_state = {"type": "execution_dependencies_ready"}
        raise LocalControlDeliveryError("execution_dependencies_ready", "result_timeout")

    async def restart_bridge():
        replacement_states.append(bridge._desired_state)

    bridge.execution_dependencies_ready.side_effect = signal_ready
    bridge.start.side_effect = restart_bridge
    bridge.stop = AsyncMock()
    monkeypatch.setattr(supervisor, "_wait_for_shutdown", AsyncMock(return_value=False))

    await supervisor._signal_execution_dependencies_ready()

    bridge.stop.assert_awaited_once()
    bridge.start.assert_awaited_once()
    assert replacement_states == [{"type": "execution_dependencies_ready"}]


async def test_ready_replay_timeout_consumes_budget_before_later_replacement_acks(
    tmp_path, monkeypatch
):
    supervisor, _repository, _opencode, _bridge, *_ = _supervisor(tmp_path, [])
    supervisor.config = RuntimeConfig.from_env(
        {
            "SANDBOX_CONTROL_PROTOCOL_VERSION": "2",
            "CONTROL_PLANE_URL": "https://control.example.com",
            "SANDBOX_AUTH_TOKEN": "token",
            "SESSION_CONFIG": '{"session_id":"session-1"}',
        },
        workspace_path=tmp_path,
    )
    bridge = AgentBridgeProcess(supervisor.config.bridge_process_config(), MagicMock())
    bridge._desired_state = {
        "type": "execution_dependencies_ready",
        "requestId": "ready-replay",
    }
    initial_process = MagicMock(returncode=None)
    initial_process.wait = AsyncMock(return_value=0)
    bridge._process = initial_process
    supervisor.agent_bridge = bridge
    child_sockets = []
    responder_tasks = []

    async def create_subprocess(*_args, **kwargs):
        child = socket.fromfd(kwargs["pass_fds"][0], socket.AF_UNIX, socket.SOCK_STREAM)
        child.setblocking(False)
        child_sockets.append(child)
        replacement_number = len(child_sockets)
        if replacement_number == 2:

            async def respond():
                payload = await asyncio.get_running_loop().sock_recv(child, 4096)
                request = json.loads(payload)
                await asyncio.get_running_loop().sock_sendall(
                    child,
                    json.dumps(
                        {
                            "type": "execution_ready",
                            "requestId": request["requestId"],
                        }
                    ).encode()
                    + b"\n",
                )

            responder_tasks.append(asyncio.create_task(respond()))
        child_process = MagicMock(returncode=None, stdout=None)
        child_process.wait = AsyncMock(return_value=0)
        return child_process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", create_subprocess)
    monkeypatch.setattr(asyncio, "sleep", AsyncMock())
    monkeypatch.setattr(
        "sandbox_runtime.agent_bridge_process.EXECUTION_READY_RESULT_TIMEOUT_SECONDS",
        0.01,
    )
    monkeypatch.setattr(supervisor, "_wait_for_shutdown", AsyncMock(return_value=False))

    assert await supervisor._restart_bridge(stop_current=True, expected_process=initial_process)

    assert supervisor._bridge_restart_count == 2
    assert len(child_sockets) == 2
    await bridge.stop()
    await asyncio.gather(*responder_tasks)
    for child in child_sockets:
        child.close()


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
    await asyncio.wait_for(progress_started.wait(), timeout=TEST_ASYNC_TIMEOUT_SECONDS)
    assert not supervisor._boot_progress_task.done()
    release_boot.set()
    assert await asyncio.wait_for(run_task, timeout=TEST_ASYNC_TIMEOUT_SECONDS) is True

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
    supervisor.config = RuntimeConfig.from_env(
        {"SANDBOX_CONTROL_PROTOCOL_VERSION": "2"}, workspace_path=tmp_path
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


async def test_v2_opencode_restart_revokes_execution_before_backoff(tmp_path, monkeypatch):
    events = []
    supervisor, _repository, opencode_server, bridge, *_ = _supervisor(tmp_path, events)
    supervisor.config = RuntimeConfig.from_env(
        {"SANDBOX_CONTROL_PROTOCOL_VERSION": "2"}, workspace_path=tmp_path
    )
    supervisor._repository_boot_result = RepositoryBootResult(True, [], True, True, (), tmp_path)
    opencode_server.exit_code.return_value = 1

    async def unavailable(*_args):
        events.append("unavailable")

    async def wait(_delay):
        events.append("backoff")
        return True

    bridge.execution_dependencies_unavailable.side_effect = unavailable
    monkeypatch.setattr(supervisor, "_wait_for_shutdown", wait)

    await supervisor._handle_opencode_exit(0)

    assert events == ["unavailable", "backoff"]


async def test_v2_boot_failure_uses_control_channel(tmp_path, monkeypatch):
    supervisor, repository, _opencode_server, bridge, *_ = _supervisor(tmp_path, [])
    supervisor.config = RuntimeConfig.from_env(
        {"SANDBOX_CONTROL_PROTOCOL_VERSION": "2"}, workspace_path=tmp_path
    )
    repository.boot.side_effect = RuntimeError("secret repository output")
    supervisor._report_fatal_error = AsyncMock()
    monkeypatch.delenv("IMAGE_BUILD_MODE", raising=False)
    monkeypatch.delenv("RESTORED_FROM_SNAPSHOT", raising=False)
    monkeypatch.delenv("FROM_REPO_IMAGE", raising=False)

    assert await supervisor.run() is False

    bridge.boot_failed.assert_awaited_once_with(BootFailureCode.REPOSITORY_BOOT_FAILED)
    supervisor._report_fatal_error.assert_not_awaited()


async def test_primary_start_failure_uses_stable_failure_code(tmp_path, monkeypatch):
    supervisor, repository, _opencode_server, bridge, *_ = _supervisor(tmp_path, [])
    supervisor.config = RuntimeConfig.from_env(
        {"SANDBOX_CONTROL_PROTOCOL_VERSION": "2"}, workspace_path=tmp_path
    )
    repository.boot.side_effect = PrimaryStartError("primary failed")
    monkeypatch.delenv("IMAGE_BUILD_MODE", raising=False)
    monkeypatch.delenv("RESTORED_FROM_SNAPSHOT", raising=False)
    monkeypatch.delenv("FROM_REPO_IMAGE", raising=False)

    assert await supervisor.run() is False

    bridge.boot_failed.assert_awaited_once_with(BootFailureCode.PRIMARY_START_FAILED)


async def test_managed_skills_materialization_timeout_is_fatal_and_cancels(tmp_path, monkeypatch):
    supervisor, _repository, _opencode_server, bridge, *_ = _supervisor(tmp_path, [])
    supervisor.config = RuntimeConfig.from_env(
        {"SANDBOX_CONTROL_PROTOCOL_VERSION": "2"}, workspace_path=tmp_path
    )
    materialization_started = asyncio.Event()
    materialization_cancelled = asyncio.Event()

    async def materialize(*_args):
        materialization_started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            materialization_cancelled.set()
            raise

    supervisor.managed_skills.materialize.side_effect = materialize
    monkeypatch.setattr(
        "sandbox_runtime.supervisor.MANAGED_SKILLS_MATERIALIZATION_TIMEOUT_SECONDS", 0.01
    )
    monkeypatch.delenv("IMAGE_BUILD_MODE", raising=False)
    monkeypatch.delenv("RESTORED_FROM_SNAPSHOT", raising=False)
    monkeypatch.delenv("FROM_REPO_IMAGE", raising=False)

    assert await supervisor.run() is False

    assert materialization_started.is_set()
    assert materialization_cancelled.is_set()
    bridge.boot_failed.assert_awaited_once_with(BootFailureCode.MANAGED_SKILLS_FAILED)


async def test_opencode_health_timeout_uses_health_phase_and_code(tmp_path, monkeypatch):
    supervisor, _repository, opencode_server, bridge, *_ = _supervisor(tmp_path, [])
    supervisor.config = RuntimeConfig.from_env(
        {"SANDBOX_CONTROL_PROTOCOL_VERSION": "2"}, workspace_path=tmp_path
    )
    opencode_server.start.side_effect = OpenCodeHealthTimeoutError("not healthy")
    monkeypatch.delenv("IMAGE_BUILD_MODE", raising=False)
    monkeypatch.delenv("RESTORED_FROM_SNAPSHOT", raising=False)
    monkeypatch.delenv("FROM_REPO_IMAGE", raising=False)

    assert await supervisor.run() is False

    bridge.set_boot_phase.assert_awaited_with(BootPhase.OPENCODE_HEALTH)
    bridge.boot_failed.assert_awaited_once_with(BootFailureCode.OPENCODE_HEALTH_TIMEOUT)


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

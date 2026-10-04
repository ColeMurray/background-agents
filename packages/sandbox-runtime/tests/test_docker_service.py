"""DockerService owns dockerd from start through clean stop, deterministically.

The fakes implement a real readiness handshake: the fake daemon installs its
SIGTERM handler and only then publishes a ready marker, and the fake
``docker info`` succeeds only once that marker exists. The service therefore
cannot observe readiness before the daemon can honor a clean stop, which is
also the production contract (``docker info`` succeeds only once the daemon
serves the socket).
"""

from __future__ import annotations

import asyncio
import os
import sys
from dataclasses import dataclass, field
from unittest.mock import AsyncMock

import pytest

from sandbox_runtime import docker_service as docker_module
from sandbox_runtime.docker_control import DockerControl, request
from sandbox_runtime.docker_service import DockerService
from sandbox_runtime.runtime_config import BootMode
from tests.test_supervisor_lifecycle import _supervisor


@dataclass
class FakeProcesses:
    ready_marker: str
    daemon_exit: int = 0
    probe_delay: float = 0.0
    fail_probe: bool = False
    ignore_sigterm: bool = False
    exit_delay: float = 0.0
    children: list[asyncio.subprocess.Process] = field(default_factory=list)
    spawns: list[tuple[str, ...]] = field(default_factory=list)

    def daemon_program(self) -> str:
        handler = (
            "signal.SIG_IGN"
            if self.ignore_sigterm
            else "lambda *_: (signal.signal(signal.SIGTERM, signal.SIG_IGN), "
            f"time.sleep({self.exit_delay}), sys.exit({self.daemon_exit}))"
        )
        return (
            "import signal, sys, time, pathlib; "
            f"signal.signal(signal.SIGTERM, {handler}); "
            f"pathlib.Path({self.ready_marker!r}).write_text('ready'); "
            "time.sleep(300)"
        )

    def probe_program(self) -> str:
        return (
            "import sys, time, pathlib; "
            f"time.sleep({self.probe_delay}); "
            f"sys.exit(1 if {self.fail_probe} or not pathlib.Path({self.ready_marker!r}).exists() else 0)"
        )


@pytest.fixture
def processes(monkeypatch, tmp_path):
    fakes = FakeProcesses(ready_marker=str(tmp_path / "dockerd.ready"))
    real_spawn = asyncio.create_subprocess_exec

    async def spawn(command, *args, **kwargs):
        fakes.spawns.append((command, *args))
        assert kwargs.get("start_new_session") is True
        if command == "dockerd":
            program = fakes.daemon_program()
        elif command == "docker":
            assert kwargs["env"] == {
                "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                "HOME": "/root",
            }
            program = fakes.probe_program()
        else:  # pragma: no cover - the service spawns nothing else
            raise AssertionError(command)
        process = await real_spawn(sys.executable, "-c", program, **kwargs)
        fakes.children.append(process)
        return process

    monkeypatch.setattr(docker_module.asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(docker_module, "DOCKER_PROBE_INTERVAL_SECONDS", 0.01)
    yield fakes
    for child in fakes.children:
        if child.returncode is None:
            child.kill()


def _service(tmp_path, **kwargs) -> DockerService:
    class Log:
        def __init__(self):
            self.events: list[str] = []

        def info(self, event, **_fields):
            self.events.append(event)

        def error(self, event, **_fields):
            self.events.append(event)

    service = DockerService(Log(), log_path=str(tmp_path / "dockerd.log"), **kwargs)
    return service


def _session_supervisor(tmp_path, service):
    supervisor, *_ = _supervisor(tmp_path, [])
    supervisor.docker_service = service
    supervisor.docker_control = DockerControl(
        service, str(tmp_path / "control.sock"), supervisor._recover_docker_after_prepare
    )
    return supervisor


def _group_gone(process: asyncio.subprocess.Process) -> bool:
    try:
        os.killpg(process.pid, 0)
    except ProcessLookupError:
        return True
    return False


async def _until(predicate, timeout: float = 10.0) -> None:
    """Bounded wait: a regression fails the test instead of hanging it."""
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(0.01)


async def test_ready_then_clean_preparation_leaves_no_owned_process(processes, tmp_path):
    service = _service(tmp_path)

    await service.start()
    daemon = processes.children[0]
    assert daemon.returncode is None
    assert processes.spawns[0] == ("dockerd", "--host", "unix:///var/run/docker.sock")
    assert processes.spawns[1] == ("docker", "--host", "unix:///var/run/docker.sock", "info")

    await service.prepare_for_snapshot()

    assert daemon.returncode == 0
    assert _group_gone(daemon)
    assert service.exit_expected is True
    await service.stop()
    assert all(child.returncode is not None for child in processes.children)


async def test_startup_deadline_has_its_own_diagnostic_and_reaps_the_daemon(processes, tmp_path):
    processes.fail_probe = True
    service = _service(tmp_path, start_timeout_seconds=0.3)

    with pytest.raises(RuntimeError, match="startup deadline"):
        await service.start()

    assert all(child.returncode is not None for child in processes.children)
    assert all(_group_gone(child) for child in processes.children)


async def test_daemon_exit_during_startup_is_reported(processes, tmp_path):
    processes.fail_probe = True
    service = _service(tmp_path, start_timeout_seconds=60)
    started = asyncio.create_task(service.start())
    await _until(lambda: bool(processes.children))
    processes.children[0].kill()

    with pytest.raises(RuntimeError, match="exited during startup"):
        await started


async def test_cancellation_during_probe_reaps_both_process_groups(processes, tmp_path):
    processes.probe_delay = 300
    service = _service(tmp_path, start_timeout_seconds=60)
    started = asyncio.create_task(service.start())
    await _until(lambda: len(processes.children) >= 2)

    started.cancel()
    with pytest.raises(asyncio.CancelledError):
        await started

    assert all(child.returncode is not None for child in processes.children)
    assert all(_group_gone(child) for child in processes.children)


async def test_nonzero_daemon_exit_cannot_be_a_prepared_build(processes, tmp_path):
    processes.daemon_exit = 1
    service = _service(tmp_path)
    await service.start()
    watcher = asyncio.create_task(service.wait())
    await asyncio.sleep(0)

    with pytest.raises(RuntimeError, match="did not stop cleanly"):
        await service.prepare_for_snapshot()

    assert await watcher == 1
    assert service.exit_expected is True
    await service.stop()
    assert all(child.returncode is not None for child in processes.children)


async def test_unexpected_exit_is_observable_and_not_a_requested_stop(processes, tmp_path):
    service = _service(tmp_path)
    await service.start()
    daemon = processes.children[0]

    daemon.kill()
    assert await service.wait() != 0
    assert service.exit_expected is False

    await service.stop()
    assert service.exit_expected is True


async def test_daemon_that_ignores_sigterm_is_killed_and_never_a_prepared_build(
    processes, tmp_path
):
    processes.ignore_sigterm = True
    service = _service(tmp_path, stop_timeout_seconds=0.3)
    await service.start()
    daemon = processes.children[0]

    with pytest.raises(RuntimeError, match="clean shutdown deadline"):
        await service.prepare_for_snapshot()

    assert service.exit_expected is True
    assert daemon.returncode is not None
    assert _group_gone(daemon)


async def test_preparation_requires_a_running_daemon(processes, tmp_path):
    service = _service(tmp_path)
    with pytest.raises(RuntimeError, match="exited before build preparation"):
        await service.prepare_for_snapshot()

    await service.start()
    processes.children[0].kill()
    await service.wait()
    with pytest.raises(RuntimeError, match="exited before build preparation"):
        await service.prepare_for_snapshot()
    await service.stop()


@pytest.mark.parametrize("failure", ["ignored", "late", "nonzero", "cancelled"])
async def test_failed_session_preparation_recovers_and_can_retry(
    processes, tmp_path, monkeypatch, failure
):
    from sandbox_runtime import docker_control

    processes.ignore_sigterm = failure in ("ignored", "cancelled")
    processes.exit_delay = 0.15 if failure == "late" else 0
    processes.daemon_exit = 2 if failure == "nonzero" else 0
    service = _service(tmp_path, stop_timeout_seconds=0.1, start_timeout_seconds=0.5)
    supervisor = _session_supervisor(tmp_path, service)
    supervisor._report_fatal_error = AsyncMock()
    preparation_timeout = docker_control.PREPARATION_TIMEOUT_SECONDS
    if failure == "cancelled":
        monkeypatch.setattr(docker_control, "PREPARATION_TIMEOUT_SECONDS", 0.02)
    try:
        await supervisor._start_docker()
        first_daemon = processes.children[0]
        processes.ignore_sigterm = False
        processes.exit_delay = 0
        processes.daemon_exit = 0
        with pytest.raises(RuntimeError, match="confirmed shutdown"):
            await request("prepare", supervisor.docker_control.path)
        assert first_daemon.returncode is not None
        if failure == "late":
            assert first_daemon.returncode == 0
        assert not supervisor.docker_control.prepared
        with pytest.raises(RuntimeError):
            await request("status", supervisor.docker_control.path)
        assert not supervisor.shutdown_event.is_set()
        assert supervisor._docker_watch_failure is None
        supervisor._report_fatal_error.assert_not_awaited()
        assert service._process is not None and service._process.returncode is None
        assert not any(
            call.args == ("docker.exited_unexpectedly",)
            for call in supervisor.log.error.call_args_list
        )

        if failure == "cancelled":
            monkeypatch.setattr(docker_control, "PREPARATION_TIMEOUT_SECONDS", preparation_timeout)
        await request("prepare", supervisor.docker_control.path)
        assert supervisor.docker_control.prepared
        assert not supervisor.shutdown_event.is_set()
        assert supervisor._docker_watch_failure is None
        assert len([spawn for spawn in processes.spawns if spawn[0] == "dockerd"]) == 2
    finally:
        await supervisor._stop_docker_watch()
        await supervisor.shutdown()


async def test_failed_preparation_restart_failure_is_reported(processes, tmp_path):
    processes.daemon_exit = 1
    service = _service(tmp_path, stop_timeout_seconds=0.1, start_timeout_seconds=0.2)
    supervisor = _session_supervisor(tmp_path, service)
    try:
        await supervisor._start_docker()
        processes.fail_probe = True
        with pytest.raises((RuntimeError, TimeoutError)):
            await request("prepare", supervisor.docker_control.path)
        await _until(supervisor.shutdown_event.is_set, timeout=2)
        assert any(
            call.args == ("docker.exited_unexpectedly",)
            for call in supervisor.log.error.call_args_list
        )
        assert supervisor._docker_watch_failure is not None
    finally:
        await supervisor._stop_docker_watch()
        await supervisor.shutdown()


async def test_clean_session_preparation_does_not_restart(processes, tmp_path):
    service = _service(tmp_path)
    supervisor = _session_supervisor(tmp_path, service)
    supervisor.boot_mode = BootMode.SNAPSHOT_RESTORE
    try:
        await supervisor._start_docker()
        await request("prepare", supervisor.docker_control.path)
        await request("status", supervisor.docker_control.path)
        assert supervisor.docker_control.prepared
        assert not supervisor.shutdown_event.is_set()
        assert len([spawn for spawn in processes.spawns if spawn[0] == "dockerd"]) == 1
    finally:
        await supervisor._stop_docker_watch()
        await supervisor.shutdown()


async def test_unrequested_exit_before_preparation_remains_fatal(processes, tmp_path):
    service = _service(tmp_path)
    supervisor = _session_supervisor(tmp_path, service)
    try:
        await supervisor._start_docker()
        processes.children[0].kill()
        await processes.children[0].wait()
        with pytest.raises(RuntimeError):
            await request("prepare", supervisor.docker_control.path)
        await _until(supervisor.shutdown_event.is_set)
        assert supervisor._docker_watch_failure is not None
        assert len([spawn for spawn in processes.spawns if spawn[0] == "dockerd"]) == 1
    finally:
        await supervisor._stop_docker_watch()
        await supervisor.shutdown()


async def test_restarted_daemon_is_watched_for_crashes(processes, tmp_path):
    processes.daemon_exit = 1
    service = _service(tmp_path, stop_timeout_seconds=0.1)
    supervisor = _session_supervisor(tmp_path, service)
    try:
        await supervisor._start_docker()
        with pytest.raises(RuntimeError):
            await request("prepare", supervisor.docker_control.path)
        assert not supervisor.shutdown_event.is_set()
        assert service._process is not None
        service._process.kill()
        await _until(supervisor.shutdown_event.is_set)
        assert "exited unexpectedly" in str(supervisor._docker_watch_failure)
    finally:
        await supervisor._stop_docker_watch()
        await supervisor.shutdown()


async def test_requested_stop_is_not_reported_as_a_crash(processes, tmp_path):
    service = _service(tmp_path, stop_timeout_seconds=0.1)
    supervisor = _session_supervisor(tmp_path, service)
    try:
        await supervisor._start_docker()
        await service.stop()
        await _until(supervisor._docker_watch_task.done)
        assert not supervisor.shutdown_event.is_set()
        assert supervisor._docker_watch_failure is None
    finally:
        await supervisor._stop_docker_watch()
        await supervisor.shutdown()


@pytest.mark.parametrize(
    "budgets",
    [
        {"stop_timeout_seconds": 70},
        {"start_timeout_seconds": 61},
    ],
)
async def test_control_rejects_service_budgets_beyond_capture_deadline(tmp_path, budgets):
    service = _service(tmp_path, **budgets)
    control = DockerControl(service, str(tmp_path / "control.sock"))

    with pytest.raises(ValueError, match="Docker control deadline"):
        await control.start()

    assert not (tmp_path / "control.sock").exists()


async def test_shutdown_during_preparation_does_not_restart_docker(processes, tmp_path):
    processes.ignore_sigterm = True
    service = _service(tmp_path, stop_timeout_seconds=0.1)
    supervisor = _session_supervisor(tmp_path, service)
    try:
        await supervisor._start_docker()
        preparing = asyncio.create_task(request("prepare", supervisor.docker_control.path))
        await _until(lambda: service.exit_expected)

        await asyncio.wait_for(supervisor.shutdown(), timeout=3)
        with pytest.raises(RuntimeError):
            await preparing

        assert len([spawn for spawn in processes.spawns if spawn[0] == "dockerd"]) == 1
        assert all(process.returncode is not None for process in processes.children)
        assert supervisor._docker_watch_failure is None
    finally:
        await supervisor._stop_docker_watch()
        await supervisor.shutdown()


async def test_shutdown_cancels_inflight_recovery_without_watcher(processes, tmp_path):
    processes.daemon_exit = 1
    service = _service(tmp_path, stop_timeout_seconds=0.1)
    supervisor = _session_supervisor(tmp_path, service)
    restart_entered = asyncio.Event()
    finish_restart = asyncio.Event()
    try:
        await supervisor._start_docker()
        original_start = service.start

        async def delayed_restart():
            restart_entered.set()
            await finish_restart.wait()
            await original_start()

        service.start = delayed_restart
        preparing = asyncio.create_task(request("prepare", supervisor.docker_control.path))
        await asyncio.wait_for(restart_entered.wait(), timeout=2)

        shutdown = asyncio.create_task(supervisor.shutdown())
        await _until(lambda: supervisor.docker_control.stopping)
        finish_restart.set()
        await asyncio.wait_for(shutdown, timeout=2)
        with pytest.raises(RuntimeError):
            await preparing

        assert supervisor._docker_watch_task is None
        assert supervisor._docker_watch_failure is None
        assert len([spawn for spawn in processes.spawns if spawn[0] == "dockerd"]) == 1
        assert all(process.returncode is not None for process in processes.children)
    finally:
        finish_restart.set()
        await supervisor._stop_docker_watch()
        await supervisor.shutdown()

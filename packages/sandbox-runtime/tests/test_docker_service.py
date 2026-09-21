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

import pytest

from sandbox_runtime import docker_service as docker_module
from sandbox_runtime.docker_service import DockerService


@dataclass
class FakeProcesses:
    ready_marker: str
    daemon_exit: int = 0
    probe_delay: float = 0.0
    fail_probe: bool = False
    children: list[asyncio.subprocess.Process] = field(default_factory=list)

    def daemon_program(self) -> str:
        return (
            "import signal, sys, time, pathlib; "
            f"signal.signal(signal.SIGTERM, lambda *_: sys.exit({self.daemon_exit})); "
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
        if command == "dockerd":
            program = fakes.daemon_program()
        elif command == "docker":
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


def _group_gone(process: asyncio.subprocess.Process) -> bool:
    try:
        os.killpg(process.pid, 0)
    except ProcessLookupError:
        return True
    return False


async def test_ready_then_clean_preparation_leaves_no_owned_process(processes, tmp_path):
    service = _service(tmp_path)

    await service.start()
    daemon = processes.children[0]
    assert daemon.returncode is None
    assert "docker.ready" in service.log.events

    await service.prepare_for_snapshot()

    assert daemon.returncode == 0
    assert _group_gone(daemon)
    assert service.stopping is True
    await service.stop()
    assert all(child.returncode is not None for child in processes.children)
    assert "docker.prepared" in service.log.events


async def test_startup_deadline_has_its_own_diagnostic_and_reaps_the_daemon(processes, tmp_path):
    processes.fail_probe = True
    service = _service(tmp_path, start_timeout_seconds=0.3)

    with pytest.raises(RuntimeError, match="startup deadline"):
        await service.start()

    assert all(child.returncode is not None for child in processes.children)
    assert all(_group_gone(child) for child in processes.children)


async def test_daemon_exit_during_startup_is_reported(processes, tmp_path):
    processes.fail_probe = True
    service = _service(tmp_path, start_timeout_seconds=5)
    started = asyncio.create_task(service.start())
    while not processes.children:
        await asyncio.sleep(0.01)
    processes.children[0].kill()

    with pytest.raises(RuntimeError, match="exited during startup"):
        await started


async def test_cancellation_during_probe_reaps_both_process_groups(processes, tmp_path):
    processes.probe_delay = 300
    service = _service(tmp_path, start_timeout_seconds=30)
    started = asyncio.create_task(service.start())
    while len(processes.children) < 2:
        await asyncio.sleep(0.01)

    started.cancel()
    with pytest.raises(asyncio.CancelledError):
        await started

    assert all(child.returncode is not None for child in processes.children)
    assert all(_group_gone(child) for child in processes.children)


async def test_nonzero_daemon_exit_cannot_be_a_prepared_build(processes, tmp_path):
    processes.daemon_exit = 1
    service = _service(tmp_path)
    await service.start()

    with pytest.raises(RuntimeError, match="did not stop cleanly"):
        await service.prepare_for_snapshot()

    await service.stop()
    assert all(child.returncode is not None for child in processes.children)


async def test_unexpected_exit_is_observable_and_not_a_requested_stop(processes, tmp_path):
    service = _service(tmp_path)
    await service.start()
    daemon = processes.children[0]

    daemon.kill()
    assert await service.wait() != 0
    assert service.stopping is False

    await service.stop()
    assert service.stopping is True

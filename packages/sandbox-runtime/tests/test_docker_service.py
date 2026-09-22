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
    ignore_sigterm: bool = False
    children: list[asyncio.subprocess.Process] = field(default_factory=list)
    spawns: list[tuple[str, ...]] = field(default_factory=list)

    def daemon_program(self) -> str:
        handler = (
            "signal.SIG_IGN" if self.ignore_sigterm else f"lambda *_: sys.exit({self.daemon_exit})"
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
    assert service.stopping is True
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


async def test_daemon_that_ignores_sigterm_is_killed_and_never_a_prepared_build(
    processes, tmp_path
):
    processes.ignore_sigterm = True
    service = _service(tmp_path, stop_timeout_seconds=0.3)
    await service.start()
    daemon = processes.children[0]

    with pytest.raises(RuntimeError, match="clean shutdown deadline"):
        await service.prepare_for_snapshot()

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

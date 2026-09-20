"""Exercise service ownership with real subprocesses at the executable boundary."""

import asyncio
import os
import sys
from unittest.mock import Mock

import pytest

from sandbox_runtime.docker_service import DockerService


@pytest.fixture
def processes(monkeypatch):
    real_spawn = asyncio.create_subprocess_exec
    children = []
    options = {"probe_exit": 0, "probe_delay": 0, "daemon_exit": 0}

    async def spawn(command, *args, **kwargs):
        if command == "dockerd":
            program = (
                "import signal,sys,time; "
                f"signal.signal(signal.SIGTERM, lambda *_: sys.exit({options['daemon_exit']})); "
                "time.sleep(300)"
            )
        elif command == "docker":
            program = f"import time,sys; time.sleep({options['probe_delay']}); sys.exit({options['probe_exit']})"
        else:
            raise AssertionError(command)
        process = await real_spawn(sys.executable, "-c", program, **kwargs)
        children.append(process)
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    return children, options


async def test_ready_then_clean_preparation_leaves_no_owned_process(processes):
    children, _ = processes
    service = DockerService(Mock(), stop_timeout_seconds=1)
    await service.start()
    await service.prepare_for_snapshot()
    await service.stop()
    assert all(child.returncode is not None for child in children)
    with pytest.raises(ProcessLookupError):
        os.killpg(children[0].pid, 0)


async def test_startup_timeout_has_its_own_diagnostic_and_cleans_daemon(processes):
    children, options = processes
    options["probe_exit"] = 1
    service = DockerService(Mock(), start_timeout_seconds=0.15, stop_timeout_seconds=1)
    with pytest.raises(RuntimeError, match="startup deadline"):
        await service.start()
    assert children and all(child.returncode is not None for child in children)


async def test_cancellation_during_probe_cleans_both_process_groups(processes):
    children, options = processes
    options["probe_delay"] = 300
    service = DockerService(Mock(), stop_timeout_seconds=1)
    task = asyncio.create_task(service.start())
    async with asyncio.timeout(3):
        while len(children) < 2:
            await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert all(child.returncode is not None for child in children)
    for child in children:
        with pytest.raises(ProcessLookupError):
            os.killpg(child.pid, 0)


async def test_nonzero_daemon_exit_cannot_be_a_prepared_build(processes):
    children, options = processes
    options["daemon_exit"] = 1
    service = DockerService(Mock(), stop_timeout_seconds=1)
    await service.start()
    with pytest.raises(RuntimeError, match="did not stop cleanly"):
        await service.prepare_for_snapshot()
    assert all(child.returncode is not None for child in children)

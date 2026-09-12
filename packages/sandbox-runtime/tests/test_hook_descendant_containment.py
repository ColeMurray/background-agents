"""Linux real-process acceptance for hook descendants that leave the shell PGID."""

import asyncio
import os
import shlex
import sys
from unittest.mock import MagicMock

import pytest

from sandbox_runtime.hook_process import GuardedHookProcess
from sandbox_runtime.repo_config import RepoEntry
from sandbox_runtime.repository_hooks import RepositoryHooks
from sandbox_runtime.runtime_config import BootMode

pytestmark = pytest.mark.skipif(sys.platform != "linux", reason="Linux child-subreaper contract")


def _repository(tmp_path, *, escape, outcome, name="repo"):
    repo = RepoEntry("group/subgroup", name, "main", tmp_path / name)
    directory = repo.path / ".openinspect"
    directory.mkdir(parents=True)
    daemonize = "os.setsid()\n"
    if escape == "double_fork":
        daemonize = "if os.fork(): os._exit(0)\nos.setsid()\nif os.fork(): os._exit(0)\n"
    child = (
        "import os,time\nfrom pathlib import Path\n"
        + daemonize
        + "Path('escaped.pid').write_text(str(os.getpid()))\n"
        "time.sleep(1.3)\nPath('late-write').write_text('provisioning continued')\n"
        "time.sleep(60)\n"
    )
    ending = {"nonzero": "exit 7", "success": "exit 0"}.get(outcome, "sleep 60")
    (directory / "start.sh").write_text(
        f"{shlex.quote(sys.executable)} -c {shlex.quote(child)} &\n"
        "while [ ! -f escaped.pid ]; do sleep .01; done\n" + ending + "\n"
    )
    return repo


async def _wait_for_path(path):
    async with asyncio.timeout(3):
        while not path.exists():
            await asyncio.sleep(0.01)


@pytest.mark.parametrize("escape", ["setsid", "double_fork"])
@pytest.mark.parametrize("outcome", ["nonzero", "timeout", "cancel"])
async def test_failed_hook_contains_daemonized_descendants(tmp_path, monkeypatch, escape, outcome):
    monkeypatch.setenv("START_TIMEOUT_SECONDS", "1")
    repo = _repository(tmp_path, escape=escape, outcome=outcome)
    hooks = RepositoryHooks(MagicMock())
    task = asyncio.create_task(hooks.run_start(repo, BootMode.FRESH))
    try:
        await _wait_for_path(repo.path / "escaped.pid")
        escaped_pid = int((repo.path / "escaped.pid").read_text())
        if outcome == "cancel":
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            async with asyncio.timeout(3):
                assert await task is False
        with pytest.raises(ProcessLookupError):
            os.kill(escaped_pid, 0)
        await asyncio.sleep(1.4)
        assert not (repo.path / "late-write").exists()
        assert not hooks._processes
        events = (
            hooks.log.info.call_args_list if outcome == "cancel" else hooks.log.error.call_args_list
        )
        assert any(event.kwargs.get("cleanup_outcome") == "descendants_stopped" for event in events)
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await hooks.shutdown()


@pytest.mark.parametrize("escape", ["setsid", "double_fork"])
async def test_successful_launcher_preserves_daemon_until_supervisor_shutdown(tmp_path, escape):
    repo = _repository(tmp_path, escape=escape, outcome="success")
    hooks = RepositoryHooks(MagicMock())
    try:
        async with asyncio.timeout(3):
            assert await hooks.run_start(repo, BootMode.FRESH)
        assert all(isinstance(process, GuardedHookProcess) for process in hooks._processes)
        escaped_pid = int((repo.path / "escaped.pid").read_text())
        os.kill(escaped_pid, 0)
        await _wait_for_path(repo.path / "late-write")
        await hooks.shutdown()
        with pytest.raises(ProcessLookupError):
            os.kill(escaped_pid, 0)
    finally:
        await hooks.shutdown()


async def test_failed_hook_does_not_kill_another_hooks_successful_service(tmp_path, monkeypatch):
    monkeypatch.setenv("HOOK_LOG_MODE", "discard")
    service_repo = _repository(tmp_path, escape="double_fork", outcome="success", name="service")
    failed_repo = _repository(tmp_path, escape="double_fork", outcome="nonzero", name="failed")
    service = RepositoryHooks(MagicMock())
    failed = RepositoryHooks(MagicMock())
    try:
        assert await service.run_start(service_repo, BootMode.FRESH)
        assert await failed.run_start(failed_repo, BootMode.FRESH) is False
        service_pid = int((service_repo.path / "escaped.pid").read_text())
        os.kill(service_pid, 0)
        await _wait_for_path(service_repo.path / "late-write")
        assert not (failed_repo.path / "late-write").exists()
    finally:
        await failed.shutdown()
        await service.shutdown()

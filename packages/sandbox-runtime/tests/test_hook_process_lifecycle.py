"""Real OS-process regressions: launcher exit is not inherited-output EOF."""

import asyncio
import os
import shlex
import stat
import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.hook_logs import HookLogs, prepare_hook_logs_for_snapshot
from sandbox_runtime.repo_config import RepoEntry
from sandbox_runtime.repository_hooks import HookCleanupError, RepositoryHooks
from sandbox_runtime.repository_sync import (
    RepositorySyncOutcome,
    RepositorySyncResult,
    RepositorySyncStatus,
)
from sandbox_runtime.runtime_config import BootMode
from tests.runtime_helpers import make_supervisor


def _repo(tmp_path, script, *, hook="start", name="repo"):
    repo = RepoEntry("group/subgroup", name, "main", tmp_path / name)
    directory = repo.path / ".openinspect"
    directory.mkdir(parents=True)
    (directory / f"{hook}.sh").write_text(script)
    return repo


def _child(code):
    return f"{shlex.quote(sys.executable)} -c {shlex.quote(code)}"


async def _wait_for_path(path):
    async with asyncio.timeout(3):
        while not path.exists():
            await asyncio.sleep(0.01)


@pytest.mark.parametrize("hook", ["setup", "start"])
async def test_successful_launcher_does_not_wait_for_background_output_eof(tmp_path, hook):
    child = _child(
        "import os,stat,time; from pathlib import Path; "
        "assert stat.S_ISREG(os.fstat(1).st_mode); "
        "Path('child.pid').write_text(str(os.getpid())); "
        "print('private-hook-secret', flush=True); time.sleep(60)"
    )
    repo = _repo(tmp_path, f"{child} &\nexit 0\n", hook=hook)
    log = MagicMock()
    hooks = RepositoryHooks(log)
    try:
        async with asyncio.timeout(1):
            assert await getattr(hooks, f"run_{hook}")(repo, BootMode.FRESH)
        await _wait_for_path(repo.path / "child.pid")
        os.kill(int((repo.path / "child.pid").read_text()), 0)
        path = hooks.logs.path / repo.name / f"{hook}.log"
        assert path.parent.parent.parent == tmp_path / ".openinspect" / "logs"
        assert "group" not in path.parts
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        for directory in (path.parent, path.parent.parent, path.parent.parent.parent):
            assert stat.S_IMODE(directory.stat().st_mode) == 0o700
        assert "private-hook-secret" not in str(log.mock_calls)
    finally:
        await hooks.shutdown()


@pytest.mark.parametrize("outcome", ["nonzero", "timeout", "cancel"])
async def test_failed_hook_stops_children_before_return_or_cancellation(
    tmp_path, monkeypatch, outcome
):
    child = _child(
        "import os,time; from pathlib import Path; "
        "Path('child.pid').write_text(str(os.getpid())); "
        "time.sleep(1.3); Path('late-write').write_text('must not happen'); time.sleep(60)"
    )
    ending = (
        "while [ ! -f child.pid ]; do sleep .01; done; exit 2" if outcome == "nonzero" else "wait"
    )
    repo = _repo(tmp_path, f"{child} &\n{ending}\n")
    monkeypatch.setenv("START_TIMEOUT_SECONDS", "1")
    hooks = RepositoryHooks(MagicMock())
    task = asyncio.create_task(hooks.run_start(repo, BootMode.FRESH))
    try:
        if outcome == "cancel":
            await _wait_for_path(repo.path / "child.pid")
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            async with asyncio.timeout(3):
                assert await task is False
        await asyncio.sleep(1.4)
        assert not (repo.path / "late-write").exists()
        assert not hooks._processes
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await hooks.shutdown()


async def test_inherited_writer_is_trimmed_on_same_inode_after_launcher_exit(tmp_path, monkeypatch):
    monkeypatch.setattr("sandbox_runtime.hook_logs.HOOK_LOG_RETAIN_BYTES", 4096)
    monkeypatch.setattr("sandbox_runtime.hook_logs.HOOK_LOG_TRIM_INTERVAL_SECONDS", 0.01)
    child = _child(
        "import os,time; from pathlib import Path; "
        "Path('child.pid').write_text(str(os.getpid())); "
        "[(os.write(1,b'x'*1024),time.sleep(.003)) for _ in range(100)]"
    )
    repo = _repo(tmp_path, f"{child} &\nexit 0\n")
    hooks = RepositoryHooks(MagicMock())
    try:
        assert await hooks.run_start(repo, BootMode.FRESH)
        path = hooks.logs.path / repo.name / "start.log"
        inode = path.stat().st_ino
        await _wait_for_path(repo.path / "child.pid")
        await asyncio.sleep(0.6)
        assert path.stat().st_ino == inode
        assert path.stat().st_size <= 4096
        assert any(call.args == ("hook.log_truncated",) for call in hooks.log.info.call_args_list)
    finally:
        await hooks.shutdown()


async def test_snapshot_preparation_removes_paths_without_recreating_live_output(tmp_path):
    child = _child(
        "import os,time; from pathlib import Path; "
        "Path('child.pid').write_text(str(os.getpid())); "
        "[(os.write(1,b'synthetic-secret\\n'),time.sleep(.01)) for _ in range(100)]"
    )
    repo = _repo(tmp_path, f"{child} &\nexit 0\n")
    hooks = RepositoryHooks(MagicMock())
    try:
        assert await hooks.run_start(repo, BootMode.FRESH)
        await _wait_for_path(repo.path / "child.pid")
        await prepare_hook_logs_for_snapshot(tmp_path)
        await asyncio.sleep(0.1)
        assert not (tmp_path / ".openinspect" / "logs").exists()
        assert all(b"synthetic-secret" not in path.read_bytes() for path in tmp_path.rglob("*.log"))
        os.kill(int((repo.path / "child.pid").read_text()), 0)
    finally:
        await hooks.shutdown()


@pytest.mark.parametrize("component", [".openinspect", "logs", "boot", "repo", "file"])
async def test_log_paths_reject_symlinks_without_touching_targets(tmp_path, component):
    outside = tmp_path / "outside"
    outside.mkdir()
    sentinel = outside / "sentinel"
    sentinel.write_text("preserve")
    logs = HookLogs(tmp_path, MagicMock())
    parents = [
        tmp_path / ".openinspect",
        tmp_path / ".openinspect" / "logs",
        logs.path,
        logs.path / "repo",
    ]
    index = [".openinspect", "logs", "boot", "repo", "file"].index(component)
    for path in parents[:index]:
        path.mkdir(mode=0o700)
    target = parents[index] if index < 4 else parents[-1] / "start.log"
    target.symlink_to(sentinel if index == 4 else outside)
    # A new manager removes obsolete boot directories. Test path creation
    # itself for the per-boot/repository/file links, without treating them as old.
    if index >= 2:
        logs._initialized = True
    try:
        with pytest.raises(OSError):
            logs.open("repo", "start")
        assert sentinel.read_text() == "preserve"
    finally:
        target.unlink(missing_ok=True)
        await logs.close()


async def test_hardlinked_logs_fail_closed_before_snapshot(tmp_path):
    logs = HookLogs(tmp_path, MagicMock())
    path, fd = logs.open("repo", "setup")
    os.write(fd, b"secret")
    duplicate = tmp_path / "copied-log"
    os.link(path, duplicate)
    try:
        with pytest.raises(PermissionError, match="unsafe managed hook log file"):
            await prepare_hook_logs_for_snapshot(tmp_path)
        assert duplicate.read_bytes() == b"secret"
    finally:
        duplicate.unlink()
        await logs.close()


async def test_new_boot_prunes_old_raw_diagnostics(tmp_path):
    old_logs = HookLogs(tmp_path, MagicMock())
    old_path, fd = old_logs.open("repo", "setup")
    os.write(fd, b"old-secret")
    logs = HookLogs(tmp_path, MagicMock())
    try:
        new_path, _ = logs.open("repo", "start")
        assert not old_path.exists()
        assert new_path.exists()
        assert list(new_path.parent.parent.parent.iterdir()) == [logs.path]
    finally:
        await old_logs.close()
        await logs.close()


async def test_build_callback_sees_no_raw_hook_logs(tmp_path, monkeypatch):
    monkeypatch.setenv("IMAGE_BUILD_MODE", "true")
    repo = _repo(tmp_path, "printf 'synthetic-build-secret'\n", hook="setup")
    supervisor = make_supervisor(
        {"SANDBOX_ID": "test", "REPO_OWNER": repo.owner, "REPO_NAME": repo.name},
        workspace_path=tmp_path,
    )
    repository = supervisor.repository_boot
    repository._write_repo_manifest = MagicMock()
    repository.synchronizer.ensure_credentials_configured = AsyncMock()
    repository.synchronizer.sync = AsyncMock(
        return_value=RepositorySyncResult(
            (repo,), (RepositorySyncOutcome(repo, RepositorySyncStatus.SUCCEEDED),)
        )
    )
    callback = MagicMock()

    async def capture(**_kwargs):
        assert not (tmp_path / ".openinspect" / "logs").exists()
        supervisor.shutdown_event.set()
        return True

    callback.report_success = AsyncMock(side_effect=capture)
    callback.report_failure = AsyncMock()
    assert await supervisor.run(callback)
    callback.report_success.assert_awaited_once()
    callback.report_failure.assert_not_awaited()


@pytest.mark.parametrize(
    "boot_mode", [BootMode.FRESH, BootMode.REPO_IMAGE, BootMode.SNAPSHOT_RESTORE]
)
async def test_memory_snapshot_provider_explicitly_discards_raw_runtime_output(
    tmp_path, monkeypatch, boot_mode
):
    monkeypatch.setenv("HOOK_LOG_MODE", "discard")
    monkeypatch.setenv("OPENINSPECT_HOOK_LOG_DIR", "/stale/path")
    log = MagicMock()
    hooks = RepositoryHooks(log)
    repo = _repo(tmp_path, "printf 'secret-from-hook'\nexit 0\n")
    try:
        assert await hooks.run_start(repo, boot_mode)
        assert hooks.logs is None
        assert not (tmp_path / ".openinspect").exists()
        assert "OPENINSPECT_HOOK_LOG_DIR" not in os.environ
        assert "secret-from-hook" not in str(log.mock_calls)
        completed = log.info.call_args
        assert completed.kwargs["output_policy"] == "discard"
        assert "log_path" not in completed.kwargs
    finally:
        await hooks.shutdown()


async def test_image_build_keeps_private_file_diagnostics_with_discard_runtime_policy(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("HOOK_LOG_MODE", "discard")
    repo = _repo(tmp_path, "printf 'build-secret'\n", hook="setup")
    hooks = RepositoryHooks(MagicMock())
    try:
        assert await hooks.run_setup(repo, BootMode.BUILD)
        assert (hooks.logs.path / repo.name / "setup.log").read_text() == "build-secret"
    finally:
        await hooks.shutdown()


@pytest.mark.parametrize("failure", ["timeout", "shutdown"])
async def test_unfinished_setup_never_publishes_image_or_keeps_provisioning(
    tmp_path, monkeypatch, failure
):
    monkeypatch.setenv("IMAGE_BUILD_MODE", "true")
    monkeypatch.setenv("SETUP_TIMEOUT_SECONDS", "1")
    repo = _repo(tmp_path, f"{_child('import time; time.sleep(60)')}\n", hook="setup")
    supervisor = make_supervisor(
        {"SANDBOX_ID": "test", "REPO_OWNER": repo.owner, "REPO_NAME": repo.name},
        workspace_path=tmp_path,
    )
    repository = supervisor.repository_boot
    repository._write_repo_manifest = MagicMock()
    repository.synchronizer.ensure_credentials_configured = AsyncMock()
    repository.synchronizer.sync = AsyncMock(
        return_value=RepositorySyncResult(
            (repo,), (RepositorySyncOutcome(repo, RepositorySyncStatus.SUCCEEDED),)
        )
    )
    callback = MagicMock(report_success=AsyncMock(), report_failure=AsyncMock())
    task = asyncio.create_task(supervisor.run(callback))
    if failure == "shutdown":
        async with asyncio.timeout(3):
            while not repository.hooks._processes:
                await asyncio.sleep(0.01)
        supervisor.shutdown_event.set()
    async with asyncio.timeout(3):
        assert await task is (failure == "shutdown")
    callback.report_success.assert_not_awaited()
    assert not repository.hooks._processes
    assert not (tmp_path / ".openinspect" / "logs").exists()


async def test_unconfirmed_group_cleanup_aborts_boot_instead_of_warning(tmp_path, monkeypatch):
    repo = _repo(tmp_path, "exit 1\n")
    hooks = RepositoryHooks(MagicMock())
    try:
        with monkeypatch.context() as context:
            context.setattr("sandbox_runtime.repository_hooks.HOOK_CLEANUP_TIMEOUT_SECONDS", 0.02)
            context.setattr("sandbox_runtime.repository_hooks._group_running", lambda _pid: True)
            with pytest.raises(HookCleanupError, match="could not be confirmed"):
                async with asyncio.timeout(1):
                    await hooks.run_start(repo, BootMode.FRESH)
        assert not any(call.args == ("start.failed",) for call in hooks.log.error.call_args_list)
    finally:
        await hooks.shutdown()


async def test_cancellation_during_process_creation_keeps_cleanup_ownership(tmp_path, monkeypatch):
    repo = _repo(tmp_path, "sleep 60\n")
    hooks = RepositoryHooks(MagicMock())
    real_spawn = asyncio.create_subprocess_exec
    spawned = asyncio.Event()
    release_spawn = asyncio.Event()
    processes = []

    async def delayed_spawn(*args, **kwargs):
        process = await real_spawn(*args, **kwargs)
        processes.append(process)
        spawned.set()
        await release_spawn.wait()
        return process

    monkeypatch.setattr(
        "sandbox_runtime.repository_hooks.asyncio.create_subprocess_exec", delayed_spawn
    )
    task = asyncio.create_task(hooks.run_start(repo, BootMode.FRESH))
    try:
        async with asyncio.timeout(2):
            await spawned.wait()
            task.cancel()
            await asyncio.sleep(0)
            release_spawn.set()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert processes[0].returncode is not None
        assert not hooks._processes
    finally:
        release_spawn.set()
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await hooks.shutdown()

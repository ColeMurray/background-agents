"""Runtime ownership records never turn repository paths into cleanup targets."""

import json
import os
import stat
from unittest.mock import MagicMock

import pytest

from sandbox_runtime import hook_logs
from sandbox_runtime.hook_logs import (
    HookLogs,
    log_path_for_repository,
    prepare_hook_logs_for_snapshot,
)


async def test_workspace_checkout_and_user_logs_are_never_managed(tmp_path):
    workspace = tmp_path / "workspace"
    sentinels = [
        workspace / ".openinspect" / ".git" / "config",
        workspace / ".openinspect" / "logs" / "user.log",
        workspace / "repo" / ".openinspect" / "logs" / "user.log",
    ]
    for sentinel in sentinels:
        sentinel.parent.mkdir(parents=True, exist_ok=True)
        sentinel.write_text("user-owned data")
    logs = HookLogs(workspace, MagicMock())
    try:
        path, fd = logs.open("acme", "repo", "setup")
        os.write(fd, b"private hook output")
        assert not path.is_relative_to(workspace)
        await prepare_hook_logs_for_snapshot(workspace)
        assert not path.exists()
        assert [path.read_text() for path in sentinels] == ["user-owned data"] * 3
    finally:
        await logs.close()


async def test_new_boot_and_snapshot_preserve_unrecorded_siblings(tmp_path):
    root = hook_logs.HOOK_LOG_ROOT
    root.mkdir(mode=0o700)
    sibling = root / ("a" * 32)
    sibling.mkdir(mode=0o700)
    sentinel = sibling / "user.log"
    sentinel.write_text("unrecorded data")
    old_logs = HookLogs(tmp_path, MagicMock())
    logs = HookLogs(tmp_path, MagicMock())
    try:
        old_path, _ = old_logs.open("acme", "repo", "setup")
        new_path, _ = logs.open("acme", "repo", "start")
        assert not old_path.exists()
        assert new_path.exists()
        assert sentinel.read_text() == "unrecorded data"
        await prepare_hook_logs_for_snapshot(tmp_path)
        assert not new_path.exists()
        assert sentinel.read_text() == "unrecorded data"
    finally:
        await old_logs.close()
        await logs.close()


async def test_old_manager_close_cannot_remove_new_boot_or_ownership_record(tmp_path):
    old_logs = HookLogs(tmp_path, MagicMock())
    logs = HookLogs(tmp_path, MagicMock())
    try:
        old_logs.open("acme", "repo", "setup")
        new_path, _ = logs.open("acme", "repo", "start")
        record_path = hook_logs.HOOK_LOG_ROOT / "active.json"
        record = record_path.read_bytes()
        await old_logs.close()
        assert new_path.exists()
        assert record_path.read_bytes() == record
        info = logs.path.stat()
        assert json.loads(record) == {
            "version": 1,
            "boot_id": logs.boot_id,
            "st_dev": info.st_dev,
            "st_ino": info.st_ino,
        }
        assert stat.S_IMODE(record_path.stat().st_mode) == 0o600
    finally:
        await old_logs.close()
        await logs.close()


async def test_identical_repository_names_have_distinct_owner_paths(tmp_path):
    logs = HookLogs(tmp_path, MagicMock())
    owners = ("acme", "group/subgroup", "group/other")
    try:
        paths = []
        for owner in owners:
            path, fd = logs.open(owner, "repo", "setup")
            os.write(fd, owner.encode())
            assert path == log_path_for_repository(logs.path, owner, "repo", "setup")
            paths.append(path)
        assert len(set(paths)) == 3
        assert [path.read_text() for path in paths] == list(owners)
        assert paths[1].relative_to(logs.path).parts == ("group%2Fsubgroup", "repo", "setup.log")
    finally:
        await logs.close()


@pytest.mark.parametrize("field,value", [("boot_id", "../outside"), ("version", 2), ("st_ino", -1)])
async def test_invalid_ownership_record_fails_closed_without_removing_logs(tmp_path, field, value):
    logs = HookLogs(tmp_path, MagicMock())
    path, fd = logs.open("acme", "repo", "setup")
    os.write(fd, b"owned data")
    record_path = hook_logs.HOOK_LOG_ROOT / "active.json"
    original = record_path.read_text()
    record = json.loads(original)
    record[field] = value
    record_path.write_text(json.dumps(record))
    try:
        with pytest.raises(ValueError):
            await prepare_hook_logs_for_snapshot(tmp_path)
        assert path.read_bytes() == b"owned data"
    finally:
        record_path.write_text(original)
        await logs.close()


async def test_replaced_boot_inode_cannot_be_deleted_by_stale_record(tmp_path):
    logs = HookLogs(tmp_path, MagicMock())
    logs.open("acme", "repo", "setup")
    moved = logs.path.with_name("unrecorded-original")
    logs.path.rename(moved)
    logs.path.mkdir(mode=0o700)
    sentinel = logs.path / "user.log"
    sentinel.write_text("replacement data")
    try:
        with pytest.raises(PermissionError, match="ownership record"):
            await prepare_hook_logs_for_snapshot(tmp_path)
        assert sentinel.read_text() == "replacement data"
        assert moved.exists()
    finally:
        sentinel.unlink()
        logs.path.rmdir()
        moved.rename(logs.path)
        await logs.close()


@pytest.mark.parametrize("link_kind", ["symlink", "hardlink"])
async def test_ownership_record_rejects_links_without_touching_targets(tmp_path, link_kind):
    logs = HookLogs(tmp_path, MagicMock())
    path, _ = logs.open("acme", "repo", "setup")
    record_path = hook_logs.HOOK_LOG_ROOT / "active.json"
    external = tmp_path / "external-record"
    if link_kind == "symlink":
        record_path.rename(external)
        record_path.symlink_to(external)
    else:
        os.link(record_path, external)
    original = external.read_bytes()
    try:
        with pytest.raises(OSError):
            await prepare_hook_logs_for_snapshot(tmp_path)
        assert path.exists()
        assert external.read_bytes() == original
    finally:
        if link_kind == "symlink":
            record_path.unlink()
            external.rename(record_path)
        else:
            external.unlink()
        await logs.close()


async def test_snapshot_without_record_does_not_scan_workspace(tmp_path):
    await prepare_hook_logs_for_snapshot(tmp_path / "missing-workspace")
    assert not hook_logs.HOOK_LOG_ROOT.exists()


async def test_repository_and_tmpdir_environment_cannot_relocate_logs(tmp_path, monkeypatch):
    monkeypatch.setenv("TMPDIR", str(tmp_path / "untrusted-tmp"))
    monkeypatch.setenv("OPENINSPECT_HOOK_LOG_DIR", str(tmp_path / "untrusted-log-dir"))
    logs = HookLogs(tmp_path / "untrusted-workspace", MagicMock())
    try:
        path, _ = logs.open("acme", "repo", "setup")
        assert path.is_relative_to(hook_logs.HOOK_LOG_ROOT)
        assert not (tmp_path / "untrusted-tmp").exists()
        assert not (tmp_path / "untrusted-log-dir").exists()
        assert not (tmp_path / "untrusted-workspace").exists()
    finally:
        await logs.close()

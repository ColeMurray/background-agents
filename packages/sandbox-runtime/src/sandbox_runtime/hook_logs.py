"""Private, disposable hook diagnostics, separate from repository/image contents.

Writers inherit an O_APPEND regular file, never a captured pipe. A janitor
truncates the *same inode*, including after unlink, so inherited service output
cannot accumulate indefinitely. This is best-effort tail retention, not a hard
disk quota: a burst can exceed the target between janitor passes.
"""

from __future__ import annotations

import asyncio
import contextlib
import fcntl
import json
import os
import stat
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

from .repo_config import is_safe_repo_owner, is_safe_repo_segment

if TYPE_CHECKING:
    from collections.abc import Iterator

HOOK_LOG_ROOT = Path(f"/tmp/openinspect-hook-logs-{os.getuid()}")
HOOK_LOG_RETAIN_BYTES = 1024 * 1024
HOOK_LOG_TRIM_INTERVAL_SECONDS = 0.25
_DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
_ACTIVE_RECORD = "active.json"


@dataclass(frozen=True)
class _BootRecord:
    boot_id: str
    st_dev: int
    st_ino: int


def log_path_for_repository(boot_path: Path, owner: str, repo_name: str, hook_name: str) -> Path:
    if not is_safe_repo_owner(owner) or not is_safe_repo_segment(repo_name):
        raise ValueError("unsafe repository identity for hook diagnostics")
    if hook_name not in ("setup", "start"):
        raise ValueError("unknown repository hook")
    return boot_path / quote(owner, safe="") / repo_name / f"{hook_name}.log"


def _private_file(fd: int) -> None:
    info = os.fstat(fd)
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_uid != os.getuid()
        or info.st_nlink != 1
    ):
        raise PermissionError("managed hook metadata must be a private owned regular file")


def _directory(parent_fd: int, name: str, *, create: bool) -> int:
    if create:
        with contextlib.suppress(FileExistsError):
            os.mkdir(name, mode=0o700, dir_fd=parent_fd)
    fd = os.open(name, _DIRECTORY_FLAGS, dir_fd=parent_fd)
    try:
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise PermissionError("managed hook log directories must be private and owned")
        return fd
    except BaseException:
        os.close(fd)
        raise


@contextlib.contextmanager
def _locked_root(root: Path, *, create: bool) -> Iterator[int | None]:
    if create:
        with contextlib.suppress(FileExistsError):
            root.mkdir(mode=0o700)
    try:
        # The fixed /tmp parent is a system symlink on macOS; only the
        # runtime-owned final root component must reject symlink traversal.
        parent_fd = os.open(root.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            root_fd = _directory(parent_fd, root.name, create=False)
        finally:
            os.close(parent_fd)
    except FileNotFoundError:
        if create:
            raise
        yield None
        return
    try:
        lock_fd = os.open(
            ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=root_fd
        )
        try:
            _private_file(lock_fd)
            # Snapshot preparation runs on the bridge command loop. A busy
            # ownership record must fail this attempt, never block that loop.
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield root_fd
        finally:
            os.close(lock_fd)
    finally:
        os.close(root_fd)


def _read_record(root_fd: int) -> _BootRecord | None:
    try:
        fd = os.open(_ACTIVE_RECORD, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root_fd)
    except FileNotFoundError:
        return None
    try:
        _private_file(fd)
        raw = os.read(fd, 4097)
        if len(raw) > 4096:
            raise ValueError("oversized hook log ownership record")
        data = json.loads(raw)
        if (
            not isinstance(data, dict)
            or set(data) != {"version", "boot_id", "st_dev", "st_ino"}
            or data["version"] != 1
            or not isinstance(data["boot_id"], str)
            or uuid.UUID(data["boot_id"]).hex != data["boot_id"]
            or type(data["st_dev"]) is not int
            or data["st_dev"] < 0
            or type(data["st_ino"]) is not int
            or data["st_ino"] <= 0
        ):
            raise ValueError("invalid hook log ownership record")
        return _BootRecord(data["boot_id"], data["st_dev"], data["st_ino"])
    finally:
        os.close(fd)


def _write_record(root_fd: int, record: _BootRecord) -> None:
    temporary = f".active-{uuid.uuid4().hex}.tmp"
    fd = os.open(
        temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600, dir_fd=root_fd
    )
    try:
        with os.fdopen(fd, "w") as record_file:
            json.dump({"version": 1, **asdict(record)}, record_file)
            record_file.flush()
            os.fsync(record_file.fileno())
        os.replace(temporary, _ACTIVE_RECORD, src_dir_fd=root_fd, dst_dir_fd=root_fd)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary, dir_fd=root_fd)


def _owned_boot(root_fd: int, record: _BootRecord) -> int:
    fd = _directory(root_fd, record.boot_id, create=False)
    info = os.fstat(fd)
    if (info.st_dev, info.st_ino) != (record.st_dev, record.st_ino):
        os.close(fd)
        raise PermissionError("hook log boot directory no longer matches its ownership record")
    return fd


def _clear_directory(directory_fd: int) -> None:
    """Remove entries via directory descriptors, without following symlinks."""
    for name in os.listdir(directory_fd):
        info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            child_fd = _directory(directory_fd, name, create=False)
            try:
                _clear_directory(child_fd)
            finally:
                os.close(child_fd)
            os.rmdir(name, dir_fd=directory_fd)
        else:
            if stat.S_ISREG(info.st_mode):
                fd = os.open(name, os.O_WRONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
                try:
                    opened = os.fstat(fd)
                    if opened.st_nlink != 1 or opened.st_uid != os.getuid():
                        raise PermissionError("unsafe managed hook log file")
                    # Discard bytes before unlinking; the inherited descriptor is
                    # kept bounded by its supervisor until the sandbox stops.
                    os.ftruncate(fd, 0)
                finally:
                    os.close(fd)
            os.unlink(name, dir_fd=directory_fd)


def _remove_recorded_boot(root_fd: int, record: _BootRecord) -> None:
    try:
        boot_fd = _owned_boot(root_fd, record)
    except FileNotFoundError:
        pass
    else:
        try:
            _clear_directory(boot_fd)
        finally:
            os.close(boot_fd)
        os.rmdir(record.boot_id, dir_fd=root_fd)
    os.unlink(_ACTIVE_RECORD, dir_fd=root_fd)


async def prepare_hook_logs_for_snapshot(workspace_path: Path = Path("/workspace")) -> None:
    """Fail closed before filesystem capture: no raw hook logs remain reachable.

    Must run before EVERY capture, including provider recovery paths that cannot
    contact the bridge. Providers that capture live descriptors/memory require a
    separate verified exclusion contract; unlinking proves filesystem-path removal.
    """
    # Repository paths and TMPDIR are not authorities for runtime-owned files.
    with _locked_root(HOOK_LOG_ROOT, create=False) as root_fd:
        if root_fd is not None and (record := _read_record(root_fd)) is not None:
            _remove_recorded_boot(root_fd, record)


class HookLogs:
    """Own one boot's files and keep successful background writers bounded."""

    def __init__(self, workspace_path: Path, log: Any) -> None:
        self.log = log
        self.boot_id = uuid.uuid4().hex
        self.path = HOOK_LOG_ROOT / self.boot_id
        self._files: dict[Path, int] = {}
        self._janitor: asyncio.Task[None] | None = None
        self._record: _BootRecord | None = None

    def open(self, owner: str, repo_name: str, hook_name: str) -> tuple[Path, int]:
        path = log_path_for_repository(self.path, owner, repo_name, hook_name)
        with _locked_root(self.path.parent, create=True) as root_fd:
            assert root_fd is not None
            active = _read_record(root_fd)
            if self._record is None:
                if active is not None:
                    _remove_recorded_boot(root_fd, active)
                os.mkdir(self.boot_id, mode=0o700, dir_fd=root_fd)
                boot_fd = _directory(root_fd, self.boot_id, create=False)
                info = os.fstat(boot_fd)
                self._record = _BootRecord(self.boot_id, info.st_dev, info.st_ino)
                try:
                    _write_record(root_fd, self._record)
                finally:
                    os.close(boot_fd)
            elif active != self._record:
                raise RuntimeError("hook diagnostics for this boot have already been retired")
            descriptors = [_owned_boot(root_fd, self._record)]
            try:
                for name in (quote(owner, safe=""), repo_name):
                    descriptors.append(_directory(descriptors[-1], name, create=True))
                fd = os.open(
                    path.name,
                    os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_APPEND | os.O_NOFOLLOW,
                    0o600,
                    dir_fd=descriptors[-1],
                )
            finally:
                for descriptor in reversed(descriptors):
                    os.close(descriptor)
        self._files[path] = fd
        if self._janitor is None:
            self._janitor = asyncio.create_task(self._maintain())
        return path, fd

    def trim(self) -> None:
        for path, fd in self._files.items():
            size = os.fstat(fd).st_size
            if size > HOOK_LOG_RETAIN_BYTES:
                # A rename would strand a service on an ever-growing old inode.
                # Drop the buffer in place instead; O_APPEND avoids sparse holes
                # from the writer's pre-truncation file offset.
                os.ftruncate(fd, 0)
                self.log.info("hook.log_truncated", log_path=str(path), discarded_bytes=size)

    async def _maintain(self) -> None:
        while True:
            await asyncio.sleep(HOOK_LOG_TRIM_INTERVAL_SECONDS)
            self.trim()

    async def discard(self) -> None:
        if self._record is None:
            return
        with _locked_root(self.path.parent, create=False) as root_fd:
            if root_fd is not None and _read_record(root_fd) == self._record:
                _remove_recorded_boot(root_fd, self._record)

    async def close(self) -> None:
        try:
            if self._record is not None:
                await self.discard()
        finally:
            if self._janitor:
                self._janitor.cancel()
                await asyncio.gather(self._janitor, return_exceptions=True)
                self._janitor = None
            for fd in self._files.values():
                os.close(fd)
            self._files.clear()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Remove raw hook logs before filesystem capture")
    parser.add_argument("--prepare-snapshot", action="store_true", required=True)
    parser.add_argument("--workspace", type=Path, default=Path("/workspace"))
    arguments = parser.parse_args()
    asyncio.run(prepare_hook_logs_for_snapshot(arguments.workspace))

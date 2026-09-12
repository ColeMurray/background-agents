"""Private, disposable hook diagnostics, separate from repository/image contents.

Writers inherit an O_APPEND regular file, never a captured pipe. A janitor
truncates the *same inode*, including after unlink, so inherited service output
cannot accumulate indefinitely. This is best-effort tail retention, not a hard
disk quota: a burst can exceed the target between janitor passes.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import stat
import uuid
from pathlib import Path
from typing import Any

from .repo_config import is_safe_repo_segment

HOOK_LOG_RETAIN_BYTES = 1024 * 1024
HOOK_LOG_TRIM_INTERVAL_SECONDS = 0.25
_DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


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


def _remove_hook_logs(workspace_path: Path) -> None:
    workspace_fd = os.open(workspace_path, _DIRECTORY_FLAGS)
    try:
        try:
            metadata_fd = _directory(workspace_fd, ".openinspect", create=False)
        except FileNotFoundError:
            return
        try:
            try:
                logs_fd = _directory(metadata_fd, "logs", create=False)
            except FileNotFoundError:
                return
            try:
                _clear_directory(logs_fd)
            finally:
                os.close(logs_fd)
            os.rmdir("logs", dir_fd=metadata_fd)
        finally:
            os.close(metadata_fd)
    finally:
        os.close(workspace_fd)


async def prepare_hook_logs_for_snapshot(workspace_path: Path = Path("/workspace")) -> None:
    """Fail closed before filesystem capture: no raw hook logs remain reachable.

    Must run before EVERY capture, including provider recovery paths that cannot
    contact the bridge. Providers that capture live descriptors/memory require a
    separate verified exclusion contract; unlinking proves filesystem-path removal.
    """
    _remove_hook_logs(workspace_path)


class HookLogs:
    """Own one boot's files and keep successful background writers bounded."""

    def __init__(self, workspace_path: Path, log: Any) -> None:
        self.workspace_path = workspace_path
        self.log = log
        self.boot_id = uuid.uuid4().hex
        self.path = workspace_path / ".openinspect" / "logs" / self.boot_id
        self._files: dict[Path, int] = {}
        self._janitor: asyncio.Task[None] | None = None
        self._initialized = False

    def open(self, repo_name: str, hook_name: str) -> tuple[Path, int]:
        if not is_safe_repo_segment(repo_name):
            raise ValueError("unsafe repository name for hook diagnostics")
        if hook_name not in ("setup", "start"):
            raise ValueError("unknown repository hook")
        if not self._initialized:
            _remove_hook_logs(self.workspace_path)
        workspace_fd = os.open(self.workspace_path, _DIRECTORY_FLAGS)
        descriptors = [workspace_fd]
        try:
            parent_fd = workspace_fd
            for name in (".openinspect", "logs", self.boot_id, repo_name):
                parent_fd = _directory(parent_fd, name, create=True)
                descriptors.append(parent_fd)
            fd = os.open(
                f"{hook_name}.log",
                os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_APPEND | os.O_NOFOLLOW,
                0o600,
                dir_fd=parent_fd,
            )
        finally:
            for descriptor in reversed(descriptors):
                os.close(descriptor)
        self._initialized = True
        path = self.path / repo_name / f"{hook_name}.log"
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
        await prepare_hook_logs_for_snapshot(self.workspace_path)

    async def close(self) -> None:
        try:
            if self._initialized:
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

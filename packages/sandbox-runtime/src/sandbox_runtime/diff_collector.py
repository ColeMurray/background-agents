"""Git-backed session diff capture.

The public collector compares a checkout with an immutable commit and returns
metadata plus one bounded patch per renderable file. Git is always invoked with
argument arrays; repository paths and filenames are never interpolated into a
shell command.
"""

from __future__ import annotations

import asyncio
import os
import re
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .repo_config import RepoEntry

DEFAULT_MAX_FILES = 1_000
DEFAULT_MAX_PATCH_BYTES = 1_000_000
DEFAULT_MAX_CAPTURE_BYTES = 20_000_000
DEFAULT_MAX_METADATA_BYTES = 8_000_000
DEFAULT_COMMAND_TIMEOUT_SECONDS = 20.0


class DiffCaptureError(RuntimeError):
    """A repository could not produce a trustworthy capture."""


class _GitOutputTooLarge(RuntimeError):
    """A Git command exceeded its caller-provided stdout ceiling."""


@dataclass(frozen=True)
class CaptureLimits:
    max_files: int
    max_patch_bytes: int
    max_capture_bytes: int
    command_timeout_seconds: float
    max_metadata_bytes: int = DEFAULT_MAX_METADATA_BYTES

    @classmethod
    def defaults(cls) -> CaptureLimits:
        return cls(
            max_files=DEFAULT_MAX_FILES,
            max_patch_bytes=DEFAULT_MAX_PATCH_BYTES,
            max_capture_bytes=DEFAULT_MAX_CAPTURE_BYTES,
            command_timeout_seconds=DEFAULT_COMMAND_TIMEOUT_SECONDS,
            max_metadata_bytes=DEFAULT_MAX_METADATA_BYTES,
        )


@dataclass(frozen=True)
class CapturedFile:
    id: str
    path: str
    old_path: str | None
    status: str
    additions: int | None
    deletions: int | None
    render_state: str
    patch: str | None
    patch_bytes: int | None
    old_mode: str | None = None
    new_mode: str | None = None
    old_submodule_sha: str | None = None
    new_submodule_sha: str | None = None


@dataclass(frozen=True)
class RepositoryCapture:
    repository: RepoEntry
    base_sha: str
    head_sha: str
    files: tuple[CapturedFile, ...]
    truncated: bool
    omitted_file_count: int


@dataclass(frozen=True)
class _ChangedPath:
    status: str
    path: str
    old_path: str | None = None


async def _git(
    repository: RepoEntry,
    *arguments: str,
    timeout_seconds: float,
    accepted_return_codes: tuple[int, ...] = (0,),
    max_stdout_bytes: int | None = None,
) -> bytes:
    environment = os.environ.copy()
    environment.update(
        {
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_NO_REPLACE_OBJECTS": "1",
            "GIT_TERMINAL_PROMPT": "0",
            "LC_ALL": "C",
        }
    )
    process = await asyncio.create_subprocess_exec(
        "git",
        *arguments,
        cwd=repository.path,
        env=environment,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    async def read_stream(stream: asyncio.StreamReader | None, limit: int | None) -> bytes:
        if stream is None:
            return b""
        chunks: list[bytes] = []
        size = 0
        while chunk := await stream.read(64 * 1024):
            size += len(chunk)
            if limit is not None and size > limit:
                raise _GitOutputTooLarge
            chunks.append(chunk)
        return b"".join(chunks)

    stdout_task = asyncio.create_task(read_stream(process.stdout, max_stdout_bytes))
    stderr_task = asyncio.create_task(read_stream(process.stderr, 64 * 1024))
    try:
        stdout, stderr = await asyncio.wait_for(
            asyncio.gather(stdout_task, stderr_task), timeout=timeout_seconds
        )
        await process.wait()
    except (TimeoutError, _GitOutputTooLarge, asyncio.CancelledError) as error:
        if process.returncode is None:
            process.kill()
        await process.wait()
        for task in (stdout_task, stderr_task):
            if not task.done():
                task.cancel()
        await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)
        if isinstance(error, _GitOutputTooLarge):
            raise
        if isinstance(error, asyncio.CancelledError):
            raise
        raise DiffCaptureError(f"Git command timed out for {repository.owner}/{repository.name}")
    if process.returncode not in accepted_return_codes:
        detail = stderr.decode("utf-8", errors="replace").strip()
        raise DiffCaptureError(
            f"Git command failed for {repository.owner}/{repository.name}: {detail or process.returncode}"
        )
    return stdout


def _decode_path(raw: bytes) -> str:
    return raw.decode("utf-8", errors="surrogateescape")


def _parse_name_status(raw: bytes) -> list[_ChangedPath]:
    fields = raw.split(b"\0")
    if fields and fields[-1] == b"":
        fields.pop()
    changes: list[_ChangedPath] = []
    index = 0
    while index < len(fields):
        code = _decode_path(fields[index])
        index += 1
        if not code:
            continue
        letter = code[0]
        if letter in ("R", "C"):
            if index + 1 >= len(fields):
                raise DiffCaptureError("Malformed Git rename record")
            old_path = _decode_path(fields[index])
            path = _decode_path(fields[index + 1])
            index += 2
            changes.append(_ChangedPath(status="renamed", path=path, old_path=old_path))
            continue
        if index >= len(fields):
            raise DiffCaptureError("Malformed Git name-status record")
        path = _decode_path(fields[index])
        index += 1
        status = {
            "A": "added",
            "M": "modified",
            "D": "deleted",
            "T": "type_changed",
            "U": "unmerged",
        }.get(letter, "modified")
        changes.append(_ChangedPath(status=status, path=path))
    return changes


def _parse_stat_columns(additions: bytes, deletions: bytes) -> tuple[int | None, int | None]:
    if additions == b"-" or deletions == b"-":
        return None, None
    try:
        return int(additions), int(deletions)
    except ValueError as error:
        raise DiffCaptureError("Malformed Git numstat record") from error


def _parse_numstat(raw: bytes) -> dict[tuple[str | None, str], tuple[int | None, int | None]]:
    fields = raw.split(b"\0")
    if fields and fields[-1] == b"":
        fields.pop()
    stats: dict[tuple[str | None, str], tuple[int | None, int | None]] = {}
    index = 0
    while index < len(fields):
        columns = fields[index].split(b"\t", 2)
        index += 1
        if len(columns) != 3:
            raise DiffCaptureError("Malformed Git numstat record")
        line_stats = _parse_stat_columns(columns[0], columns[1])
        if columns[2]:
            stats[(None, _decode_path(columns[2]))] = line_stats
            continue
        if index + 1 >= len(fields):
            raise DiffCaptureError("Malformed Git rename numstat record")
        old_path = _decode_path(fields[index])
        path = _decode_path(fields[index + 1])
        index += 2
        stats[(old_path, path)] = line_stats
    return stats


async def _tracked_line_stats(
    repository: RepoEntry,
    base_sha: str,
    timeout_seconds: float,
    max_metadata_bytes: int,
) -> dict[tuple[str | None, str], tuple[int | None, int | None]]:
    raw = await _git(
        repository,
        "--no-pager",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--numstat",
        "-z",
        "--find-renames",
        base_sha,
        timeout_seconds=timeout_seconds,
        max_stdout_bytes=max_metadata_bytes,
    )
    return _parse_numstat(raw)


async def _tracked_patch(
    repository: RepoEntry,
    base_sha: str,
    path: str,
    timeout_seconds: float,
    max_patch_bytes: int,
    old_path: str | None = None,
) -> bytes:
    return await _git(
        repository,
        "--no-pager",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--full-index",
        "--find-renames",
        "--unified=1000000",
        base_sha,
        "--",
        *(filter(None, (old_path, path))),
        timeout_seconds=timeout_seconds,
        max_stdout_bytes=max_patch_bytes,
    )


async def _untracked_patch(
    repository: RepoEntry, path: str, timeout_seconds: float, max_patch_bytes: int
) -> bytes:
    return await _git(
        repository,
        "--no-pager",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-index",
        "--full-index",
        "--unified=1000000",
        "--",
        "/dev/null",
        path,
        timeout_seconds=timeout_seconds,
        accepted_return_codes=(0, 1),
        max_stdout_bytes=max_patch_bytes,
    )


async def _untracked_stats(
    repository: RepoEntry, path: str, timeout_seconds: float
) -> tuple[int | None, int | None]:
    raw = await _git(
        repository,
        "--no-pager",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-index",
        "--numstat",
        "--",
        "/dev/null",
        path,
        timeout_seconds=timeout_seconds,
        accepted_return_codes=(0, 1),
        max_stdout_bytes=64 * 1024,
    )
    columns = raw.splitlines()[0].split(b"\t", 2) if raw.splitlines() else []
    if len(columns) < 2:
        return 0, 0
    if columns[0] == b"-" or columns[1] == b"-":
        return None, None
    try:
        return int(columns[0]), int(columns[1])
    except ValueError as error:
        raise DiffCaptureError("Malformed Git numstat record") from error


async def collect_repository_diff(
    repository: RepoEntry, base_sha: str, limits: CaptureLimits
) -> RepositoryCapture:
    """Collect one repository's net checkout state relative to ``base_sha``."""
    if not repository.path.is_dir():
        raise DiffCaptureError(f"Repository checkout is missing: {repository.path}")
    await _git(
        repository,
        "cat-file",
        "-e",
        f"{base_sha}^{{commit}}",
        timeout_seconds=limits.command_timeout_seconds,
    )
    head_sha = (
        (
            await _git(
                repository,
                "rev-parse",
                "HEAD",
                timeout_seconds=limits.command_timeout_seconds,
            )
        )
        .decode()
        .strip()
    )
    try:
        tracked = _parse_name_status(
            await _git(
                repository,
                "--no-pager",
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--name-status",
                "-z",
                "--find-renames",
                base_sha,
                timeout_seconds=limits.command_timeout_seconds,
                max_stdout_bytes=limits.max_metadata_bytes,
            )
        )
        untracked_raw = await _git(
            repository,
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            timeout_seconds=limits.command_timeout_seconds,
            max_stdout_bytes=limits.max_metadata_bytes,
        )
        tracked_stats = await _tracked_line_stats(
            repository,
            base_sha,
            limits.command_timeout_seconds,
            limits.max_metadata_bytes,
        )
    except _GitOutputTooLarge as error:
        raise DiffCaptureError("Repository change metadata exceeded its memory limit") from error
    untracked = [
        _ChangedPath(status="added", path=_decode_path(path))
        for path in untracked_raw.split(b"\0")
        if path
    ]
    untracked_paths = {change.path for change in untracked}
    overlay_paths = {
        change.path
        for change in tracked
        if change.status == "deleted" and change.path in untracked_paths
    }
    normalized_tracked = [
        _ChangedPath(status="modified", path=change.path, old_path=change.old_path)
        if change.path in overlay_paths
        else change
        for change in tracked
    ]
    all_changes = normalized_tracked + [
        change for change in untracked if change.path not in overlay_paths
    ]
    selected_changes = all_changes[: limits.max_files]
    captured: list[CapturedFile] = []
    captured_bytes = 0

    for change in selected_changes:
        is_overlay = change.path in overlay_paths
        is_untracked = not is_overlay and change in untracked
        file_status = change.status
        if is_overlay:
            tracked_additions, tracked_deletions = tracked_stats.get(
                (change.old_path, change.path), (0, 0)
            )
            untracked_additions, untracked_deletions = await _untracked_stats(
                repository, change.path, limits.command_timeout_seconds
            )
            additions = (
                None
                if tracked_additions is None or untracked_additions is None
                else tracked_additions + untracked_additions
            )
            deletions = (
                None
                if tracked_deletions is None or untracked_deletions is None
                else tracked_deletions + untracked_deletions
            )
        elif is_untracked:
            additions, deletions = await _untracked_stats(
                repository, change.path, limits.command_timeout_seconds
            )
        else:
            additions, deletions = tracked_stats.get((change.old_path, change.path), (0, 0))

        patch: str | None = None
        patch_bytes: int | None = None
        old_mode: str | None = None
        new_mode: str | None = None
        old_submodule_sha: str | None = None
        new_submodule_sha: str | None = None
        if additions is None or deletions is None:
            render_state = "binary"
        elif is_overlay:
            # Git can report a staged deletion and an untracked working-tree
            # file at the same path (for example after ``git rm --cached``).
            # Preserve the meaningful index/worktree change as one path record
            # without publishing two contradictory patches for one file.
            render_state = "metadata_only"
        else:
            try:
                raw_patch = (
                    await _untracked_patch(
                        repository,
                        change.path,
                        limits.command_timeout_seconds,
                        limits.max_patch_bytes,
                    )
                    if is_untracked
                    else await _tracked_patch(
                        repository,
                        base_sha,
                        change.path,
                        limits.command_timeout_seconds,
                        limits.max_patch_bytes,
                        change.old_path,
                    )
                )
            except _GitOutputTooLarge:
                render_state = "too_large"
                captured.append(
                    CapturedFile(
                        id=str(uuid.uuid4()),
                        path=change.path,
                        old_path=change.old_path,
                        status=file_status,
                        additions=additions,
                        deletions=deletions,
                        render_state=render_state,
                        patch=None,
                        patch_bytes=None,
                    )
                )
                continue
            patch_text = raw_patch.decode("utf-8", errors="replace")
            old_mode_match = re.search(r"^old mode (\d+)$", patch_text, re.MULTILINE)
            new_mode_match = re.search(r"^new mode (\d+)$", patch_text, re.MULTILINE)
            old_mode = old_mode_match.group(1) if old_mode_match else None
            new_mode = new_mode_match.group(1) if new_mode_match else None
            old_submodule_match = re.search(
                r"^-Subproject commit ([0-9a-f]{40,64})", patch_text, re.MULTILINE
            )
            new_submodule_match = re.search(
                r"^\+Subproject commit ([0-9a-f]{40,64})", patch_text, re.MULTILINE
            )
            old_submodule_sha = old_submodule_match.group(1) if old_submodule_match else None
            new_submodule_sha = new_submodule_match.group(1) if new_submodule_match else None
            # The upload client sends the normalized UTF-8 text, so limits and
            # manifest metadata must describe those exact bytes rather than
            # Git's potentially non-UTF-8 stdout.
            patch_bytes = len(patch_text.encode("utf-8"))
            if old_submodule_sha or new_submodule_sha:
                file_status = "submodule"
                render_state = "metadata_only"
                patch_bytes = None
            elif (
                not is_untracked and additions == 0 and deletions == 0 and "\n@@" not in patch_text
            ):
                render_state = "metadata_only"
                patch_bytes = None
            elif patch_bytes > limits.max_patch_bytes:
                render_state = "too_large"
                patch_bytes = None
            elif captured_bytes + patch_bytes > limits.max_capture_bytes:
                render_state = "metadata_only"
                patch_bytes = None
            elif raw_patch:
                render_state = "renderable"
                captured_bytes += patch_bytes
                patch = patch_text
            else:
                render_state = "metadata_only"
                patch_bytes = None

        captured.append(
            CapturedFile(
                id=str(uuid.uuid4()),
                path=change.path,
                old_path=change.old_path,
                status=file_status,
                additions=additions,
                deletions=deletions,
                render_state=render_state,
                patch=patch,
                patch_bytes=patch_bytes,
                old_mode=old_mode,
                new_mode=new_mode,
                old_submodule_sha=old_submodule_sha,
                new_submodule_sha=new_submodule_sha,
            )
        )

    return RepositoryCapture(
        repository=repository,
        base_sha=base_sha,
        head_sha=head_sha,
        files=tuple(captured),
        truncated=len(all_changes) > len(selected_changes),
        omitted_file_count=len(all_changes) - len(selected_changes),
    )

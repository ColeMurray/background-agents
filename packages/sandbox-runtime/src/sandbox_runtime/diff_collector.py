"""Git-backed session diff capture.

The public collector compares a checkout with an immutable commit and returns
metadata plus one bounded patch per renderable file. Git is always invoked with
argument arrays; repository paths and filenames are never interpolated into a
shell command.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, NotRequired, TypedDict

from .git_excludes import is_runtime_git_excluded, read_runtime_git_excludes

if TYPE_CHECKING:
    from .repo_config import RepoEntry

DEFAULT_MAX_FILES = 1_000
DEFAULT_MAX_PATCH_BYTES = 512 * 1_024
DEFAULT_MAX_CAPTURE_BYTES = 1_024 * 1_024
DEFAULT_MAX_BUNDLE_BYTES = 1_572_864
DEFAULT_MAX_METADATA_BYTES = 8_000_000
DEFAULT_COMMAND_TIMEOUT_SECONDS = 20.0


class DiffCaptureError(RuntimeError):
    """A repository could not produce a trustworthy capture."""


class DiffFileUpload(TypedDict):
    """Wire representation of one changed file within a repository upload."""

    id: str
    path: str
    status: str
    additions: int | None
    deletions: int | None
    renderState: str
    oldPath: NotRequired[str]
    patch: NotRequired[str]
    oldMode: NotRequired[str]
    newMode: NotRequired[str]
    oldSubmoduleSha: NotRequired[str]
    newSubmoduleSha: NotRequired[str]


class ReadyRepositoryUpload(TypedDict):
    """A repository whose checkout changes were captured successfully."""

    status: Literal["ready"]
    position: int
    repoOwner: str
    repoName: str
    baseSha: str
    headSha: str
    truncated: bool
    omittedFileCount: int
    files: list[DiffFileUpload]


class UnavailableRepositoryUpload(TypedDict):
    """A repository whose capture failed; the bundle still uploads atomically."""

    status: Literal["unavailable"]
    position: int
    repoOwner: str
    repoName: str
    baseSha: str
    error: str
    files: list[DiffFileUpload]


RepositoryUpload = ReadyRepositoryUpload | UnavailableRepositoryUpload


class SessionDiffBundle(TypedDict):
    """Wire representation uploaded atomically for all session repositories."""

    version: int
    triggerMessageId: str | None
    capturedAt: int
    repositories: list[RepositoryUpload]


class _GitOutputTooLarge(RuntimeError):
    """A Git command exceeded its caller-provided stdout ceiling."""


@dataclass(frozen=True)
class CaptureLimits:
    """Resource ceilings applied while collecting one session diff bundle."""

    max_files: int
    max_patch_bytes: int
    max_capture_bytes: int
    command_timeout_seconds: float
    max_bundle_bytes: int = DEFAULT_MAX_BUNDLE_BYTES
    max_metadata_bytes: int = DEFAULT_MAX_METADATA_BYTES

    @classmethod
    def defaults(cls) -> CaptureLimits:
        """Return the production capture limits shared with the API contract."""
        return cls(
            max_files=DEFAULT_MAX_FILES,
            max_patch_bytes=DEFAULT_MAX_PATCH_BYTES,
            max_capture_bytes=DEFAULT_MAX_CAPTURE_BYTES,
            command_timeout_seconds=DEFAULT_COMMAND_TIMEOUT_SECONDS,
            max_bundle_bytes=DEFAULT_MAX_BUNDLE_BYTES,
            max_metadata_bytes=DEFAULT_MAX_METADATA_BYTES,
        )


@dataclass(frozen=True)
class CapturedFile:
    """One changed path and its optional bounded, renderable patch."""

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
    """A repository's net checkout changes relative to its immutable baseline."""

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


@dataclass(frozen=True)
class _TrackedMetadata:
    old_mode: str
    new_mode: str
    old_sha: str
    new_sha: str


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
            "GIT_LITERAL_PATHSPECS": "1",
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


def _parse_raw_changes(
    raw: bytes,
) -> tuple[list[_ChangedPath], dict[tuple[str | None, str], _TrackedMetadata]]:
    fields = raw.split(b"\0")
    if fields and fields[-1] == b"":
        fields.pop()
    changes: list[_ChangedPath] = []
    metadata: dict[tuple[str | None, str], _TrackedMetadata] = {}
    index = 0
    while index < len(fields):
        header = fields[index].split()
        index += 1
        if len(header) != 5 or not header[0].startswith(b":"):
            raise DiffCaptureError("Malformed Git raw diff record")
        code = _decode_path(header[4])
        letter = code[0] if code else ""
        if letter in ("R", "C"):
            if index + 1 >= len(fields):
                raise DiffCaptureError("Malformed Git raw rename record")
            old_path = _decode_path(fields[index])
            path = _decode_path(fields[index + 1])
            index += 2
        else:
            if index >= len(fields):
                raise DiffCaptureError("Malformed Git raw diff record")
            old_path = None
            path = _decode_path(fields[index])
            index += 1
        status = {
            "A": "added",
            "M": "modified",
            "D": "deleted",
            "T": "type_changed",
            "U": "unmerged",
            "R": "renamed",
            "C": "renamed",
        }.get(letter, "modified")
        change = _ChangedPath(status=status, path=path, old_path=old_path)
        changes.append(change)
        metadata[(old_path, path)] = _TrackedMetadata(
            old_mode=_decode_path(header[0][1:]),
            new_mode=_decode_path(header[1]),
            old_sha=_decode_path(header[2]),
            new_sha=_decode_path(header[3]),
        )
    return changes, metadata


async def _tracked_changes_and_metadata(
    repository: RepoEntry,
    base_sha: str,
    timeout_seconds: float,
    max_metadata_bytes: int,
) -> tuple[list[_ChangedPath], dict[tuple[str | None, str], _TrackedMetadata]]:
    raw = await _git(
        repository,
        "--no-pager",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--raw",
        "-z",
        "--no-abbrev",
        "--find-renames",
        base_sha,
        timeout_seconds=timeout_seconds,
        max_stdout_bytes=max_metadata_bytes,
    )
    return _parse_raw_changes(raw)


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


async def _unmerged_paths(
    repository: RepoEntry,
    timeout_seconds: float,
    max_metadata_bytes: int,
) -> set[str]:
    raw = await _git(
        repository,
        "--no-pager",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--name-only",
        "--diff-filter=U",
        "-z",
        timeout_seconds=timeout_seconds,
        max_stdout_bytes=max_metadata_bytes,
    )
    return {_decode_path(path) for path in raw.split(b"\0") if path}


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


async def _submodule_head(repository: RepoEntry, path: str, timeout_seconds: float) -> str:
    value = (
        (
            await _git(
                repository,
                "-C",
                path,
                "rev-parse",
                "--verify",
                "HEAD",
                timeout_seconds=timeout_seconds,
                max_stdout_bytes=128,
            )
        )
        .decode("ascii", errors="strict")
        .strip()
    )
    if len(value) not in (40, 64) or any(
        character not in "0123456789abcdef" for character in value
    ):
        raise DiffCaptureError(f"Invalid submodule HEAD for {path}")
    return value


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
        tracked, tracked_metadata = await _tracked_changes_and_metadata(
            repository,
            base_sha,
            limits.command_timeout_seconds,
            limits.max_metadata_bytes,
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
        unmerged_paths = await _unmerged_paths(
            repository,
            limits.command_timeout_seconds,
            limits.max_metadata_bytes,
        )
    except _GitOutputTooLarge as error:
        raise DiffCaptureError("Repository change metadata exceeded its memory limit") from error
    runtime_paths = read_runtime_git_excludes(repository.path)
    untracked = [
        _ChangedPath(status="added", path=_decode_path(path))
        for path in untracked_raw.split(b"\0")
        if path and not is_runtime_git_excluded(_decode_path(path), runtime_paths)
    ]
    untracked_paths = {change.path for change in untracked}
    overlay_paths = {
        change.path
        for change in tracked
        if change.status == "deleted" and change.path in untracked_paths
    }
    normalized_tracked = [
        _ChangedPath(
            status=(
                "modified"
                if change.path in overlay_paths
                else "unmerged"
                if change.path in unmerged_paths
                else change.status
            ),
            path=change.path,
            old_path=change.old_path,
        )
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
        metadata = tracked_metadata.get((change.old_path, change.path))
        if metadata and metadata.old_mode != metadata.new_mode:
            old_mode = metadata.old_mode if metadata.old_mode != "000000" else None
            new_mode = metadata.new_mode if metadata.new_mode != "000000" else None
        is_submodule = bool(
            metadata and (metadata.old_mode == "160000" or metadata.new_mode == "160000")
        )
        if is_submodule and metadata:
            file_status = "submodule"
            render_state = "metadata_only"
            old_submodule_sha = (
                metadata.old_sha
                if metadata.old_mode == "160000" and set(metadata.old_sha) != {"0"}
                else None
            )
            new_submodule_sha = (
                metadata.new_sha
                if metadata.new_mode == "160000" and set(metadata.new_sha) != {"0"}
                else None
            )
            if metadata.new_mode == "160000" and new_submodule_sha is None:
                new_submodule_sha = await _submodule_head(
                    repository, change.path, limits.command_timeout_seconds
                )
        elif additions is None or deletions is None:
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
            else:
                patch_text = raw_patch.decode("utf-8", errors="replace")
                # The upload client sends the normalized UTF-8 text, so limits and
                # manifest metadata must describe those exact bytes rather than
                # Git's potentially non-UTF-8 stdout.
                patch_bytes = len(patch_text.encode("utf-8"))
                if (
                    not is_untracked
                    and additions == 0
                    and deletions == 0
                    and "\n@@" not in patch_text
                ):
                    render_state = "metadata_only"
                    patch_bytes = None
                elif (
                    patch_bytes > limits.max_patch_bytes
                    or captured_bytes + patch_bytes > limits.max_capture_bytes
                ):
                    render_state = "too_large"
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


def encode_bundle(bundle: SessionDiffBundle) -> bytes:
    """Encode the exact JSON representation measured against the wire limit."""
    return json.dumps(bundle, ensure_ascii=True, separators=(",", ":")).encode("utf-8")


def _file_upload(changed: CapturedFile) -> DiffFileUpload:
    file: DiffFileUpload = {
        "id": changed.id,
        "path": changed.path,
        "status": changed.status,
        "additions": changed.additions,
        "deletions": changed.deletions,
        "renderState": changed.render_state,
    }
    if changed.old_path is not None:
        file["oldPath"] = changed.old_path
    if changed.render_state == "renderable" and changed.patch is not None:
        file["patch"] = changed.patch
    if changed.old_mode is not None:
        file["oldMode"] = changed.old_mode
    if changed.new_mode is not None:
        file["newMode"] = changed.new_mode
    if changed.old_submodule_sha is not None:
        file["oldSubmoduleSha"] = changed.old_submodule_sha
    if changed.new_submodule_sha is not None:
        file["newSubmoduleSha"] = changed.new_submodule_sha
    return file


def _bound_encoded_bundle(bundle: SessionDiffBundle, max_bundle_bytes: int) -> None:
    """Shed patches, then trailing metadata records, until the bundle fits."""
    ready_repositories = [
        repository for repository in bundle["repositories"] if repository["status"] == "ready"
    ]

    patches: list[tuple[int, DiffFileUpload]] = []
    for repository in ready_repositories:
        for file in repository["files"]:
            patch = file.get("patch")
            if patch is not None:
                patches.append((len(patch.encode("utf-8")), file))

    for _size, file in sorted(patches, key=lambda item: item[0], reverse=True):
        if len(encode_bundle(bundle)) <= max_bundle_bytes:
            return
        file.pop("patch", None)
        file["renderState"] = "too_large"

    if len(encode_bundle(bundle)) <= max_bundle_bytes:
        return

    for repository in reversed(ready_repositories):
        files = repository["files"]
        while files and len(encode_bundle(bundle)) > max_bundle_bytes:
            files.pop()
            repository["truncated"] = True
            repository["omittedFileCount"] += 1

    if len(encode_bundle(bundle)) > max_bundle_bytes:
        raise DiffCaptureError("Session diff metadata exceeded the bundle limit")


async def collect_session_diff_bundle(
    repositories: list[RepoEntry],
    *,
    trigger_message_id: str | None,
    captured_at: int,
    limits: CaptureLimits | None = None,
) -> SessionDiffBundle:
    """Collect all session repositories into one coherent, bounded upload bundle."""
    active_limits = limits or CaptureLimits.defaults()
    remaining_files = active_limits.max_files
    remaining_patch_bytes = active_limits.max_capture_bytes
    outcomes: list[RepositoryUpload] = []

    for position, repository in enumerate(repositories):
        if not repository.base_sha:
            raise DiffCaptureError("Session start baseline is unavailable")
        try:
            capture = await collect_repository_diff(
                repository,
                repository.base_sha,
                CaptureLimits(
                    max_files=remaining_files,
                    max_patch_bytes=active_limits.max_patch_bytes,
                    max_capture_bytes=remaining_patch_bytes,
                    command_timeout_seconds=active_limits.command_timeout_seconds,
                    max_bundle_bytes=active_limits.max_bundle_bytes,
                    max_metadata_bytes=active_limits.max_metadata_bytes,
                ),
            )
        except Exception as error:
            outcomes.append(
                {
                    "status": "unavailable",
                    "position": position,
                    "repoOwner": repository.owner,
                    "repoName": repository.name,
                    "baseSha": repository.base_sha,
                    "error": str(error)[:2_000] or "Repository diff unavailable",
                    "files": [],
                }
            )
            continue

        remaining_files = max(0, remaining_files - len(capture.files))
        remaining_patch_bytes = max(
            0,
            remaining_patch_bytes
            - sum(
                len(changed.patch.encode("utf-8"))
                for changed in capture.files
                if changed.render_state == "renderable" and changed.patch is not None
            ),
        )
        outcomes.append(
            {
                "status": "ready",
                "position": position,
                "repoOwner": repository.owner,
                "repoName": repository.name,
                "baseSha": repository.base_sha,
                "headSha": capture.head_sha,
                "truncated": capture.truncated,
                "omittedFileCount": capture.omitted_file_count,
                "files": [_file_upload(changed) for changed in capture.files],
            }
        )

    bundle: SessionDiffBundle = {
        "version": 1,
        "triggerMessageId": trigger_message_id,
        "capturedAt": captured_at,
        "repositories": outcomes,
    }
    _bound_encoded_bundle(bundle, active_limits.max_bundle_bytes)
    return bundle

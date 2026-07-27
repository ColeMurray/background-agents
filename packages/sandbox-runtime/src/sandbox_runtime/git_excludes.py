"""Checkout-local Git exclusions for files installed by the sandbox runtime."""

from __future__ import annotations

import subprocess
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterable

BEGIN_MARKER = "# BEGIN Open-Inspect runtime assets"
END_MARKER = "# END Open-Inspect runtime assets"


def _git_exclude_path(repository: Path) -> Path:
    result = subprocess.run(
        ["git", "rev-parse", "--git-path", "info/exclude"],
        cwd=repository,
        check=True,
        capture_output=True,
        text=True,
    )
    path = Path(result.stdout.strip())
    return path if path.is_absolute() else repository / path


def _rooted_pattern(path: str) -> str:
    trailing_slash = path.endswith("/")
    candidate = PurePosixPath(path)
    if (
        candidate.is_absolute()
        or not candidate.parts
        or any(part == ".." for part in candidate.parts)
    ):
        raise ValueError(f"Runtime asset path must be repository-relative: {path!r}")
    normalized = candidate.as_posix()
    if normalized in ("", "."):
        raise ValueError(f"Runtime asset path must name a file or directory: {path!r}")
    return f"/{normalized}{'/' if trailing_slash else ''}"


def _managed_runtime_paths(contents: str) -> frozenset[str]:
    lines = contents.splitlines()
    try:
        start = lines.index(BEGIN_MARKER)
        end = lines.index(END_MARKER, start + 1)
    except ValueError:
        return frozenset()

    paths: set[str] = set()
    for pattern in lines[start + 1 : end]:
        if not pattern.startswith("/"):
            continue
        path = pattern[1:]
        try:
            if _rooted_pattern(path) == pattern:
                paths.add(path)
        except ValueError:
            continue
    return frozenset(paths)


def read_runtime_git_excludes(repository: Path) -> frozenset[str]:
    """Read the exact runtime-owned paths recorded in the managed exclude block."""
    try:
        return _managed_runtime_paths(_git_exclude_path(repository).read_text())
    except FileNotFoundError:
        return frozenset()


def is_runtime_git_excluded(path: str, runtime_paths: frozenset[str]) -> bool:
    """Return whether a repository-relative path is covered by runtime ownership."""
    return any(
        path == runtime_path.rstrip("/") or path.startswith(runtime_path.rstrip("/") + "/")
        for runtime_path in runtime_paths
    )


def _runtime_path_exists(repository: Path, path: str) -> bool:
    candidate = repository / path.rstrip("/")
    return candidate.exists() or candidate.is_symlink()


def install_runtime_git_excludes(repository: Path, runtime_paths: Iterable[str]) -> None:
    """Atomically reconcile our managed block without touching user entries."""
    current_patterns = {_rooted_pattern(path) for path in runtime_paths}
    exclude_path = _git_exclude_path(repository)
    try:
        existing = exclude_path.read_text()
    except FileNotFoundError:
        existing = ""

    retained_patterns = {
        _rooted_pattern(path)
        for path in _managed_runtime_paths(existing)
        if _runtime_path_exists(repository, path)
    }
    patterns = sorted(current_patterns | retained_patterns)
    block = "\n".join((BEGIN_MARKER, *patterns, END_MARKER)) + "\n" if patterns else ""
    start = existing.find(BEGIN_MARKER)
    end = existing.find(END_MARKER, start + len(BEGIN_MARKER)) if start >= 0 else -1
    if start >= 0 and end >= 0:
        suffix_start = end + len(END_MARKER)
        if existing[suffix_start : suffix_start + 2] == "\r\n":
            suffix_start += 2
        elif existing[suffix_start : suffix_start + 1] == "\n":
            suffix_start += 1
        updated = existing[:start] + block + existing[suffix_start:]
    else:
        if not block:
            return
        separator = "" if not existing or existing.endswith(("\n", "\r")) else "\n"
        updated = existing + separator + block

    if updated == existing:
        return
    exclude_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = exclude_path.with_name(f".{exclude_path.name}.open-inspect.tmp")
    temporary_path.write_text(updated)
    temporary_path.replace(exclude_path)

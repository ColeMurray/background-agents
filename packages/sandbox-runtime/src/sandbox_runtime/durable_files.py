"""Crash-safe file installation helpers for boot-time materializers."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path


def fsync_file(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _staging_prefix(path: Path) -> str:
    return f".{path.name}-"


def remove_abandoned_staging(path: Path) -> None:
    """Unlink staging files an interrupted ``atomic_write_private`` left beside ``path``.

    Symlinks are unlinked themselves, never followed.
    """
    for abandoned in path.parent.glob(f"{_staging_prefix(path)}*.tmp"):
        abandoned.unlink(missing_ok=True)


def atomic_write_private(path: Path, text: str) -> None:
    """Replace ``path`` with an owner-only (0600) file holding ``text``, all or nothing.

    mkstemp creates a unique O_EXCL staging file with mode 0600 before any
    content is written, so an existing symlink cannot be followed.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(
        prefix=_staging_prefix(path), suffix=".tmp", dir=path.parent
    )
    staging = Path(name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        staging.replace(path)
        fsync_directory(path.parent)
    finally:
        staging.unlink(missing_ok=True)

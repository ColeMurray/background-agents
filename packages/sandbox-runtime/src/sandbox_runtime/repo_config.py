"""Canonical session repository model.

The supervisor derives the repository list once from SESSION_CONFIG
(validating names as safe path segments and rejecting duplicates), then
writes it to REPO_MANIFEST_FILE_PATH. Every other consumer — the bridge's
push targeting and the JS create-pull-request tool — reads that manifest
instead of re-deriving the ``/workspace/<repo_name>`` convention, so the
checkout layout has exactly one owner.
"""

import json
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .constants import REPO_MANIFEST_FILE_PATH

# A single path segment with no separators. Leading dots are legal (a repo can
# be named ".github"); "." and ".." are rejected separately below.
_SAFE_SEGMENT_RE = re.compile(r"^[A-Za-z0-9._-]+$")


class RepoConfigError(ValueError):
    """SESSION_CONFIG carries a repository entry that cannot be trusted."""


@dataclass(frozen=True)
class RepoEntry:
    """One repository of the session workspace, in position order.

    The first entry is the primary (mirrors REPO_OWNER/REPO_NAME); every
    downstream code path iterates the list so single- and multi-repo sessions
    share one shape.
    """

    owner: str
    name: str
    branch: str
    path: Path


def is_safe_repo_segment(value: str) -> bool:
    """True when ``value`` is usable as a single checkout directory segment."""
    return bool(_SAFE_SEGMENT_RE.match(value)) and value not in (".", "..")


def is_safe_repo_owner(value: str) -> bool:
    """True when ``value`` is a namespace path of safe segments.

    An owner may be a single segment (GitHub, ``octocat``) or a nested
    namespace (GitLab subgroups, ``group/subgroup``). The owner is never used
    as a filesystem path — checkout directories derive from repo_name — so a
    ``/`` between safe segments is fine; this only rejects empty segments and
    traversal ("", "..", "a//b", "/etc", "a/") that could poison the clone URL.
    """
    parts = value.split("/")
    return len(parts) >= 1 and all(is_safe_repo_segment(part) for part in parts)


def _require_safe(*, owner: str, name: str) -> None:
    if not is_safe_repo_owner(owner):
        raise RepoConfigError(f"unsafe repo_owner {owner!r}: not a safe namespace path")
    if not is_safe_repo_segment(name):
        raise RepoConfigError(f"unsafe repo_name {name!r}: not a single path segment")


def _str_field(item: Mapping[str, Any], key: str) -> str:
    """A JSON field coerced to a stripped string ("" for null/missing)."""
    return str(item.get(key) or "").strip()


def parse_repositories(
    session_config: Mapping[str, Any],
    *,
    workspace_path: Path,
    scalar_owner: str = "",
    scalar_name: str = "",
    scalar_branch: str = "main",
) -> list[RepoEntry]:
    """Build the ordered repository list from SESSION_CONFIG or the scalar env.

    Checkout paths derive from repo_name, so owners/names must be safe single
    path segments and names must be unique (case-insensitive — checkout paths
    would collide). The control plane enforces both at create time, so a
    violation here means a corrupt or tampered config: RepoConfigError, and
    the boot must not proceed. Entries missing owner or name are skipped.
    """
    raw = session_config.get("repositories")
    entries: list[RepoEntry] = []
    seen_names: set[str] = set()
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            owner = _str_field(item, "repo_owner")
            name = _str_field(item, "repo_name")
            if not owner or not name:
                continue
            _require_safe(owner=owner, name=name)
            name_key = name.lower()
            if name_key in seen_names:
                raise RepoConfigError(f"duplicate repo_name {name!r}: checkout paths would collide")
            seen_names.add(name_key)
            branch = _str_field(item, "branch") or "main"
            entries.append(
                RepoEntry(owner=owner, name=name, branch=branch, path=workspace_path / name)
            )
    if entries:
        return entries
    if scalar_owner and scalar_name:
        _require_safe(owner=scalar_owner, name=scalar_name)
        return [
            RepoEntry(
                owner=scalar_owner,
                name=scalar_name,
                branch=scalar_branch,
                path=workspace_path / scalar_name,
            )
        ]
    return []


def find_repo_entry(entries: Iterable[RepoEntry], owner: str, name: str) -> RepoEntry | None:
    """Find a repository by identity, case-insensitively.

    GitHub owner/name identifiers are case-insensitive, but the returned
    entry carries the canonical casing (and checkout path) — callers must
    use the entry's fields, never the lookup arguments.
    """
    owner_key = owner.lower()
    name_key = name.lower()
    for entry in entries:
        if entry.owner.lower() == owner_key and entry.name.lower() == name_key:
            return entry
    return None


def dump_repo_manifest(repositories: list[RepoEntry]) -> str:
    """Serialize entries for REPO_MANIFEST_FILE_PATH."""
    return json.dumps(
        {
            "repositories": [
                {"owner": r.owner, "name": r.name, "branch": r.branch, "path": str(r.path)}
                for r in repositories
            ]
        }
    )


def load_repo_manifest(path: str | Path = REPO_MANIFEST_FILE_PATH) -> list[RepoEntry]:
    """Read the supervisor-written manifest; empty when missing or malformed."""
    try:
        data = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return []
    raw = data.get("repositories") if isinstance(data, dict) else None
    entries: list[RepoEntry] = []
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            owner = _str_field(item, "owner")
            name = _str_field(item, "name")
            path_value = _str_field(item, "path")
            if not owner or not name or not path_value:
                continue
            branch = _str_field(item, "branch") or "main"
            entries.append(RepoEntry(owner=owner, name=name, branch=branch, path=Path(path_value)))
    return entries

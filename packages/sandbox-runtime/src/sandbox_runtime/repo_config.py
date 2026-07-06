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
from dataclasses import dataclass
from pathlib import Path

from .constants import REPO_MANIFEST_FILE_PATH

# GitHub owner/repo identifiers: a single path segment with no separators.
# Leading dots are legal (a repo can be named ".github"); "." and ".." are
# rejected separately below.
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


def _require_safe(*, owner: str, name: str) -> None:
    for label, value in (("repo_owner", owner), ("repo_name", name)):
        if not is_safe_repo_segment(value):
            raise RepoConfigError(f"unsafe {label} {value!r}: not a single path segment")


def parse_repositories(
    session_config: dict,
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
            owner = str(item.get("repo_owner") or "").strip()
            name = str(item.get("repo_name") or "").strip()
            if not owner or not name:
                continue
            _require_safe(owner=owner, name=name)
            if name.lower() in seen_names:
                raise RepoConfigError(f"duplicate repo_name {name!r}: checkout paths would collide")
            seen_names.add(name.lower())
            branch = str(item.get("branch") or "").strip() or "main"
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
            owner = str(item.get("owner") or "").strip()
            name = str(item.get("name") or "").strip()
            path_value = str(item.get("path") or "").strip()
            if not owner or not name or not path_value:
                continue
            branch = str(item.get("branch") or "").strip() or "main"
            entries.append(RepoEntry(owner=owner, name=name, branch=branch, path=Path(path_value)))
    return entries

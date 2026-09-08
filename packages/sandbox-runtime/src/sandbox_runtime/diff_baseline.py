"""Immutable session-diff baseline resolution."""

from __future__ import annotations

from dataclasses import replace
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from .repo_config import RepoEntry


async def resolve_session_diff_baselines(
    repositories: list[RepoEntry],
    *,
    discover_missing: bool,
    get_head_sha: Callable[[RepoEntry], Awaitable[str]],
) -> list[RepoEntry]:
    """Keep supplied baselines immutable and discover them only on the first boot."""
    resolved: list[RepoEntry] = []
    for repository in repositories:
        base_sha = repository.base_sha
        if base_sha is None and discover_missing:
            discovered_sha = await get_head_sha(repository)
            base_sha = discovered_sha or None
        resolved.append(replace(repository, base_sha=base_sha))
    return resolved

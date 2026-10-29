"""Supervisor half of the Claude harness: staging only, no resident process.

``ClaudeStager`` conforms to ``HarnessProcessOwner`` like ``OpenCodeServer``
does, but the vendor process is spawned later by the SDK inside the bridge,
so ``start()`` only prepares the filesystem the child will see:

- a per-sandbox ``CLAUDE_CONFIG_DIR`` outside every repository, where the
  harness never writes credentials (no ``claude auth login`` ever runs);
- the bundled skills under that directory (managed skills land in the same
  tree through ``ManagedSkillsMaterializer``);
- the standalone bin scripts the agent calls from Bash;
- a small JSON handoff (``CLAUDE_HARNESS_FILE_PATH``) telling the bridge which
  workdir and config dir the supervisor chose. It carries decisions only: MCP
  configuration, which can hold credentials, reaches the bridge through its
  own ``SESSION_CONFIG`` and is never written to disk here.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .constants import CLAUDE_HARNESS_FILE_PATH
from .harness_stager import BUNDLED_SKILLS_PATH, HarnessHandoff, HarnessStager

if TYPE_CHECKING:
    from collections.abc import Sequence

    from .mcp_packages import McpPackageInstaller
    from .repo_config import RepoEntry
    from .runtime_config import ClaudeStagerConfig


DEFAULT_CLAUDE_CONFIG_DIR_NAME = ".openinspect/claude"


def resolve_claude_config_dir() -> Path:
    """Per-sandbox ``CLAUDE_CONFIG_DIR``: outside every repository, never snapshotted with a credential."""
    override = os.environ.get("CLAUDE_CONFIG_DIR")
    if override:
        return Path(override)
    return Path.home() / DEFAULT_CLAUDE_CONFIG_DIR_NAME


def isolated_claude_config_dir(
    candidate: Path, workspace: Path, repositories: Sequence[RepoEntry], log: Any
) -> Path:
    """``candidate``, unless it lies inside the workspace or a checkout.

    A user-supplied ``CLAUDE_CONFIG_DIR`` pointing into a repository would put
    transcripts, skills and the wrapper into the user's diff. Decided once, in
    the composition root, so managed skills and the stager agree on the
    directory before either writes to it.
    """
    resolved = _resolve_lenient(candidate)
    for root in (workspace, *(repo.path for repo in repositories)):
        root_resolved = _resolve_lenient(root)
        if resolved == root_resolved or root_resolved in resolved.parents:
            fallback = Path.home() / DEFAULT_CLAUDE_CONFIG_DIR_NAME
            log.warn(
                "claude.config_dir_rejected",
                config_dir=str(candidate),
                inside=str(root),
                fallback=str(fallback),
            )
            return fallback
    return candidate


class ClaudeHarnessHandoff(HarnessHandoff):
    default_path = Path(CLAUDE_HARNESS_FILE_PATH)


class ClaudeStager(HarnessStager):
    """``HarnessProcessOwner`` for the Claude harness; ``exit_code()`` is always ``None``."""

    def __init__(
        self,
        config: ClaudeStagerConfig,
        log: Any,
        *,
        mcp_packages: McpPackageInstaller,
        config_dir: Path | None = None,
        bundled_skills_path: Path = BUNDLED_SKILLS_PATH,
        handoff_path: Path = Path(CLAUDE_HARNESS_FILE_PATH),
    ) -> None:
        super().__init__(
            config,
            log,
            config_dir=config_dir or resolve_claude_config_dir(),
            bundled_skills_path=bundled_skills_path,
            handoff_path=handoff_path,
            mcp_packages=mcp_packages,
            log_prefix="claude",
        )

    def _prepare_config_dir(self) -> None:
        self.config_dir.mkdir(parents=True, exist_ok=True)


def _resolve_lenient(path: Path) -> Path:
    try:
        return path.resolve()
    except OSError:
        return path

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
  workdir and config dir the supervisor chose.
"""

from __future__ import annotations

import json
import os
import shutil
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .constants import CLAUDE_HARNESS_FILE_PATH
from .sandbox_bin import install_bin_scripts

if TYPE_CHECKING:
    from collections.abc import Sequence

    from .repo_config import RepoEntry
    from .runtime_config import ClaudeStagerConfig


DEFAULT_CLAUDE_CONFIG_DIR_NAME = ".openinspect/claude"
BUNDLED_SKILLS_PATH = Path("/app/sandbox_runtime/skills")


def resolve_claude_config_dir() -> Path:
    """Per-sandbox ``CLAUDE_CONFIG_DIR``: outside every repository, never snapshotted with a credential."""
    override = os.environ.get("CLAUDE_CONFIG_DIR")
    if override:
        return Path(override)
    return Path.home() / DEFAULT_CLAUDE_CONFIG_DIR_NAME


def _plain_json(value: Any) -> Any:
    """Undo ``runtime_config``'s freezing: mapping proxies and tuples → dicts and lists.

    ``SESSION_CONFIG`` is frozen recursively, so an MCP server's nested ``env``
    or ``headers`` is a ``MappingProxyType`` that ``json.dumps`` rejects.
    """
    if isinstance(value, Mapping):
        return {str(key): _plain_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain_json(item) for item in value]
    return value


@dataclass(frozen=True)
class ClaudeHarnessHandoff:
    """What the supervisor decided and the bridge must use."""

    workdir: Path
    config_dir: Path
    has_repository: bool
    mcp_servers: tuple[Mapping[str, Any], ...]

    def write(self, path: Path = Path(CLAUDE_HARNESS_FILE_PATH)) -> None:
        path.write_text(
            json.dumps(
                {
                    "workdir": str(self.workdir),
                    "configDir": str(self.config_dir),
                    "hasRepository": self.has_repository,
                    "mcpServers": [_plain_json(server) for server in self.mcp_servers],
                }
            )
        )

    @classmethod
    def read(cls, path: Path = Path(CLAUDE_HARNESS_FILE_PATH)) -> ClaudeHarnessHandoff:
        data = json.loads(path.read_text())
        servers = data.get("mcpServers")
        return cls(
            workdir=Path(str(data["workdir"])),
            config_dir=Path(str(data["configDir"])),
            has_repository=bool(data.get("hasRepository")),
            mcp_servers=tuple(s for s in servers if isinstance(s, dict))
            if isinstance(servers, list)
            else (),
        )


class ClaudeStager:
    """``HarnessProcessOwner`` for the Claude harness; ``exit_code()`` is always ``None``."""

    def __init__(
        self,
        config: ClaudeStagerConfig,
        log: Any,
        *,
        config_dir: Path | None = None,
        bundled_skills_path: Path = BUNDLED_SKILLS_PATH,
        handoff_path: Path = Path(CLAUDE_HARNESS_FILE_PATH),
    ) -> None:
        self.config = config
        self.log = log
        self.config_dir = config_dir or resolve_claude_config_dir()
        self.bundled_skills_path = bundled_skills_path
        self.handoff_path = handoff_path
        self.started = False

    @property
    def skills_dir(self) -> Path:
        return self.config_dir / "skills"

    async def start(self, repositories: Sequence[RepoEntry], workdir: Path) -> None:
        self.log.info("claude.stage", config_dir=str(self.config_dir), workdir=str(workdir))
        self.config_dir.mkdir(parents=True, exist_ok=True)
        # Nothing the harness writes here is a credential; the directory is
        # only for Claude's own state (transcripts under projects/, settings).
        self._install_bundled_skills()
        install_bin_scripts(self.log)
        ClaudeHarnessHandoff(
            workdir=workdir,
            config_dir=self.config_dir,
            has_repository=self.config.has_repository,
            mcp_servers=self.config.mcp_servers,
        ).write(self.handoff_path)
        self.started = True
        self.log.info("claude.staged", repo_count=len(repositories))

    def _install_bundled_skills(self) -> None:
        if not self.bundled_skills_path.is_dir():
            return
        installed = 0
        for skill_dir in self.bundled_skills_path.iterdir():
            if not skill_dir.is_dir() or not (skill_dir / "SKILL.md").exists():
                continue
            shutil.copytree(
                skill_dir,
                self.skills_dir / skill_dir.name,
                dirs_exist_ok=True,
                ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"),
                symlinks=True,
            )
            installed += 1
        if installed:
            self.log.info(
                "claude.skills_installed", skills_path=str(self.skills_dir), count=installed
            )

    async def stop(self) -> None:
        return None

    def exit_code(self) -> int | None:
        # There is no resident vendor process; the SDK child belongs to the bridge.
        return None

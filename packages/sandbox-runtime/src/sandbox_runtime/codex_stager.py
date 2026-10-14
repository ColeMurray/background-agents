"""Supervisor half of the Codex harness: staging only, no resident process.

``CodexStager`` conforms to ``HarnessProcessOwner`` like ``OpenCodeServer``
does, but the native app-server process is spawned later by the bridge,
so ``start()`` only prepares the filesystem the child will see:

- a per-sandbox ``CODEX_HOME`` outside every repository, where the
  harness never writes credentials (no ``codex login`` ever runs);
- the bundled skills under that directory (managed skills land in the same
  tree through ``ManagedSkillsMaterializer``);
- the standalone bin scripts the agent calls from Bash;
- a small JSON handoff (``CODEX_HARNESS_FILE_PATH``) telling the bridge which
  workdir and config dir the supervisor chose. It carries decisions only: MCP
  configuration, which can hold credentials, reaches the bridge through its
  own ``SESSION_CONFIG`` and is never written to disk here.
"""

from __future__ import annotations

import json
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .constants import CODEX_HARNESS_FILE_PATH
from .mcp_packages import McpPackageInstaller
from .sandbox_bin import install_bin_scripts

if TYPE_CHECKING:
    from collections.abc import Sequence

    from .repo_config import RepoEntry
    from .runtime_config import CodexStagerConfig


DEFAULT_CODEX_CONFIG_DIR_NAME = ".openinspect/codex"
BUNDLED_SKILLS_PATH = Path("/app/sandbox_runtime/skills")


def resolve_codex_config_dir() -> Path:
    """Per-sandbox ``CODEX_HOME``: outside every repository, with credential-free native history."""
    return Path.home() / DEFAULT_CODEX_CONFIG_DIR_NAME


@dataclass(frozen=True)
class CodexHarnessHandoff:
    """What the supervisor decided and the bridge must use. Never a secret."""

    workdir: Path
    config_dir: Path
    has_repository: bool

    def write(self, path: Path = Path(CODEX_HARNESS_FILE_PATH)) -> None:
        payload = json.dumps(
            {
                "workdir": str(self.workdir),
                "configDir": str(self.config_dir),
                "hasRepository": self.has_repository,
            }
        )
        # Owner-only and atomic: a reader sees the whole file or none of it.
        staging = path.with_name(path.name + ".tmp")
        descriptor = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w") as handle:
            handle.write(payload)
        staging.replace(path)

    @classmethod
    def read(cls, path: Path = Path(CODEX_HARNESS_FILE_PATH)) -> CodexHarnessHandoff:
        data = json.loads(path.read_text())
        return cls(
            workdir=Path(str(data["workdir"])),
            config_dir=Path(str(data["configDir"])),
            has_repository=bool(data.get("hasRepository")),
        )


class CodexStager:
    """``HarnessProcessOwner`` for the Codex harness; ``exit_code()`` is always ``None``."""

    def __init__(
        self,
        config: CodexStagerConfig,
        log: Any,
        *,
        config_dir: Path | None = None,
        bundled_skills_path: Path = BUNDLED_SKILLS_PATH,
        handoff_path: Path = Path(CODEX_HARNESS_FILE_PATH),
        mcp_packages: McpPackageInstaller | None = None,
    ) -> None:
        self.config = config
        self.log = log
        self.config_dir = config_dir or resolve_codex_config_dir()
        self.bundled_skills_path = bundled_skills_path
        self.handoff_path = handoff_path
        self._mcp_packages = mcp_packages or McpPackageInstaller(log)
        self.started = False

    @property
    def skills_dir(self) -> Path:
        return self.config_dir / "skills"

    async def start(self, repositories: Sequence[RepoEntry], workdir: Path) -> None:
        self.log.info("codex.stage", config_dir=str(self.config_dir), workdir=str(workdir))
        self.config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.config_dir.chmod(0o700)
        # Nothing the harness writes here is a credential; the directory is
        # only for native history and skills.
        self._install_bundled_skills()
        install_bin_scripts(self.log)
        # Best effort, as at OpenCode boot: a local npx server resolved now
        # does not download during the first prompt.
        try:
            await self._mcp_packages.install(list(self.config.mcp_servers))
        except Exception as error:
            self.log.warn("codex.mcp_preinstall_failed", exc=error)
        CodexHarnessHandoff(
            workdir=workdir,
            config_dir=self.config_dir,
            has_repository=self.config.has_repository,
        ).write(self.handoff_path)
        self.started = True
        self.log.info("codex.staged", repo_count=len(repositories))

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
                "codex.skills_installed", skills_path=str(self.skills_dir), count=installed
            )

    async def stop(self) -> None:
        return None

    def exit_code(self) -> int | None:
        # There is no resident vendor process; the app-server child belongs to the bridge.
        return None

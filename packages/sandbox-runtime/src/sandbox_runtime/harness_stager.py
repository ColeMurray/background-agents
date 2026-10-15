"""Shared supervisor staging for harnesses whose process belongs to the bridge.

Only filesystem decisions reach the handoff. MCP configuration can contain
credentials, so the bridge reads it from its own SESSION_CONFIG instead.
"""

from __future__ import annotations

import json
import os
import shutil
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar, Self

from .sandbox_bin import install_bin_scripts

if TYPE_CHECKING:
    from collections.abc import Sequence

    from .mcp_packages import McpPackageInstaller
    from .repo_config import RepoEntry
    from .runtime_config import ClaudeStagerConfig, CodexStagerConfig

BUNDLED_SKILLS_PATH = Path("/app/sandbox_runtime/skills")


@dataclass(frozen=True)
class HarnessHandoff:
    """What the supervisor decided and the bridge must use. Never a secret."""

    default_path: ClassVar[Path]
    workdir: Path
    config_dir: Path
    has_repository: bool

    def write(self, path: Path | None = None) -> None:
        path = path if path is not None else self.default_path
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
    def read(cls, path: Path | None = None) -> Self:
        path = path if path is not None else cls.default_path
        data = json.loads(path.read_text())
        return cls(
            workdir=Path(str(data["workdir"])),
            config_dir=Path(str(data["configDir"])),
            has_repository=bool(data.get("hasRepository")),
        )


class HarnessStager(ABC):
    """Stage skills, bin scripts, MCP packages and a handoff, without a resident process."""

    def __init__(
        self,
        config: ClaudeStagerConfig | CodexStagerConfig,
        log: Any,
        *,
        config_dir: Path,
        bundled_skills_path: Path,
        handoff_path: Path,
        mcp_packages: McpPackageInstaller,
        log_prefix: str,
    ) -> None:
        self.config = config
        self.log = log
        self.config_dir = config_dir
        self.bundled_skills_path = bundled_skills_path
        self.handoff_path = handoff_path
        self._mcp_packages = mcp_packages
        self._log_prefix = log_prefix
        self.started = False

    @property
    def skills_dir(self) -> Path:
        return self.config_dir / "skills"

    @abstractmethod
    def _prepare_config_dir(self) -> None: ...

    async def start(self, repositories: Sequence[RepoEntry], workdir: Path) -> None:
        self.log.info(
            f"{self._log_prefix}.stage", config_dir=str(self.config_dir), workdir=str(workdir)
        )
        self._prepare_config_dir()
        self._install_bundled_skills()
        install_bin_scripts(self.log)
        # Best effort, as at OpenCode boot: resolve local npx servers before the first prompt.
        try:
            await self._mcp_packages.install(list(self.config.mcp_servers))
        except Exception as error:
            self.log.warn(f"{self._log_prefix}.mcp_preinstall_failed", exc=error)
        HarnessHandoff(
            workdir=workdir,
            config_dir=self.config_dir,
            has_repository=self.config.has_repository,
        ).write(self.handoff_path)
        self.started = True
        self.log.info(f"{self._log_prefix}.staged", repo_count=len(repositories))

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
                f"{self._log_prefix}.skills_installed",
                skills_path=str(self.skills_dir),
                count=installed,
            )

    async def stop(self) -> None:
        return None

    def exit_code(self) -> int | None:
        # There is no resident vendor process; the child belongs to the bridge.
        return None

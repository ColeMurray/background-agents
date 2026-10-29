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

from pathlib import Path
from typing import TYPE_CHECKING, Any

from .constants import CODEX_HARNESS_FILE_PATH
from .harness_stager import BUNDLED_SKILLS_PATH, HarnessHandoff, HarnessStager

if TYPE_CHECKING:
    from .mcp_packages import McpPackageInstaller
    from .runtime_config import CodexStagerConfig


DEFAULT_CODEX_CONFIG_DIR_NAME = ".openinspect/codex"


def resolve_codex_config_dir() -> Path:
    """Per-sandbox ``CODEX_HOME``: outside every repository, with credential-free native history."""
    return Path.home() / DEFAULT_CODEX_CONFIG_DIR_NAME


class CodexHarnessHandoff(HarnessHandoff):
    default_path = Path(CODEX_HARNESS_FILE_PATH)


class CodexStager(HarnessStager):
    """``HarnessProcessOwner`` for the Codex harness; ``exit_code()`` is always ``None``."""

    def __init__(
        self,
        config: CodexStagerConfig,
        log: Any,
        *,
        mcp_packages: McpPackageInstaller,
        config_dir: Path | None = None,
        bundled_skills_path: Path = BUNDLED_SKILLS_PATH,
        handoff_path: Path = Path(CODEX_HARNESS_FILE_PATH),
    ) -> None:
        super().__init__(
            config,
            log,
            config_dir=config_dir or resolve_codex_config_dir(),
            bundled_skills_path=bundled_skills_path,
            handoff_path=handoff_path,
            mcp_packages=mcp_packages,
            log_prefix="codex",
        )

    def _prepare_config_dir(self) -> None:
        self.config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.config_dir.chmod(0o700)

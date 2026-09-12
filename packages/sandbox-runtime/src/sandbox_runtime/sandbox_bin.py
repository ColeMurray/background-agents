"""Standalone CLI scripts installed into the sandbox bin directory."""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Any

from .constants import BIN_INSTALL_DIR_ENV_VAR, DEFAULT_BIN_INSTALL_DIR

BUNDLED_BIN_DIR = Path("/app/sandbox_runtime/bin")


def install_bin_scripts(log: Any, *, bin_dir: Path = BUNDLED_BIN_DIR) -> list[str]:
    """Install the bundled CLIs (``upload-media``, ``oi-git-sign``) for the agent's shell.

    These are standalone CLIs, not agent tool plugins, and both harnesses need
    them on ``PATH``. They must never be placed where a harness discovers
    tools (OpenCode would import them during tool discovery).
    """
    if not bin_dir.is_dir():
        return []
    install_dir = Path(os.environ.get(BIN_INSTALL_DIR_ENV_VAR, DEFAULT_BIN_INSTALL_DIR))
    install_dir.mkdir(parents=True, exist_ok=True)
    installed: list[str] = []
    for script in sorted(bin_dir.iterdir()):
        if not script.is_file() or script.suffix not in {"", ".js"}:
            continue
        command_name = script.stem if script.suffix == ".js" else script.name
        dest = install_dir / command_name
        shutil.copy(script, dest)
        dest.chmod(0o755)
        installed.append(command_name)
        log.info("bin.installed", script=command_name)
    return installed

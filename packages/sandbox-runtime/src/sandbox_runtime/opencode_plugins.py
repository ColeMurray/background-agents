"""Bounded preinstallation into the pinned OpenCode loader's npm cache.

Keep the original npm spec in OpenCode's config, preserving package identity,
entrypoint selection and legacy/v1 plugin semantics. The cache layout is covered
by a real-binary contract test and must be checked when upgrading OpenCode.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
from pathlib import Path

from .process_output import communicate_owned_subprocess, spawn_owned_subprocess

PLUGIN_INSTALL_TIMEOUT_SECONDS = 20
PLUGIN_INSTALL_BUDGET_SECONDS = 60
PLUGIN_INITIALIZATION_TIMEOUT_SECONDS = 30
PLUGIN_SPEC_RE = re.compile(
    r"(?P<name>(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*)@"
    r"(?P<version>(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$"
)


def plugin_cache_dir() -> Path:
    return (
        Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache")))
        / "opencode"
        / "packages"
    )


async def install_plugin(spec: str, cache_dir: Path) -> None:
    match = PLUGIN_SPEC_RE.fullmatch(spec)
    if match is None:
        raise ValueError("plugin must be an npm package with an exact version")
    # OpenCode 1.18.29's Npm.add uses packages/<spec>/node_modules/<name>.
    directory = cache_dir / spec
    manifest = directory / "node_modules" / match["name"] / "package.json"
    complete = directory / ".openinspect-complete"
    try:
        package = json.loads(manifest.read_text())
        if (
            isinstance(package, dict)
            and complete.is_file()
            and package.get("name") == match["name"]
            and package.get("version") == match["version"]
        ):
            return
    except (OSError, ValueError):
        pass
    # A killed install must never be reused by OpenCode's existence-only check.
    if directory.exists():
        shutil.rmtree(directory)
    directory.mkdir(parents=True)
    (directory / "package.json").write_text('{"private":true}')
    process = await spawn_owned_subprocess(
        asyncio.create_subprocess_exec(
            "npm",
            "install",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--save-exact",
            "--",
            spec,
            cwd=directory,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            start_new_session=True,
        )
    )
    await asyncio.wait_for(
        communicate_owned_subprocess(process), timeout=PLUGIN_INSTALL_TIMEOUT_SECONDS
    )
    if process.returncode != 0:
        raise RuntimeError("npm install failed")
    package = json.loads(manifest.read_text())
    if (
        not isinstance(package, dict)
        or package.get("name") != match["name"]
        or package.get("version") != match["version"]
    ):
        raise ValueError("installed package does not match the configured version")
    complete.touch()

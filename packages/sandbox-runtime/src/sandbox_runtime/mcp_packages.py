"""Reuse installed MCP dependencies without freezing floating npm versions across boots."""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from collections import Counter
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .process_output import communicate_owned_subprocess

if TYPE_CHECKING:
    from collections.abc import Mapping

NPM_PACKAGE_RE = re.compile(r"(?P<name>(?:@[\w.-]+/)?[\w][\w.-]*)(?:@(?P<version>[\w.+-]+))?$")
_EXACT_VERSION_RE = re.compile(r"\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$")
MCP_PACKAGE_INSTALL_TIMEOUT_SECONDS = 180
_NPM_ROOT_TIMEOUT_SECONDS = 5
_INCOMPLETE_INSTALL_FILE = ".openinspect-mcp-installing.json"


def _write_incomplete(marker: Path, names: set[str]) -> None:
    # Publish before starting npm without truncating an earlier failed-install record.
    temporary = marker.with_suffix(".tmp")
    temporary.write_text(json.dumps(sorted(names)))
    temporary.replace(marker)


def _packages(servers: list[Mapping[str, Any]]) -> list[str]:
    """Recognize simple npx commands; leave other npm options to npx itself.

    Stop at the executable: its arguments (including -p) are not npx options.
    """
    packages: list[str] = []
    for server in servers:
        command = server.get("command") or ()
        if server.get("type") == "remote" or not command or command[0] != "npx":
            continue
        selected: list[str] = []
        index = 1
        while index < len(command):
            part = command[index]
            if not isinstance(part, str):
                selected = []
                break
            if part in ("-y", "--yes"):
                index += 1
                continue
            if part in ("-p", "--package") and index + 1 < len(command):
                selected.append(command[index + 1])
                index += 2
                continue
            if part.startswith("--package="):
                selected.append(part.removeprefix("--package="))
                index += 1
                continue
            if part == "--" and index + 1 < len(command):
                part = command[index + 1]
            elif part.startswith("-"):
                selected = []
                break
            if not selected:
                selected.append(part)
            break
        packages.extend(
            package
            for package in selected
            if isinstance(package, str) and NPM_PACKAGE_RE.fullmatch(package)
        )
    return list(dict.fromkeys(packages))


class McpPackageInstaller:
    def __init__(self, log: Any) -> None:
        self.log = log
        self._root: Path | None = None
        # Only this supervisor lifetime: a restored sandbox refreshes floating specs.
        self._resolved_this_boot: dict[str, str] = {}

    async def _global_root(self) -> Path | None:
        if self._root is not None:
            return self._root
        try:
            process = await asyncio.create_subprocess_exec(
                "npm",
                "root",
                "--global",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
            stdout, _ = await asyncio.wait_for(
                communicate_owned_subprocess(process), timeout=_NPM_ROOT_TIMEOUT_SECONDS
            )
            path = stdout.decode().strip()
            if process.returncode == 0 and "\n" not in path and Path(path).is_absolute():
                self._root = Path(path)
        except (OSError, ValueError, TimeoutError) as error:
            self.log.warn("mcp.cache_lookup_failed", error=str(error))
        return self._root

    def _installed_version(self, name: str) -> str | None:
        if self._root is None:
            return None
        package_dir = self._root / name
        try:
            manifest = json.loads((package_dir / "package.json").read_text())
            if not isinstance(manifest, dict) or manifest.get("name") != name:
                return None
            version = manifest.get("version")
            if not isinstance(version, str) or not _EXACT_VERSION_RE.fullmatch(version):
                return None
            bins = manifest.get("bin")
            if isinstance(bins, str):
                bins = {name.rsplit("/", 1)[-1]: bins}
            if not isinstance(bins, dict) or not bins:
                return None
            # npm's Unix global layout is {prefix}/lib/node_modules and {prefix}/bin.
            for binary, relative_path in bins.items():
                if not isinstance(binary, str) or not isinstance(relative_path, str):
                    return None
                target = package_dir / relative_path
                link = self._root.parent.parent / "bin" / binary
                if not os.access(target, os.X_OK) or not link.samefile(target):
                    return None
            return version
        except (OSError, ValueError):
            return None

    async def install(self, servers: list[Mapping[str, Any]]) -> None:
        """Best-effort preinstall packages from supported local npx server commands.

        Reuse exact version pins only when the installed manifest and executable
        links validate. Floating specs (including unversioned packages) must be
        installed once per installer lifetime before they can be reused, so a
        new supervisor refreshes them even when restoring a sandbox snapshot.

        Install only cache misses, recording their package names on disk before
        invoking npm. Failed or interrupted installs leave that marker behind
        so a later call retries them instead of trusting partial installations.

        Installation errors are logged and do not abort server startup; npx
        remains responsible for launching the server. Cancellation propagates
        after the owned npm process is cleaned up.
        """
        packages = _packages(servers)
        if not packages:
            return
        started_at = time.monotonic()
        root = await self._global_root()
        marker = root / _INCOMPLETE_INSTALL_FILE if root else None
        specs = {
            package: (match["name"], match["version"] or "")
            for package in packages
            if (match := NPM_PACKAGE_RE.fullmatch(package))
        }
        incomplete: set[str] = set()
        if marker is not None:
            try:
                pending = json.loads(marker.read_text())
                if not isinstance(pending, list) or not all(isinstance(p, str) for p in pending):
                    raise ValueError("invalid incomplete-install marker")
                incomplete.update(pending)
            except FileNotFoundError:
                pass
            except (OSError, ValueError):
                # A damaged marker cannot certify any existing installation.
                incomplete.update(name for name, _ in specs.values())
        # Keep conflicting specs in request order: filtering one out could change
        # which version wins when npm installs several specs for the same name.
        counts = Counter(name for name, _ in specs.values())
        missing: list[str] = []
        for package, (name, requested) in specs.items():
            expected = (
                requested
                if _EXACT_VERSION_RE.fullmatch(requested)
                else self._resolved_this_boot.get(package)
            )
            if (
                name in incomplete
                or counts[name] > 1
                or not expected
                or self._installed_version(name) != expected
            ):
                missing.append(package)

        self.log.info(
            "mcp.package_cache",
            hits=len(packages) - len(missing),
            misses=len(missing),
            duration_ms=round((time.monotonic() - started_at) * 1000),
        )
        if not missing:
            return
        # Forget prior floating resolutions before retrying: failed npm work may
        # mutate the installed package even if it exits unsuccessfully.
        for package in missing:
            self._resolved_this_boot.pop(package, None)
        if marker is not None:
            try:
                marker.parent.mkdir(parents=True, exist_ok=True)
                # Persist before npm runs: a killed/failed install must be retried after restore.
                _write_incomplete(marker, incomplete | {specs[p][0] for p in missing})
            except OSError as error:
                self.log.warn("mcp.cache_marker_failed", error=str(error))
                marker = None
        try:
            self.log.info("mcp.install_packages", packages=missing)
            process = await asyncio.create_subprocess_exec(
                "npm",
                "install",
                "-g",
                *missing,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
            _, stderr = await asyncio.wait_for(
                communicate_owned_subprocess(process), timeout=MCP_PACKAGE_INSTALL_TIMEOUT_SECONDS
            )
            if process.returncode != 0:
                self.log.warn(
                    "mcp.packages_install_failed",
                    packages=missing,
                    stderr=stderr.decode(errors="replace")[:500],
                )
                return
            # Remember only validated results for reuse within this supervisor.
            for package in missing:
                version = self._installed_version(specs[package][0])
                if version:
                    self._resolved_this_boot[package] = version
            if marker is not None:
                remaining = incomplete - {specs[p][0] for p in missing}
                if remaining:
                    _write_incomplete(marker, remaining)
                else:
                    marker.unlink(missing_ok=True)
            self.log.info(
                "mcp.packages_installed",
                packages=missing,
                duration_ms=round((time.monotonic() - started_at) * 1000),
            )
        except TimeoutError:
            self.log.warn(
                "mcp.packages_install_timeout",
                packages=missing,
                timeout_seconds=MCP_PACKAGE_INSTALL_TIMEOUT_SECONDS,
            )
        except Exception as error:
            self.log.warn("mcp.packages_install_error", packages=missing, exc=str(error))

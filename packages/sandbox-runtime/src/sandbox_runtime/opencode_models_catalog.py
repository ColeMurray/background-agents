"""OpenCode's model catalog, written before the process that reads it.

OpenCode resolves providers and models from ``models.json`` in its cache
directory when that file exists, and from the catalog compiled into its binary
when it does not. Its own download runs in the background and only reaches the
next process, so a fresh ``opencode serve`` never sees a model published after
the pinned release unless a newer file is already on disk. Image builds write
that file, and every sandbox started from the image resolves models as of the
build.

``opencode models --refresh`` downloads the catalog, writes it and loads it with
the installed OpenCode. It runs against a throwaway cache first, because it
reports success when the download fails and writes a catalog before finding it
cannot load it: only an exit 0 that produced a file replaces the real one. The
refresh is best-effort: any failure leaves the existing file (or its absence)
untouched, which is exactly what OpenCode would have used anyway.
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final

from .log_config import configure_logging, get_logger

if TYPE_CHECKING:
    from collections.abc import Mapping

REFRESH_TIMEOUT_SECONDS: Final = 60.0
#: The mode OpenCode's own catalog writes produce.
CATALOG_FILE_MODE: Final = 0o644
_STDERR_TAIL_CHARS: Final = 500


def resolve_opencode_models_cache_path() -> Path:
    """Resolve the catalog file OpenCode reads, using its xdg-basedir rules."""
    xdg = os.environ.get("XDG_CACHE_HOME")
    base = Path(xdg) if xdg else Path.home() / ".cache"
    return base / "opencode" / "models.json"


def catalog_override(environ: Mapping[str, str]) -> str | None:
    """Name the variable that stops OpenCode reading a downloaded default catalog.

    Each variable follows OpenCode's own reading of it: a set
    ``OPENCODE_MODELS_PATH`` (even empty) replaces the cache file, an empty
    ``OPENCODE_MODELS_URL`` means the default source, and
    ``OPENCODE_DISABLE_MODELS_FETCH`` is on only for ``true`` or ``1``.
    ``--refresh`` downloads regardless of that last flag, so it is checked here.
    """
    if "OPENCODE_MODELS_PATH" in environ:
        return "OPENCODE_MODELS_PATH"
    if environ.get("OPENCODE_MODELS_URL"):
        return "OPENCODE_MODELS_URL"
    if environ.get("OPENCODE_DISABLE_MODELS_FETCH", "").lower() in ("true", "1"):
        return "OPENCODE_DISABLE_MODELS_FETCH"
    return None


class OpenCodeModelsCatalog:
    def __init__(
        self, log: Any, *, path: Path | None = None, opencode_command: str = "opencode"
    ) -> None:
        self.log = log
        self.path = path
        self.opencode_command = opencode_command

    async def refresh(self) -> bool:
        """Replace the cached catalog with the published one. Only cancellation escapes."""
        override = catalog_override(os.environ)
        if override:
            self.log.info("opencode_models.refresh_skipped", reason=override)
            return False

        path = self.path or resolve_opencode_models_cache_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            # Inside the destination directory, so the rename below stays on one
            # filesystem and never exposes a partial file.
            with tempfile.TemporaryDirectory(
                dir=path.parent, prefix=".opencode-catalog-", ignore_cleanup_errors=True
            ) as scratch:
                downloaded = await self._download(Path(scratch))
                size_bytes = downloaded.stat().st_size
                downloaded.chmod(CATALOG_FILE_MODE)
                downloaded.replace(path)
        except Exception as error:
            self.log.warn("opencode_models.refresh_failed", exc=error)
            return False
        self.log.info("opencode_models.refreshed", path=str(path), size_bytes=size_bytes)
        return True

    async def _download(self, scratch: Path) -> Path:
        """Run ``opencode models --refresh`` with a throwaway home; return the catalog it wrote."""
        environment = {
            key: value for key, value in os.environ.items() if not key.startswith("OPENCODE_")
        }
        environment.update(
            {
                "HOME": str(scratch),
                "XDG_CONFIG_HOME": str(scratch / "config"),
                "XDG_DATA_HOME": str(scratch / "data"),
                "XDG_STATE_HOME": str(scratch / "state"),
                "XDG_CACHE_HOME": str(scratch / "cache"),
            }
        )
        process = await asyncio.create_subprocess_exec(
            self.opencode_command,
            "models",
            "--refresh",
            cwd=scratch,
            env=environment,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            async with asyncio.timeout(REFRESH_TIMEOUT_SECONDS):
                _stdout, stderr = await process.communicate()
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
        if process.returncode != 0:
            detail = stderr.decode(errors="replace").strip()[-_STDERR_TAIL_CHARS:]
            raise RuntimeError(f"opencode models --refresh exited {process.returncode}: {detail}")
        downloaded = scratch / "cache" / "opencode" / "models.json"
        if not downloaded.is_file():
            raise RuntimeError("opencode models --refresh did not download a catalog")
        return downloaded


def main() -> int:
    """Refresh the catalog for the current ``HOME``; image installation calls this."""
    configure_logging()
    catalog = OpenCodeModelsCatalog(get_logger("opencode_models"))
    asyncio.run(catalog.refresh())
    return 0


if __name__ == "__main__":
    sys.exit(main())

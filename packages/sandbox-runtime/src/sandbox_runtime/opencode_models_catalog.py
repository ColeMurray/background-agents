"""OpenCode's model catalog, written before the process that reads it.

OpenCode resolves providers and models from ``models.json`` in its cache
directory when that file exists, and from the catalog compiled into its binary
when it does not. Its own download runs in the background and only reaches the
next process, so a fresh ``opencode serve`` never sees a model published after
the pinned release unless a newer file is already on disk. Image builds write
that file, and every sandbox started from the image resolves models as of the
build.

The installed OpenCode is the only judge of whether a catalog is usable: the
downloaded bytes are staged next to the cache file, loaded by ``opencode
models``, and only then renamed into place. The refresh is best-effort: any
failure leaves the existing file (or its absence) untouched, which is exactly
what OpenCode would have used anyway.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final

import httpx

from .log_config import configure_logging, get_logger

if TYPE_CHECKING:
    from collections.abc import Mapping

OPENCODE_MODELS_URL: Final = "https://models.opencode.ai/api.json"
FETCH_TIMEOUT_SECONDS: Final = 30.0
FETCH_CONNECT_RETRIES: Final = 2
VERIFY_TIMEOUT_SECONDS: Final = 60.0
_VERIFY_STDERR_TAIL_CHARS: Final = 500
#: The mode OpenCode's own catalog writes produce; ``mkstemp`` creates owner-only files.
CATALOG_FILE_MODE: Final = 0o644


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
        self,
        log: Any,
        *,
        url: str = OPENCODE_MODELS_URL,
        path: Path | None = None,
        opencode_command: str = "opencode",
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.log = log
        self.url = url
        self.path = path
        self.opencode_command = opencode_command
        self._transport = transport

    async def refresh(self) -> bool:
        """Replace the cached catalog with the published one. Only cancellation escapes."""
        override = catalog_override(os.environ)
        if override:
            self.log.info("opencode_models.refresh_skipped", reason=override)
            return False

        path = self.path or resolve_opencode_models_cache_path()
        staged: Path | None = None
        try:
            async with asyncio.timeout(FETCH_TIMEOUT_SECONDS):
                content = await self._fetch()
            path.parent.mkdir(parents=True, exist_ok=True)
            descriptor, staged_name = tempfile.mkstemp(
                dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
            )
            staged = Path(staged_name)
            os.fchmod(descriptor, CATALOG_FILE_MODE)
            with os.fdopen(descriptor, "wb") as staged_file:
                staged_file.write(content)
            await self._verify(staged)
            staged.replace(path)
        except Exception as error:
            if staged is not None:
                with contextlib.suppress(OSError):
                    staged.unlink(missing_ok=True)
            self.log.warn("opencode_models.refresh_failed", url=self.url, exc=error)
            return False
        self.log.info("opencode_models.refreshed", path=str(path), size_bytes=len(content))
        return True

    async def _fetch(self) -> bytes:
        transport = self._transport or httpx.AsyncHTTPTransport(retries=FETCH_CONNECT_RETRIES)
        async with httpx.AsyncClient(
            transport=transport, timeout=FETCH_TIMEOUT_SECONDS, follow_redirects=True
        ) as client:
            response = await client.get(self.url)
            response.raise_for_status()
        # OpenCode treats an unparseable catalog as absent rather than failing,
        # so the load check cannot catch one.
        if not isinstance(json.loads(response.content), dict):
            raise ValueError("catalog is not a JSON object")
        return response.content

    async def _verify(self, staged: Path) -> None:
        """Load the staged catalog with the installed OpenCode, in a throwaway home."""
        with tempfile.TemporaryDirectory(prefix="opencode-catalog-") as scratch:
            environment = {
                key: value for key, value in os.environ.items() if not key.startswith("OPENCODE_")
            }
            environment.update(
                {
                    "HOME": scratch,
                    "XDG_CONFIG_HOME": f"{scratch}/config",
                    "XDG_DATA_HOME": f"{scratch}/data",
                    "XDG_STATE_HOME": f"{scratch}/state",
                    "XDG_CACHE_HOME": f"{scratch}/cache",
                    "OPENCODE_MODELS_PATH": str(staged),
                    "OPENCODE_DISABLE_MODELS_FETCH": "1",
                }
            )
            process = await asyncio.create_subprocess_exec(
                self.opencode_command,
                "models",
                cwd=scratch,
                env=environment,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                async with asyncio.timeout(VERIFY_TIMEOUT_SECONDS):
                    _stdout, stderr = await process.communicate()
            finally:
                if process.returncode is None:
                    process.kill()
                    await process.wait()
        if process.returncode != 0:
            detail = stderr.decode(errors="replace").strip()[-_VERIFY_STDERR_TAIL_CHARS:]
            raise RuntimeError(
                f"opencode could not load the catalog (exit {process.returncode}): {detail}"
            )


def main() -> int:
    """Refresh the catalog for the current ``HOME``; image installation calls this."""
    configure_logging()
    catalog = OpenCodeModelsCatalog(get_logger("opencode_models"))
    asyncio.run(catalog.refresh())
    return 0


if __name__ == "__main__":
    sys.exit(main())

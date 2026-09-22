"""OpenCode's model catalog, written before the process that reads it.

OpenCode resolves providers and models from ``models.json`` in its cache
directory when that file exists, and from the catalog compiled into its binary
when it does not. Its own download runs in the background and only reaches the
next process, so a fresh ``opencode serve`` never sees a model published after
the pinned release unless a newer file is already on disk. Image builds write
that file, and every sandbox started from the image resolves models as of the
build.

The refresh is best-effort: any failure leaves the existing file (or its
absence) in place, which is exactly what OpenCode would have used anyway.
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Any, Final

import httpx

from .log_config import configure_logging, get_logger

OPENCODE_MODELS_URL: Final = "https://models.opencode.ai/api.json"
FETCH_TIMEOUT_SECONDS: Final = 30.0
FETCH_CONNECT_RETRIES: Final = 2

#: Environment that points OpenCode at a catalog other than the default cache
#: file, or turns its catalog download off. The operator owns the catalog then.
CATALOG_OVERRIDE_ENV_VARS: Final = (
    "OPENCODE_MODELS_PATH",
    "OPENCODE_MODELS_URL",
    "OPENCODE_DISABLE_MODELS_FETCH",
)


def resolve_opencode_models_cache_path() -> Path:
    """Resolve the catalog file OpenCode reads, using its xdg-basedir rules."""
    xdg = os.environ.get("XDG_CACHE_HOME")
    base = Path(xdg) if xdg else Path.home() / ".cache"
    return base / "opencode" / "models.json"


def is_models_catalog(payload: Any) -> bool:
    """Whether a decoded document has the shape of a provider-keyed catalog."""
    return (
        isinstance(payload, dict)
        and bool(payload)
        and all(
            isinstance(provider, dict) and isinstance(provider.get("models"), dict)
            for provider in payload.values()
        )
    )


class OpenCodeModelsCatalog:
    def __init__(
        self,
        log: Any,
        *,
        url: str = OPENCODE_MODELS_URL,
        path: Path | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.log = log
        self.url = url
        self.path = path
        self._transport = transport

    async def refresh(self) -> bool:
        """Replace the cached catalog with the published one. Never raises."""
        override = next((name for name in CATALOG_OVERRIDE_ENV_VARS if os.environ.get(name)), None)
        if override:
            self.log.info("opencode_models.refresh_skipped", reason=override)
            return False

        path = self.path or resolve_opencode_models_cache_path()
        temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        try:
            async with asyncio.timeout(FETCH_TIMEOUT_SECONDS):
                content = await self._fetch()
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary.write_bytes(content)
            temporary.replace(path)
        except Exception as error:
            temporary.unlink(missing_ok=True)
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
        if not is_models_catalog(response.json()):
            raise ValueError("response is not a models catalog")
        return response.content


def main() -> int:
    """Refresh the catalog for the current ``HOME``; image installation calls this."""
    configure_logging()
    catalog = OpenCodeModelsCatalog(get_logger("opencode_models"))
    asyncio.run(catalog.refresh())
    return 0


if __name__ == "__main__":
    sys.exit(main())

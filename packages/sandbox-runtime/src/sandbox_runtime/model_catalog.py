"""Persist the shared model catalog outside disposable sandbox caches."""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx

from .model_prices import DEFAULT_MODELS_URL, ModelPrice

if TYPE_CHECKING:
    from collections.abc import MutableMapping

MODEL_CATALOG_FETCH_TIMEOUT_SECONDS = 15.0


def configure_model_catalog(environ: MutableMapping[str, str]) -> Path:
    """Give OpenCode, its pricing plugin, and Codex the same persisted file."""
    if not environ.get("OPENCODE_MODELS_PATH"):
        home = Path(environ.get("HOME") or Path.home())
        environ["OPENCODE_MODELS_PATH"] = str(home / ".local/share/openinspect/models.json")
    return Path(environ["OPENCODE_MODELS_PATH"])


def validate_catalog(raw: bytes) -> None:
    """Reject catalogs without any usable, nonzero OpenAI prices."""
    catalog = json.loads(raw)
    provider = catalog.get("openai") if isinstance(catalog, dict) else None
    models = provider.get("models") if isinstance(provider, dict) else None
    if isinstance(models, dict):
        for model in models.values():
            price = ModelPrice.parse(model.get("cost")) if isinstance(model, dict) else None
            if price and (price.base.input > 0 or price.base.output > 0):
                return
    raise ValueError("Model catalog has no usable OpenAI prices")


def catalog_is_usable(path: Path) -> bool:
    """Check persisted prices without downloading or modifying anything."""
    try:
        validate_catalog(path.read_bytes())
    except (OSError, ValueError, RecursionError):
        return False
    return True


def _publish_catalog(path: Path, raw: bytes) -> None:
    """Readers see either the previous valid catalog or the complete replacement."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        dir=path.parent, prefix=f".{path.name}.", delete=False
    ) as file:
        temporary = Path(file.name)
        try:
            file.write(raw)
            file.flush()
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


async def ensure_model_catalog(
    environ: MutableMapping[str, str], log: Any, *, refresh: bool = False
) -> bool:
    """Fetch only when missing/invalid, or refreshing a build; keep valid old prices."""
    path = configure_model_catalog(environ)
    usable = catalog_is_usable(path)
    if usable and not refresh:
        return True
    source = environ.get("OPENCODE_MODELS_URL") or DEFAULT_MODELS_URL
    try:
        async with (
            asyncio.timeout(MODEL_CATALOG_FETCH_TIMEOUT_SECONDS),
            httpx.AsyncClient(timeout=MODEL_CATALOG_FETCH_TIMEOUT_SECONDS) as client,
        ):
            response = await client.get(f"{source.rstrip('/')}/api.json")
            response.raise_for_status()
            raw = response.content
            validate_catalog(raw)
            _publish_catalog(path, raw)
    except (
        httpx.HTTPError,
        httpx.InvalidURL,
        OSError,
        ValueError,
        RecursionError,
        TimeoutError,
    ) as error:
        log.warn("model_catalog.refresh_failed", path=str(path), exc=error)
        return usable
    log.info("model_catalog.refreshed", path=str(path))
    return True


def main() -> None:
    import argparse

    from .log_config import configure_logging, get_logger

    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--refresh", action="store_true")
    mode.add_argument("--check", action="store_true")
    args = parser.parse_args()
    configure_logging()
    path = configure_model_catalog(os.environ)
    usable = (
        asyncio.run(ensure_model_catalog(os.environ, get_logger("model_catalog"), refresh=True))
        if args.refresh
        else catalog_is_usable(path)
    )
    if not usable:
        raise SystemExit(f"Model price catalog unavailable: {path}")


if __name__ == "__main__":
    main()

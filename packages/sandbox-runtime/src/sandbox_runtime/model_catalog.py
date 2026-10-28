"""Persist the shared model catalog outside disposable sandbox caches."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import TYPE_CHECKING, Any, NoReturn

import httpx

from .durable_files import atomic_write_private
from .model_prices import DEFAULT_MODELS_URL, ModelPrice

if TYPE_CHECKING:
    from collections.abc import Iterator, MutableMapping

MODEL_CATALOG_FETCH_TIMEOUT_SECONDS = 15.0


def configure_model_catalog(environ: MutableMapping[str, str]) -> Path:
    """Give OpenCode, its pricing plugin, and Codex the same persisted file."""
    if not environ.get("OPENCODE_MODELS_PATH"):
        home = Path(environ.get("HOME") or Path.home())
        source = environ.get("OPENCODE_MODELS_URL") or DEFAULT_MODELS_URL
        filename = (
            "models.json"
            if source == DEFAULT_MODELS_URL
            else f"models-{hashlib.sha256(source.encode('utf-8')).hexdigest()}.json"
        )
        environ["OPENCODE_MODELS_PATH"] = str(home / ".local/share/openinspect" / filename)
    path = Path(environ["OPENCODE_MODELS_PATH"]).absolute()
    environ["OPENCODE_MODELS_PATH"] = str(path)
    return path


@contextmanager
def _suppress_catalog_request_logs() -> Iterator[None]:
    """HTTPX logs full URLs; suppress this fetch without muting concurrent requests."""
    active = ContextVar("catalog_request_logging", default=False)

    def allow_log(_record: logging.LogRecord) -> bool:
        return not active.get()

    logger = logging.getLogger("httpx")
    logger.addFilter(allow_log)
    token = active.set(True)
    try:
        yield
    finally:
        active.reset(token)
        logger.removeFilter(allow_log)


def _reject_json_constant(_value: str) -> NoReturn:
    raise ValueError("Model catalog contains a nonstandard JSON constant")


def validate_catalog(raw: bytes) -> str:
    """Require standard UTF-8 JSON with nonzero OpenAI prices; return the text."""
    text = raw.decode("utf-8")
    catalog = json.loads(text, parse_constant=_reject_json_constant)
    provider = catalog.get("openai") if isinstance(catalog, dict) else None
    models = provider.get("models") if isinstance(provider, dict) else None
    if isinstance(models, dict):
        for model in models.values():
            price = ModelPrice.parse(model.get("cost")) if isinstance(model, dict) else None
            if price and (price.base.input > 0 or price.base.output > 0):
                return text
    raise ValueError("Model catalog has no usable OpenAI prices")


def catalog_is_usable(path: Path) -> bool:
    """Check persisted prices without downloading or modifying anything."""
    try:
        validate_catalog(path.read_bytes())
    except (OSError, ValueError, RecursionError):
        return False
    return True


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
        with _suppress_catalog_request_logs():
            async with (
                asyncio.timeout(MODEL_CATALOG_FETCH_TIMEOUT_SECONDS),
                httpx.AsyncClient(
                    timeout=MODEL_CATALOG_FETCH_TIMEOUT_SECONDS, follow_redirects=True
                ) as client,
            ):
                response = await client.get(f"{source.rstrip('/')}/api.json")
                response.raise_for_status()
                text = validate_catalog(response.content)
                atomic_write_private(path, text)
    except (
        httpx.HTTPError,
        httpx.InvalidURL,
        OSError,
        ValueError,
        RecursionError,
        TimeoutError,
    ) as error:
        log.warn(
            "model_catalog.refresh_failed",
            path=str(path),
            error_type=type(error).__name__,
            status_code=error.response.status_code
            if isinstance(error, httpx.HTTPStatusError)
            else None,
        )
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

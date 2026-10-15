"""Catalog-backed model-price equivalents, not ChatGPT subscription charges."""

from __future__ import annotations

import asyncio
import json
import math
import tempfile
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypeGuard

import httpx

if TYPE_CHECKING:
    from collections.abc import Mapping

DEFAULT_MODELS_URL = "https://models.opencode.ai"
CATALOG_TTL_SECONDS = 3600
CATALOG_TIMEOUT_SECONDS = 5
MAX_CATALOG_BYTES = 16 * 1024 * 1024


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"Invalid JSON number: {value}")


def _catalog_models(data: bytes) -> dict[str, Any]:
    catalog = json.loads(data, parse_constant=_reject_json_constant)
    provider = catalog.get("openai") if isinstance(catalog, dict) else None
    models = provider.get("models") if isinstance(provider, dict) else None
    if not isinstance(models, dict) or not all(isinstance(m, dict) for m in models.values()):
        raise ValueError("OpenAI models missing or malformed in catalog")
    return models


def _persist_catalog(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(data)
            stream.close()
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


async def load_codex_pricing(environ: Mapping[str, str], log: Any) -> dict[str, Any]:
    """Load an independent raw OpenAI-model snapshot for one turn.

    Explicit files are authoritative and never trigger network access. Only the
    default OpenCode cache is refreshed; a failed refresh retains its stale data.
    Catalog validation checks structure; individual rates are checked at pricing.
    """
    explicit_path = environ.get("OPENCODE_MODELS_PATH")
    source = environ.get("OPENCODE_MODELS_URL") or DEFAULT_MODELS_URL
    if not explicit_path and source != DEFAULT_MODELS_URL:
        log.warn(
            "codex.pricing.custom_catalog_path_required",
            reason="Set OPENCODE_MODELS_PATH for a custom catalog",
        )
        return {}
    if explicit_path:
        path = Path(explicit_path)
    else:
        cache_home = Path(
            environ.get("XDG_CACHE_HOME") or Path(environ.get("HOME") or Path.home()) / ".cache"
        )
        path = cache_home / "opencode" / "models.json"
    models: dict[str, Any] = {}
    try:
        with path.open("rb") as stream:
            data = stream.read(MAX_CATALOG_BYTES + 1)
        if len(data) > MAX_CATALOG_BYTES:
            raise ValueError("Model catalog exceeds size limit")
        models = _catalog_models(data)
        if explicit_path or time.time() - path.stat().st_mtime < CATALOG_TTL_SECONDS:
            return models
    except (OSError, ValueError, RecursionError) as error:
        log.warn("codex.pricing.cache_unavailable", exc=error)
    if explicit_path:
        return models

    try:
        async with asyncio.timeout(CATALOG_TIMEOUT_SECONDS):
            async with (
                httpx.AsyncClient(timeout=CATALOG_TIMEOUT_SECONDS) as client,
                client.stream("GET", f"{DEFAULT_MODELS_URL}/api.json") as response,
            ):
                response.raise_for_status()
                payload = bytearray()
                async for chunk in response.aiter_bytes(chunk_size=64 * 1024):
                    if len(payload) + len(chunk) > MAX_CATALOG_BYTES:
                        raise ValueError("Model catalog exceeds size limit")
                    payload.extend(chunk)
        data = bytes(payload)
        refreshed = _catalog_models(data)
    except (httpx.HTTPError, TimeoutError, ValueError, RecursionError) as error:
        log.warn("codex.pricing.refresh_failed", exc=error)
        return models
    try:
        _persist_catalog(path, data)
    except OSError as error:
        log.warn("codex.pricing.cache_write_failed", exc=error)
    return refreshed


def _valid_rate(value: Any) -> TypeGuard[int | float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value) and value >= 0
    except OverflowError:
        return False


def price_codex_usage(model: dict[str, Any] | None, counts: dict[str, int]) -> float | None:
    """Price standard-mode native usage in USD, or return None when unknown.

    Input/output totals are required; omitted cache/reasoning details mean zero.
    Input includes both disjoint cache buckets; output already includes reasoning.
    """
    input_tokens = counts.get("inputTokens")
    output_tokens = counts.get("outputTokens")
    cached_tokens = counts.get("cachedInputTokens", 0)
    written_tokens = counts.get("cacheWriteInputTokens", 0)
    reasoning_tokens = counts.get("reasoningOutputTokens", 0)
    if not all(
        isinstance(value, int) and not isinstance(value, bool) and value >= 0
        for value in (input_tokens, output_tokens, cached_tokens, written_tokens, reasoning_tokens)
    ):
        return None
    assert input_tokens is not None and output_tokens is not None
    if cached_tokens + written_tokens > input_tokens or reasoning_tokens > output_tokens:
        return None
    if input_tokens == 0 and output_tokens == 0:
        return 0.0
    cost = model.get("cost") if isinstance(model, dict) else None
    if not isinstance(cost, dict):
        return None
    tiers = cost.get("tiers", [])
    if not isinstance(tiers, list) or ("context_over_200k" in cost and not tiers):
        return None
    selected = cost
    selected_threshold: int | float = -1
    thresholds: set[int | float] = set()
    for index, rates in enumerate([cost, *tiers]):
        if not isinstance(rates, dict):
            return None
        if not _valid_rate(rates.get("input")) or not _valid_rate(rates.get("output")):
            return None
        for name, count in (("cache_read", cached_tokens), ("cache_write", written_tokens)):
            if name in rates:
                if not _valid_rate(rates[name]):
                    return None
            elif count:
                return None
        if index:
            tier = rates.get("tier")
            if not isinstance(tier, dict) or tier.get("type") != "context":
                return None
            threshold = tier.get("size")
            if not _valid_rate(threshold) or threshold in thresholds:
                return None
            thresholds.add(threshold)
            if selected_threshold < threshold < input_tokens:
                selected, selected_threshold = rates, threshold
    try:
        total = sum(
            count / 1_000_000 * selected.get(rate, 0)
            for count, rate in (
                (input_tokens - cached_tokens - written_tokens, "input"),
                (cached_tokens, "cache_read"),
                (written_tokens, "cache_write"),
                (output_tokens, "output"),
            )
        )
        return float(total) if math.isfinite(total) else None
    except OverflowError:
        return None

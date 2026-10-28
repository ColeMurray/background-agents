"""Model prices and explicit context tiers from the shared models.dev catalog.

``model_catalog`` publishes the persisted catalog and sets ``OPENCODE_MODELS_PATH``;
``plugins/codex-auth-plugin.js`` reads the same file. Prices are model-price
equivalents: under a ChatGPT subscription they describe usage, not a charge.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Mapping

#: OpenCode's default catalog source; only that source is cached at the default path.
DEFAULT_MODELS_URL = "https://models.opencode.ai"
TOKENS_PER_MILLION = Decimal(1_000_000)
#: USD per million tokens; larger catalog values are malformed. Token counts are
#: capped at 2**53, so any turn priced within this bound has a finite float cost.
MAX_RATE_USD_PER_MILLION_TOKENS = Decimal("1e200")


def _rate(value: Any) -> Decimal | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    try:
        if not math.isfinite(value) or value < 0:
            return None
    except OverflowError:  # An integer too large for a float.
        return None
    # str() avoids importing binary floating-point artifacts into Decimal.
    rate = Decimal(str(value))
    return rate if rate <= MAX_RATE_USD_PER_MILLION_TOKENS else None


@dataclass(frozen=True)
class Rates:
    """USD per million tokens."""

    input: Decimal
    output: Decimal
    cache_read: Decimal
    cache_write: Decimal

    @classmethod
    def parse(cls, raw: Any) -> Rates | None:
        if not isinstance(raw, dict):
            return None
        input_rate, output_rate = _rate(raw.get("input")), _rate(raw.get("output"))
        if input_rate is None or output_rate is None:
            return None
        return cls(
            input=input_rate,
            output=output_rate,
            cache_read=_rate(raw.get("cache_read")) or Decimal(0),
            cache_write=_rate(raw.get("cache_write")) or Decimal(0),
        )


@dataclass(frozen=True)
class TokenBuckets:
    """Disjoint token counts for one model request."""

    input: int
    output: int
    reasoning: int
    cache_read: int
    cache_write: int


@dataclass(frozen=True)
class ModelPrice:
    base: Rates
    context_tiers: tuple[tuple[Decimal, Rates], ...] = ()

    @classmethod
    def parse(cls, raw: Any) -> ModelPrice | None:
        """Convert a catalog ``cost`` entry; ``None`` when it has no usable base price."""
        base = Rates.parse(raw)
        if base is None:
            return None
        tiers: list[tuple[Decimal, Rates]] = []
        raw_tiers = raw.get("tiers")
        for entry in raw_tiers if isinstance(raw_tiers, list) else ():
            tier = entry.get("tier") if isinstance(entry, dict) else None
            if not isinstance(tier, dict) or tier.get("type") != "context":
                continue
            rates, size = Rates.parse(entry), _rate(tier.get("size"))
            if rates is not None and size is not None:
                tiers.append((size, rates))
        return cls(base=base, context_tiers=tuple(tiers))

    def rates_for(self, context_tokens: int) -> Rates:
        """Use the largest exceeded catalog tier, otherwise the base rates."""
        exceeded = [tier for tier in self.context_tiers if context_tokens > tier[0]]
        if exceeded:
            return max(exceeded, key=lambda tier: tier[0])[1]
        return self.base

    def cost(self, tokens: TokenBuckets, context_tokens: int) -> Decimal:
        """USD for one request; ``context_tokens`` is its total input, cache included."""
        rates = self.rates_for(context_tokens)
        # Reasoning is priced at the output rate.
        total = (
            tokens.input * rates.input
            + tokens.output * rates.output
            + tokens.reasoning * rates.output
            + tokens.cache_read * rates.cache_read
            + tokens.cache_write * rates.cache_write
        ) / TOKENS_PER_MILLION
        return max(total, Decimal(0))


def default_catalog_path(environ: Mapping[str, str]) -> Path | None:
    """Where OpenCode caches the catalog; ``None`` for an uncached custom source."""
    if environ.get("OPENCODE_MODELS_PATH"):
        return Path(environ["OPENCODE_MODELS_PATH"])
    # An empty value selects the default source, as in OpenCode and the plugin.
    if (environ.get("OPENCODE_MODELS_URL") or DEFAULT_MODELS_URL) != DEFAULT_MODELS_URL:
        return None
    cache_home = environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(cache_home) / "opencode" / "models.json"


class ModelPriceCatalog:
    """OpenAI model prices from the cached catalog, reloaded when the file changes."""

    def __init__(self, path: Path | None, log: Any) -> None:
        self._path = path
        self._log = log
        self._signature: tuple[int, int] | None = None
        self._models: dict[str, Any] | None = None
        self._failure: str | None = None

    @property
    def available(self) -> bool:
        self._refresh()
        return self._models is not None

    def price(self, model_id: str) -> ModelPrice | None:
        self._refresh()
        entry = (self._models or {}).get(model_id)
        return ModelPrice.parse(entry.get("cost")) if isinstance(entry, dict) else None

    def _refresh(self) -> None:
        if self._path is None:
            self._unavailable("custom catalog source has no cache path")
            return
        try:
            stat = self._path.stat()
        except OSError:
            self._signature = None
            self._unavailable("catalog file missing")
            return
        signature = (stat.st_mtime_ns, stat.st_size)
        if signature == self._signature:
            return
        try:
            raw = self._path.read_bytes()
            # Retry failed reads even when the file's contents have not changed.
            self._signature = signature
            models = json.loads(raw)["openai"]["models"]
            if not isinstance(models, dict):
                raise TypeError("openai.models is not an object")
        except Exception as error:  # A bad catalog must never fail a turn.
            self._unavailable(f"catalog unreadable: {type(error).__name__}")
            return
        self._models, self._failure = models, None
        self._log.info(
            "model_prices.loaded",
            path=str(self._path),
            sha256=hashlib.sha256(raw).hexdigest(),
            models=len(models),
        )

    def _unavailable(self, reason: str) -> None:
        self._models = None
        if reason != self._failure:
            self._failure = reason
            self._log.warn("model_prices.unavailable", path=str(self._path), reason=reason)

"""Per-prompt spending limits, separate from the sandbox's snapshot deadline."""

from __future__ import annotations

import math
import os
from dataclasses import dataclass, field
from typing import Any

DEFAULT_MAX_PROMPT_TURNS = 80
DEFAULT_MAX_PROMPT_TOKENS = 6_000_000
DEFAULT_MAX_PROMPT_COST_USD = 0.0


def _env_limit(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, str(default)))
    except ValueError:
        return default
    return value if math.isfinite(value) and value >= 0 else default


@dataclass(frozen=True)
class PromptLimits:
    turns: int = DEFAULT_MAX_PROMPT_TURNS
    tokens: int = DEFAULT_MAX_PROMPT_TOKENS
    cost_usd: float = DEFAULT_MAX_PROMPT_COST_USD

    @classmethod
    def from_env(cls) -> PromptLimits:
        return cls(
            turns=int(_env_limit("BRIDGE_MAX_PROMPT_TURNS", DEFAULT_MAX_PROMPT_TURNS)),
            tokens=int(_env_limit("BRIDGE_MAX_PROMPT_TOKENS", DEFAULT_MAX_PROMPT_TOKENS)),
            cost_usd=_env_limit("BRIDGE_MAX_PROMPT_COST_USD", DEFAULT_MAX_PROMPT_COST_USD),
        )


def _nonnegative_number(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return float(value) if math.isfinite(value) and value >= 0 else 0


class PromptBudgetExceeded(Exception):
    """A completed authorized step reached a configured spending limit."""


@dataclass
class PromptBudget:
    limits: PromptLimits
    turns: int = 0
    tokens: int = 0
    cost_usd: float = 0.0
    seen: set[tuple[str, str]] = field(default_factory=set)

    def record(self, part: dict[str, Any]) -> None:
        # Called only after parent/child attribution accepts the part. An unrelated
        # session on the same SSE connection cannot spend this prompt's budget.
        key = (str(part.get("sessionID", "")), str(part.get("id", "")))
        if not key[1] or key in self.seen:
            return
        self.seen.add(key)
        self.turns += 1
        tokens = part.get("tokens")
        if isinstance(tokens, dict):
            self.tokens += sum(
                int(_nonnegative_number(tokens.get(name)))
                for name in ("input", "output", "reasoning")
            )
        self.cost_usd += _nonnegative_number(part.get("cost"))
        for name, used, limit in (
            ("turns", self.turns, self.limits.turns),
            ("tokens", self.tokens, self.limits.tokens),
            ("cost_usd", self.cost_usd, self.limits.cost_usd),
        ):
            if limit and used >= limit:
                raise PromptBudgetExceeded(name)

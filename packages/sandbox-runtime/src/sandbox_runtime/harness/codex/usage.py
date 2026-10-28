"""Token usage and priced cost of the native threads that serve one prompt.

Each thread (the prompt's own, and each sub-agent's) reports cumulative usage
and is reduced by its own ``CodexUsage``. Every request is priced on its own
and charged to the prompt's shared ``PromptCost``, which every step reports.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from ...model_prices import ModelPrice, TokenBuckets

TOKEN_FIELDS = (
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
)
MAX_SAFE_TOKEN_COUNT = 2**53 - 1
UNATTRIBUTED_USAGE_WARNING = (
    "Some of this turn's Codex usage could not be separated from earlier work in this "
    "conversation, so it is not included in the turn's cost."
)
COMBINED_USAGE_WARNING = (
    "Codex did not report this turn's usage one request at a time, so this turn's cost is "
    "an estimate."
)
REROUTED_MODEL_WARNING = (
    "Codex switched models during this turn, so this turn's cost is an estimate at the "
    "requested model's prices."
)
INCONSISTENT_USAGE_WARNING = (
    "Codex reported inconsistent token usage, so this turn's cost covers only the usage "
    "reported before it."
)


def _zero() -> dict[str, int]:
    return dict.fromkeys(TOKEN_FIELDS, 0)


def _token_counts(value: Any) -> dict[str, int] | None:
    if not isinstance(value, dict):
        return None
    # Cache writes are optional in the pinned protocol; the other cumulative
    # fields must be present. Missing usage must not invent token counts.
    counts: dict[str, int] = {}
    for key in TOKEN_FIELDS:
        count = value.get(key, 0 if key == "cacheWriteInputTokens" else None)
        if type(count) is not int or not 0 <= count <= MAX_SAFE_TOKEN_COUNT:
            return None
        counts[key] = count
    if (
        counts["cachedInputTokens"] + counts["cacheWriteInputTokens"] > counts["inputTokens"]
        or counts["reasoningOutputTokens"] > counts["outputTokens"]
        or counts["totalTokens"] != counts["inputTokens"] + counts["outputTokens"]
    ):
        return None
    return counts


def _buckets(counts: dict[str, int]) -> TokenBuckets:
    # Native input includes cached reads and writes, native output includes
    # reasoning. Neutral buckets are disjoint.
    read, write = counts["cachedInputTokens"], counts["cacheWriteInputTokens"]
    reasoning = counts["reasoningOutputTokens"]
    return TokenBuckets(
        input=max(0, counts["inputTokens"] - read - write),
        output=max(0, counts["outputTokens"] - reasoning),
        reasoning=reasoning,
        cache_read=read,
        cache_write=write,
    )


class PromptCost:
    """The requested model's price and the priced cost of every request a prompt ran."""

    def __init__(self, price: ModelPrice | None, unpriced_warning: str | None) -> None:
        self.price = price
        # Why usage goes unpriced without a price; worded by the catalog's owner.
        self.unpriced_warning = unpriced_warning
        self._usd = Decimal(0)

    @property
    def usd(self) -> float:
        return float(self._usd)

    def charge(self, request: dict[str, int]) -> Decimal:
        """Price one request; context-tier rates depend on that request's input size."""
        if self.price is None:
            return Decimal(0)
        cost = self.price.cost(_buckets(request), request["inputTokens"])
        self._usd += cost
        return cost


class CodexUsage:
    """One native thread's usage within a prompt, from its cumulative reports."""

    def __init__(
        self,
        prompt_cost: PromptCost,
        model: str,
        baseline: dict[str, int] | None = None,
        *,
        baseline_known: bool = True,
    ) -> None:
        self.prompt_cost = prompt_cost
        # The model whose price is charged.
        self.model = model
        normalized_baseline = _token_counts(baseline if baseline else _zero())
        # The last accepted cumulative native total.
        self.total = normalized_baseline or _zero()
        # An untrusted checkpoint may lag native history this prompt must not be
        # charged for; the first total observed replaces it.
        self._checkpoint_trusted = baseline_known and normalized_baseline is not None
        # This thread's usage: the sum of the increments accepted so far.
        self._usage = _zero()
        self._cost = Decimal(0)
        # Reporting facts only; neither stops later increments from counting.
        self.attribution_complete = True
        self.requests_separable = True
        # False once the thread ran another model: prices are for the requested one.
        self.model_priced = True
        self.valid = True
        self.has_usage = False
        self.tokens: dict[str, Any] | None = None

    @property
    def step_cost_usd(self) -> float | None:
        """This thread's priced cost; ``None`` unless every request could be priced."""
        complete = (
            self.prompt_cost.price is not None
            and self.valid
            and self.attribution_complete
            and self.requests_separable
            and self.model_priced
        )
        return float(self._cost) if complete else None

    def ran(self, model: str) -> list[str]:
        """Record the model the thread actually ran; returns warnings to report."""
        if model == self.model or self.prompt_cost.price is None:
            return []
        # Pricing is never resolved while native work runs.
        self.model_priced = False
        return [REROUTED_MODEL_WARNING]

    def update(self, usage: Any) -> list[str]:
        """Fold one cumulative native report into this thread's usage; returns warnings."""
        total = _token_counts(usage.get("total") if isinstance(usage, dict) else None)
        if not self.valid or total is None or any(total[k] < self.total[k] for k in TOKEN_FIELDS):
            return self._invalidate()
        advance = {k: total[k] - self.total[k] for k in TOKEN_FIELDS}
        # Codex sends one update per model request; `last` is that request.
        reported_last = usage.get("last") if isinstance(usage, dict) else None
        last = _token_counts(reported_last)
        increment: dict[str, int] | None = advance
        warnings: list[str] = []
        if not any(advance.values()):
            pass  # A repeated report adds nothing.
        elif not self._checkpoint_trusted:
            # A contained cancellation can leave native history ahead of the
            # checkpoint, so only the request this update reports is attributed.
            if last is not None and all(last[k] <= advance[k] for k in TOKEN_FIELDS):
                increment = last
            else:
                increment = None
                self.attribution_complete = False
                warnings.append(UNATTRIBUTED_USAGE_WARNING)
        elif _token_counts(advance) is None:
            # Valid cumulative totals can still yield an inconsistent request.
            return self._invalidate()
        elif reported_last is not None and last != advance:
            # Several requests arrived together, or the reported request is
            # malformed (unlike an absent one). Pricing the advance as one selects the
            # highest tier any of them could need, so a limit is never reached
            # late, but the cost is then an estimate.
            self.requests_separable = False
            warnings.append(COMBINED_USAGE_WARNING)
        self.total = total
        self._checkpoint_trusted = True
        self.has_usage = True
        if increment is not None:
            self._add(increment)
        if self.prompt_cost.price is None and any(advance.values()):
            if self.prompt_cost.unpriced_warning:
                warnings.append(self.prompt_cost.unpriced_warning)
        return warnings

    def _add(self, increment: dict[str, int]) -> None:
        self._usage = {k: self._usage[k] + increment[k] for k in TOKEN_FIELDS}
        self._cost += self.prompt_cost.charge(increment)
        buckets = _buckets(self._usage)
        self.tokens = {
            "input": buckets.input,
            "output": buckets.output,
            "reasoning": buckets.reasoning,
            "cache": {"read": buckets.cache_read, "write": buckets.cache_write},
            "total": self._usage["totalTokens"],
        }

    def _invalidate(self) -> list[str]:
        self.valid = False
        self.has_usage = False
        self.tokens = None
        return [INCONSISTENT_USAGE_WARNING]

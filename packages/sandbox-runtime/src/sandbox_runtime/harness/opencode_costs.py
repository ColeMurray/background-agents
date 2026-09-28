"""Separate OpenCode's managed OAuth price equivalents from budgeted spend."""

from __future__ import annotations

import math
from dataclasses import dataclass, field


@dataclass(frozen=True)
class PricedStep:
    cost: float
    estimated: bool


@dataclass
class StepCostAccumulator:
    """Keep corrected step values and a monotonic estimate report revision."""

    providers: dict[str, str] = field(default_factory=dict)
    steps: dict[str, PricedStep] = field(default_factory=dict)
    estimate_revision: int = 0

    def note_provider(self, message_id: str, provider_id: object) -> None:
        if isinstance(provider_id, str):
            self.providers[message_id] = provider_id

    def record_step(
        self,
        step_id: str,
        message_id: str,
        cost: object,
        *,
        openai_oauth_managed: bool,
    ) -> PricedStep | None:
        if (
            isinstance(cost, bool)
            or not isinstance(cost, int | float)
            or not math.isfinite(cost)
            or cost < 0
        ):
            return None

        step = PricedStep(
            cost=float(cost),
            estimated=openai_oauth_managed and self.providers.get(message_id) == "openai",
        )
        previous = self.steps.get(step_id)
        if previous != step:
            self.steps[step_id] = step
            if step.estimated or (previous is not None and previous.estimated):
                self.estimate_revision += 1
        return step

    def budgeted_total(self) -> float:
        return sum(step.cost for step in self.steps.values() if not step.estimated)

    def estimated_total(self) -> float:
        return sum(step.cost for step in self.steps.values() if step.estimated)

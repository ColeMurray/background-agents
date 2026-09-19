"""Per-prompt time budgets, resolved from the sandbox environment.

The sandbox has a wall-clock lifetime (``SANDBOX_TIMEOUT_SECONDS``). A share
of it is reserved so a snapshot can still be taken after the last turn; what
is left is the most one prompt may spend. The inactivity budget is a separate
liveness check on a harness that stopped talking, overridable within bounds
for a session that needs a longer or shorter one.
"""

from __future__ import annotations

import math
import os
from typing import TYPE_CHECKING

from .constants import (
    DEFAULT_SANDBOX_TIMEOUT_SECONDS,
    MAX_SNAPSHOT_RESERVE_SECONDS,
    SANDBOX_TIMEOUT_ENV_VAR,
    SNAPSHOT_RESERVE_FRACTION,
)
from .harness import HarnessId, PromptLimits
from .harness.claude_env import stream_silence_budget_seconds

if TYPE_CHECKING:
    from .log_config import StructuredLogger

SSE_INACTIVITY_TIMEOUT_ENV_VAR = "BRIDGE_SSE_INACTIVITY_TIMEOUT"
# Liveness check for a harness that stopped talking, not a budget for how long
# the model may think. Stays under the control plane's own inactivity watchdog
# (SANDBOX_INACTIVITY_TIMEOUT_MS) so the bridge owns the outcome.
#
# What counts as talking is the harness's, so the budget is too. OpenCode
# merges a periodic ``server.heartbeat`` into the same SSE stream and the
# budget renews on any traffic, so silence there means the transport died and
# no tool call, however long, can trip it.
OPENCODE_INACTIVITY_TIMEOUT_SECONDS = 300.0
INACTIVITY_TIMEOUT_MIN_SECONDS = 5.0
INACTIVITY_TIMEOUT_MAX_SECONDS = 3600.0


def _inactivity_bounds(harness: HarnessId) -> tuple[float, float, float | None]:
    """Default, floor and ceiling for this harness's silence budget.

    The Claude SDK has no heartbeat and renews the budget only on a message,
    of which it sends none for the length of a tool call. Its budget is the
    one the Claude harness resolves from the environment the child itself
    reads, so the two cannot disagree: a child configured for longer tool
    calls carries the budget up with it. A session may raise that budget, but
    not cut it below what its own child can legitimately take.

    Raising it has no ceiling of its own: the prompt deadline already bounds
    any silence, and a fixed cap here would pin the budget to its floor for a
    child whose tool calls can outlast that cap.
    """
    if harness is not HarnessId.CLAUDE:
        return (
            OPENCODE_INACTIVITY_TIMEOUT_SECONDS,
            INACTIVITY_TIMEOUT_MIN_SECONDS,
            INACTIVITY_TIMEOUT_MAX_SECONDS,
        )
    budget = stream_silence_budget_seconds()
    return budget, budget, None


def resolve_prompt_limits(log: StructuredLogger, harness: HarnessId) -> PromptLimits:
    """The budgets one prompt runs under, with every resolution step logged."""
    default_seconds, min_seconds, max_seconds = _inactivity_bounds(harness)
    inactivity_timeout_seconds = _resolve_bounded_seconds(
        log,
        name=SSE_INACTIVITY_TIMEOUT_ENV_VAR,
        default=default_seconds,
        min_value=min_seconds,
        max_value=max_seconds,
    )
    sandbox_timeout_seconds = _resolve_positive_seconds(
        log, name=SANDBOX_TIMEOUT_ENV_VAR, default=DEFAULT_SANDBOX_TIMEOUT_SECONDS
    )
    snapshot_reserve_seconds = min(
        MAX_SNAPSHOT_RESERVE_SECONDS,
        sandbox_timeout_seconds * SNAPSHOT_RESERVE_FRACTION,
    )
    limits = PromptLimits(
        inactivity_timeout_seconds=inactivity_timeout_seconds,
        prompt_max_duration_seconds=sandbox_timeout_seconds - snapshot_reserve_seconds,
        prompt_cleanup_timeout_seconds=snapshot_reserve_seconds,
    )
    log.info(
        "bridge.prompt_timeout_config",
        timeout_ms=int(limits.prompt_max_duration_seconds * 1000),
        sandbox_timeout_ms=int(sandbox_timeout_seconds * 1000),
        snapshot_reserve_ms=int(snapshot_reserve_seconds * 1000),
    )
    return limits


def _resolve_bounded_seconds(
    log: StructuredLogger,
    *,
    name: str,
    default: float,
    min_value: float,
    max_value: float | None,
) -> float:
    """Resolve ``name`` within its bounds; ``max_value`` of ``None`` is unbounded."""
    raw = os.environ.get(name)
    if raw is None or raw == "":
        value = default
    else:
        try:
            value = float(raw)
            # A non-finite value passes every clamp comparison below and then
            # cannot be logged or turned into a timeout at all.
            if not math.isfinite(value):
                raise ValueError
        except ValueError:
            log.warn(
                "bridge.timeout_invalid",
                timeout_name=name,
                timeout_ms=int(default * 1000),
                detail=f"invalid value '{raw}', using default",
            )
            value = default

    if value < min_value:
        log.warn(
            "bridge.timeout_clamped",
            timeout_name=name,
            timeout_ms=int(min_value * 1000),
            detail=f"below min ({min_value}s), clamped",
        )
        value = min_value
    elif max_value is not None and value > max_value:
        log.warn(
            "bridge.timeout_clamped",
            timeout_name=name,
            timeout_ms=int(max_value * 1000),
            detail=f"above max ({max_value}s), clamped",
        )
        value = max_value

    log.info(
        "bridge.timeout_config",
        timeout_name=name,
        timeout_ms=int(value * 1000),
        min_ms=int(min_value * 1000),
        max_ms=int(max_value * 1000) if max_value is not None else None,
    )
    return value


def _resolve_positive_seconds(log: StructuredLogger, *, name: str, default: float) -> float:
    raw = os.environ.get(name)
    try:
        value = default if raw is None or raw == "" else float(raw)
        if not math.isfinite(value) or value <= 0:
            raise ValueError
    except ValueError:
        log.warn(
            "bridge.timeout_invalid",
            timeout_name=name,
            timeout_ms=int(default * 1000),
            detail=f"invalid value '{raw}', using default",
        )
        value = default

    log.info("bridge.timeout_config", timeout_name=name, timeout_ms=int(value * 1000))
    return value

"""Per-prompt time budgets, resolved from the sandbox environment.

The sandbox has a wall-clock lifetime (``SANDBOX_TIMEOUT_SECONDS``). A share
of it is reserved so a snapshot can still be taken after the last turn; what
is left is the most one prompt may spend. The SSE inactivity budget is a
separate liveness check on a harness that stopped talking, overridable within
bounds for a session that needs a longer or shorter one.
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
from .harness import PromptLimits

if TYPE_CHECKING:
    from .log_config import StructuredLogger

SSE_INACTIVITY_TIMEOUT_ENV_VAR = "BRIDGE_SSE_INACTIVITY_TIMEOUT"
# Liveness check for a harness that stopped talking, not a budget for how
# long the model may think. Stays under the control plane's own inactivity
# watchdog (SANDBOX_INACTIVITY_TIMEOUT_MS) so the bridge owns the outcome.
SSE_INACTIVITY_TIMEOUT = 300.0
SSE_INACTIVITY_TIMEOUT_MIN = 5.0
SSE_INACTIVITY_TIMEOUT_MAX = 3600.0


def resolve_prompt_limits(log: StructuredLogger) -> PromptLimits:
    """The budgets one prompt runs under, with every resolution step logged."""
    inactivity_timeout_seconds = _resolve_bounded_seconds(
        log,
        name=SSE_INACTIVITY_TIMEOUT_ENV_VAR,
        default=SSE_INACTIVITY_TIMEOUT,
        min_value=SSE_INACTIVITY_TIMEOUT_MIN,
        max_value=SSE_INACTIVITY_TIMEOUT_MAX,
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
    max_value: float,
) -> float:
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
    elif value > max_value:
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
        max_ms=int(max_value * 1000),
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

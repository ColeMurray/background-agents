"""Agent harness seam: one registry, two halves (see ``base.py``)."""

from __future__ import annotations

from typing import TYPE_CHECKING

from .base import (
    DEFAULT_HARNESS_ID,
    DETERMINISTIC_FAILURE_EXIT_CODE,
    AgentHarness,
    BridgeEvent,
    EventSink,
    HarnessId,
    HarnessProcessOwner,
    HarnessPrompt,
    HarnessStartError,
    PromptLimits,
    TurnOutcome,
    parse_harness_id,
)
from .opencode import OpencodeHarness
from .opencode_client import OpenCodeClient

if TYPE_CHECKING:
    from ..attachment_processor import AttachmentProcessor
    from ..log_config import StructuredLogger


def build_agent_harness(
    harness_id: HarnessId,
    *,
    attachment_processor: AttachmentProcessor,
    log: StructuredLogger,
    limits: PromptLimits,
    opencode_port: int,
) -> AgentHarness:
    """The bridge-half registry: one ``match`` is the whole thing."""
    match harness_id:
        case HarnessId.OPENCODE:
            return OpencodeHarness(
                client=OpenCodeClient(base_url=f"http://localhost:{opencode_port}", log=log),
                attachment_processor=attachment_processor,
                log=log,
                limits=limits,
            )
    raise ValueError(f"Unsupported harness: {harness_id}")


__all__ = [
    "DEFAULT_HARNESS_ID",
    "DETERMINISTIC_FAILURE_EXIT_CODE",
    "AgentHarness",
    "BridgeEvent",
    "EventSink",
    "HarnessId",
    "HarnessProcessOwner",
    "HarnessPrompt",
    "HarnessStartError",
    "PromptLimits",
    "TurnOutcome",
    "build_agent_harness",
    "parse_harness_id",
]

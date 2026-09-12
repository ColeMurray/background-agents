"""Agent harness seam: one registry, two halves (see ``base.py``)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import TYPE_CHECKING

from ..claude_stager import ClaudeHarnessHandoff
from ..credentials.provider_credential_client import RuntimeCredentialClient
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
from .claude import ClaudeHarness, ClaudeHarnessConfig
from .claude_env import OAUTH_MANAGED_ENV_VAR
from .claude_tools import ToolServerConfig
from .opencode import OpencodeHarness
from .opencode_client import OpenCodeClient

if TYPE_CHECKING:
    from pathlib import Path

    from ..attachment_processor import AttachmentProcessor
    from ..log_config import StructuredLogger


@dataclass(frozen=True)
class BridgeIdentity:
    """What a harness needs to call the control plane on the session's behalf."""

    sandbox_id: str
    session_id: str
    control_plane_url: str
    auth_token: str
    repo_manifest_path: Path


def build_agent_harness(
    harness_id: HarnessId,
    *,
    identity: BridgeIdentity,
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
        case HarnessId.CLAUDE:
            handoff = ClaudeHarnessHandoff.read()
            session_config = _session_config_from_env()
            oauth_managed = bool(os.environ.get(OAUTH_MANAGED_ENV_VAR))
            config = ClaudeHarnessConfig(
                workdir=handoff.workdir,
                config_dir=handoff.config_dir,
                # From the bridge's own SESSION_CONFIG: MCP entries can carry
                # credentials, and the handoff file never does.
                mcp_servers=_mcp_servers_from(session_config),
                default_model=str(session_config.get("model") or "claude-sonnet-4-6"),
                oauth_managed=oauth_managed,
                system_prompt_append=_repository_guidance(handoff.workdir),
                tools=ToolServerConfig(
                    control_plane_url=identity.control_plane_url,
                    session_id=identity.session_id,
                    auth_token=identity.auth_token,
                    repo_manifest_path=identity.repo_manifest_path,
                    has_repository=handoff.has_repository,
                    slack_notify_enabled=os.environ.get("AGENT_SLACK_NOTIFY_ENABLED", "").lower()
                    == "true",
                ),
            )
            credential_client = (
                RuntimeCredentialClient(
                    control_plane_url=identity.control_plane_url,
                    session_id=identity.session_id,
                    sandbox_id=identity.sandbox_id,
                    auth_token=identity.auth_token,
                    log=log,
                )
                if oauth_managed and identity.control_plane_url
                else None
            )
            return ClaudeHarness(
                config=config,
                log=log,
                credential_client=credential_client,
            )
    raise ValueError(f"Unsupported harness: {harness_id}")


def _session_config_from_env() -> dict[str, object]:
    import json
    import os

    try:
        parsed = json.loads(os.environ.get("SESSION_CONFIG", "{}"))
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _mcp_servers_from(session_config: dict[str, object]) -> tuple[dict[str, object], ...]:
    servers = session_config.get("mcp_servers")
    if not isinstance(servers, list):
        return ()
    return tuple(server for server in servers if isinstance(server, dict))


def _repository_guidance(workdir: Path) -> str | None:
    """Surface the supervisor's workspace AGENTS.md through the system prompt.

    Claude reads CLAUDE.md natively; multi-repo workspaces only carry the
    AGENTS.md the supervisor writes, and nothing is written into repositories.
    """
    notes = workdir / "AGENTS.md"
    if not notes.is_file() or (workdir / "CLAUDE.md").is_file():
        return None
    try:
        text = notes.read_text().strip()
    except OSError:
        return None
    if not text:
        return None
    return "Workspace guidance (AGENTS.md):\n\n" + text


__all__ = [
    "DEFAULT_HARNESS_ID",
    "DETERMINISTIC_FAILURE_EXIT_CODE",
    "AgentHarness",
    "BridgeEvent",
    "BridgeIdentity",
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

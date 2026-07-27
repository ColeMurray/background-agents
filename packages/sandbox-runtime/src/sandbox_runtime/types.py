"""Type definitions for sandbox operations."""

from enum import StrEnum
from typing import Any, TypedDict

from pydantic import BaseModel


class SandboxStatus(StrEnum):
    """Status of a sandbox instance."""

    PENDING = "pending"
    SPAWNING = "spawning"
    CONNECTING = "connecting"
    WARMING = "warming"
    SYNCING = "syncing"
    READY = "ready"
    RUNNING = "running"
    STALE = "stale"  # Heartbeat missed - sandbox may be unresponsive
    SNAPSHOTTING = "snapshotting"  # Taking filesystem snapshot
    STOPPED = "stopped"
    FAILED = "failed"


class GitSyncStatus(StrEnum):
    """Status of git synchronization."""

    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"


class SandboxEvent(BaseModel):
    """Event emitted from sandbox to control plane."""

    type: str
    sandbox_id: str
    data: dict[str, Any] = {}
    timestamp: float


class HeartbeatEvent(SandboxEvent):
    """Heartbeat event from sandbox."""

    type: str = "heartbeat"
    status: SandboxStatus


class TokenEvent(SandboxEvent):
    """Token streaming event from agent."""

    type: str = "token"
    content: str
    message_id: str


class ToolCallEvent(SandboxEvent):
    """Tool call event from agent."""

    type: str = "tool_call"
    tool: str
    args: dict[str, Any]
    call_id: str


class ToolResultEvent(SandboxEvent):
    """Tool result event from agent."""

    type: str = "tool_result"
    call_id: str
    result: str
    error: str | None = None


class GitSyncEvent(SandboxEvent):
    """Git sync status event."""

    type: str = "git_sync"
    status: GitSyncStatus
    sha: str | None = None
    error: str | None = None


class ExecutionCompleteEvent(SandboxEvent):
    """Execution complete event."""

    type: str = "execution_complete"
    message_id: str
    success: bool


class ArtifactEvent(SandboxEvent):
    """Artifact created event."""

    type: str = "artifact"
    artifact_type: str
    url: str
    metadata: dict[str, Any] = {}


class GitUser(BaseModel):
    """Git user configuration for commit attribution."""

    name: str
    email: str


class McpServerConfig(TypedDict, total=False):
    """MCP server config entry. Mirrors the TypeScript McpServerConfig type."""

    id: str
    name: str
    type: str  # "local" | "remote"
    command: list[str]
    url: str
    env: dict[str, str]
    headers: dict[str, str]
    repoScopes: list[str] | None
    enabled: bool


class SessionRepositoryConfig(TypedDict, total=False):
    """One member of a multi-repo session, in position order (first = primary).

    Mirrors the control plane's per-repo spawn shape (snake_case wire form).
    """

    repo_owner: str
    repo_name: str
    branch: str | None
    base_sha: str | None


class SessionConfig(BaseModel):
    """Configuration passed to sandbox for a session.

    This model is round-tripped by modal-infra (web_api builds it from the
    create request, the manager serializes it into the SESSION_CONFIG env
    var), and pydantic silently drops unknown keys — new wire fields MUST be
    added here or they never reach the sandbox.
    """

    session_id: str
    repo_owner: str | None = None
    repo_name: str | None = None
    branch: str | None = None
    base_sha: str | None = None
    opencode_session_id: str | None = None
    provider: str = "anthropic"
    model: str = "claude-sonnet-4-6"
    mcp_servers: list[McpServerConfig] | None = None
    # Ordered member list for multi-repo sessions; absent for scalar sessions
    # (the runtime synthesizes a one-entry list from repo_owner/repo_name).
    repositories: list[SessionRepositoryConfig] | None = None
    # Shared working-branch name, computed control-plane-side
    # (generateBranchName) — the runtime never derives branch names itself.
    working_branch_name: str | None = None

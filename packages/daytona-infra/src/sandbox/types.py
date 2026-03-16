"""Type definitions for sandbox operations."""

from enum import StrEnum
from typing import Any

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


class SessionConfig(BaseModel):
    """Configuration passed to sandbox for a session."""

    session_id: str
    repo_owner: str
    repo_name: str
    branch: str | None = None
    base_sha: str | None = None
    opencode_session_id: str | None = None
    provider: str = "anthropic"
    model: str = "claude-sonnet-4-6"

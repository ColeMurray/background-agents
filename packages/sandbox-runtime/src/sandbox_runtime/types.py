"""Type definitions for sandbox operations."""

from enum import StrEnum
from typing import TypedDict

from pydantic import BaseModel


class SandboxStatus(StrEnum):
    """Status of a sandbox instance."""

    PENDING = "pending"
    SPAWNING = "spawning"
    CONNECTING = "connecting"
    WARMING = "warming"
    READY = "ready"
    STALE = "stale"  # Heartbeat missed - sandbox may be unresponsive
    SNAPSHOTTING = "snapshotting"  # Taking filesystem snapshot
    STOPPED = "stopped"
    FAILED = "failed"


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

"""Configuration and handles shared by Modal sandbox operations."""

from dataclasses import dataclass
from typing import Any

import modal

from sandbox_runtime.constants import DEFAULT_SANDBOX_TIMEOUT_SECONDS
from sandbox_runtime.types import SandboxStatus, SessionConfig

DEFAULT_VNC_ENABLED = False


@dataclass
class SandboxConfig:
    """Configuration for creating a sandbox."""

    repo_owner: str | None
    repo_name: str | None
    sandbox_id: str | None = None  # Expected sandbox ID from control plane
    session_config: SessionConfig | dict[str, Any] | None = None
    control_plane_url: str = ""
    sandbox_auth_token: str = ""
    timeout_seconds: int = DEFAULT_SANDBOX_TIMEOUT_SECONDS
    user_env_vars: dict[str, str] | None = None  # User-provided env vars (repo secrets)
    repo_image_id: str | None = None  # Pre-built repo image ID from provider
    repo_image_sha: str | None = None  # Git SHA the repo image was built from
    code_server_enabled: bool = False  # Whether to start code-server in the sandbox
    vnc_enabled: bool = DEFAULT_VNC_ENABLED  # Whether to start the browser-accessible VNC desktop
    agent_slack_notify_enabled: bool = (
        False  # Whether to install the agent-initiated slack-notify tool
    )
    settings: dict[str, Any] | None = (
        None  # Sandbox settings (tunnelPorts, etc.) from control plane
    )


@dataclass
class SandboxHandle:
    """Handle to a sandbox."""

    sandbox_id: str
    modal_sandbox: modal.Sandbox
    status: SandboxStatus
    created_at: float
    snapshot_id: str | None = None
    modal_object_id: str | None = None  # Modal's internal sandbox ID for API calls
    code_server_url: str | None = None
    code_server_password: str | None = None
    vnc_url: str | None = None
    vnc_password: str | None = None
    ttyd_url: str | None = None  # proxy tunnel URL (not ttyd directly)
    tunnel_urls: dict[int, str] | None = None  # port -> tunnel URL mapping for extra ports

"""Provider-agnostic sandbox runtime for Open-Inspect.

This package contains the code that runs inside sandboxes regardless of provider
(Modal, E2B, Daytona, Vercel). It includes:
- Bridge: WebSocket/SSE communication with the control plane
- Entrypoint: Supervisor process managing sandbox lifecycle
- Auth: GitHub App and internal HMAC authentication
- Plugins: OpenCode plugins (codex auth proxy)
- Tools: OpenCode custom tools (PR creation, task management)
"""

from .types import GitSyncStatus, GitUser, SandboxEvent, SandboxStatus, SessionConfig

__all__ = [
    "GitSyncStatus",
    "GitUser",
    "SandboxEvent",
    "SandboxStatus",
    "SessionConfig",
]

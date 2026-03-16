"""Sandbox management for Open-Inspect (Daytona backend).

Note: This module is imported both from the API server layer (which has daytona_sdk installed)
and from inside sandboxes (which don't). We use lazy imports to avoid ModuleNotFoundError
when running inside a sandbox.
"""

from .types import GitSyncStatus, GitUser, SandboxEvent, SandboxStatus, SessionConfig


# Manager is only available when running in API server context (not inside sandbox)
# Use lazy import to avoid ModuleNotFoundError
def get_manager():
    """Get the DaytonaSandboxManager class (only available in API server context)."""
    from .manager import DaytonaSandboxManager

    return DaytonaSandboxManager


def get_sandbox_config():
    """Get the SandboxConfig class (only available in API server context)."""
    from .manager import SandboxConfig

    return SandboxConfig


def get_sandbox_handle():
    """Get the SandboxHandle class (only available in API server context)."""
    from .manager import SandboxHandle

    return SandboxHandle


__all__ = [
    "GitSyncStatus",
    "GitUser",
    "SandboxEvent",
    "SandboxStatus",
    "SessionConfig",
    "get_manager",
    "get_sandbox_config",
    "get_sandbox_handle",
]

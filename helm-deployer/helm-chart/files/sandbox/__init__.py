"""Sandbox management for Open-Inspect.

Note: This module is imported both from the Modal function layer (which has modal installed)
and from inside sandboxes (which don't have modal). We use lazy imports to avoid
ModuleNotFoundError when running inside a sandbox.
"""

from .types import GitSyncStatus, GitUser, SandboxEvent, SandboxStatus, SessionConfig


# Manager is only available when running in Modal function context (not inside sandbox)
# Use lazy import to avoid ModuleNotFoundError
def get_manager():
    """Get the SandboxManager class (only available in Modal function context)."""
    from .manager import SandboxManager

    return SandboxManager


def get_sandbox_config():
    """Get the SandboxConfig class (only available in Modal function context)."""
    from .manager import SandboxConfig

    return SandboxConfig


def get_sandbox_handle():
    """Get the SandboxHandle class (only available in Modal function context)."""
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

"""Sandbox management for Open-Inspect.

Re-exports provider-agnostic types from sandbox_runtime. Modal-specific
manager classes live in .manager and are imported lazily by their callers,
since that module only imports cleanly in Modal function context.
"""

from sandbox_runtime import GitUser, SandboxStatus, SessionConfig

__all__ = [
    "GitUser",
    "SandboxStatus",
    "SessionConfig",
]

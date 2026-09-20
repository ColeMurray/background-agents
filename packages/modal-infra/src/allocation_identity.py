"""Bounded Modal tag identity for Session VM allocations."""

import hashlib


def _identity_tag(value: str) -> str:
    """Hash unbounded control-plane identity into a stable Modal-safe tag value."""
    return f"oi1-{hashlib.sha256(value.encode()).hexdigest()[:48]}"


def session_allocation_tags(
    *, session_id: str, sandbox_id: str, allocation_name: str
) -> dict[str, str]:
    """Return the exact ownership tags shared by allocation and reconciliation."""
    return {
        "openinspect_kind": "session",
        "openinspect_session_id": _identity_tag(session_id),
        "openinspect_sandbox_id": _identity_tag(sandbox_id),
        "openinspect_execution_profile": "docker-v1",
        "openinspect_allocation_name": _identity_tag(allocation_name),
    }

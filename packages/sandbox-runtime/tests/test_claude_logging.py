"""Security and processing bounds for Claude-only trajectory previews."""

from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest

from sandbox_runtime.harness.claude_logging import (
    PREVIEW_MAX_BYTES,
    PREVIEW_MAX_DEPTH,
    PREVIEW_MAX_NODES,
    REDACTED,
    TRUNCATED,
    ClaudeTrajectoryLogger,
)


@pytest.mark.parametrize(
    "value",
    [
        {"nested": [{"DB_PASS": "sensitive", "DATABASE_URL": "sensitive"}]},
        'DB_PASS=sensitive\nDATABASE_URL="sensitive"',
        '{"credentials": {"custom": "sensitive"}}' + " " * (PREVIEW_MAX_BYTES * 4),
        'password="sensitive ' + "more sensitive " * PREVIEW_MAX_BYTES,
        "Authorization: Bearer sensitive",
        "Authorization: Basic sensitive",
        "https://user:sensitive@host/path",
    ],
)
def test_sensitive_keys_and_free_text_assignments_are_redacted(value):
    log = MagicMock()
    trajectory = ClaudeTrajectoryLogger(log, {}, (), None)
    trajectory.diagnostic("test", payload_preview=value)
    preview = log.info.call_args.kwargs["payload_preview"]
    assert "sensitive" not in preview
    assert REDACTED in preview


def test_known_credential_crossing_the_retained_prefix_is_redacted():
    secret = "very-long-credential-" * PREVIEW_MAX_BYTES
    log = MagicMock()
    trajectory = ClaudeTrajectoryLogger(log, {"DB_PASS": secret}, (), None)
    trajectory.stderr("a" * (PREVIEW_MAX_BYTES - 50) + secret)
    preview = log.info.call_args.kwargs["diagnostic_preview"]
    assert "very-long-credential" not in preview
    assert preview.endswith(TRUNCATED) and REDACTED in preview


@pytest.mark.parametrize("password_length", [1000, PREVIEW_MAX_BYTES * 4])
def test_url_userinfo_crossing_the_retained_prefix_is_redacted(password_length):
    log = MagicMock()
    trajectory = ClaudeTrajectoryLogger(log, {}, (), None)
    trajectory.stderr(
        "a" * (PREVIEW_MAX_BYTES - 150)
        + " https://user:"
        + "sensitive" * password_length
        + "@host/path"
    )
    preview = log.info.call_args.kwargs["diagnostic_preview"]
    assert "sensitive" not in preview and "user:" not in preview
    assert REDACTED in preview and preview.endswith(TRUNCATED)


def test_sensitive_property_names_are_also_scrubbed_for_known_credentials():
    log = MagicMock()
    trajectory = ClaudeTrajectoryLogger(log, {"API_KEY": "sk-ant-key-secret"}, (), None)
    trajectory.diagnostic("test", payload_preview={"sk-ant-key-secret": "metadata"})
    assert "sk-ant-key-secret" not in log.info.call_args.kwargs["payload_preview"]


def test_database_and_cloud_credentials_and_json_escaping_are_redacted():
    log = MagicMock()
    secrets = {
        "DATABASE_URL": "postgres://user:db-credential@host/db",
        "AWS_ACCESS_KEY_ID": "cloud-credential",
        "PRIVATE_KEY": 'private-line-1\nprivate-line-2"quoted"',
    }
    trajectory = ClaudeTrajectoryLogger(log, secrets, (), None)
    text = " ".join(json.dumps(value)[1:-1] for value in secrets.values())
    trajectory.stderr(text)
    preview = log.info.call_args.kwargs["diagnostic_preview"]
    for part in ("db-credential", "cloud-credential", "private-line-1", "private-line-2"):
        assert part not in preview


def test_short_mcp_configuration_does_not_redact_text_or_identity_fields():
    log = MagicMock()
    trajectory = ClaudeTrajectoryLogger(
        log, {}, ({"env": {"DEBUG": "1", "ENABLED": "true"}},), None
    )
    trajectory.begin("m1", "session-1")
    trajectory.diagnostic(
        "test", call_id="call-1", parent_tool_use_id="parent-1", diagnostic_preview="1 item, true"
    )
    assert log.info.call_args.kwargs == {
        "message_id": "m1",
        "agent_session_id": "session-1",
        "call_id": "call-1",
        "parent_tool_use_id": "parent-1",
        "diagnostic_preview": "1 item, true",
    }


@pytest.mark.parametrize(
    "value",
    ["a" * 1_000_000, list(range(100_000)), {str(index): "value" for index in range(10_000)}],
)
def test_large_payload_processing_and_output_are_bounded(value):
    log = MagicMock()
    trajectory = ClaudeTrajectoryLogger(log, {}, (), None)
    trajectory.diagnostic("test", payload_preview=value)
    preview = log.info.call_args.kwargs["payload_preview"]
    assert len(preview.encode("utf-8")) <= PREVIEW_MAX_BYTES
    assert TRUNCATED in preview


def test_deep_or_cyclic_structures_are_bounded():
    value = {"nested": {}}
    value["nested"] = value
    log = MagicMock()
    trajectory = ClaudeTrajectoryLogger(log, {}, (), None)
    trajectory.diagnostic("test", payload_preview=value)
    preview = log.info.call_args.kwargs["payload_preview"]
    assert TRUNCATED in preview and len(preview.encode("utf-8")) <= PREVIEW_MAX_BYTES


def test_width_at_the_depth_boundary_still_spends_the_node_budget():
    trajectory = ClaudeTrajectoryLogger(MagicMock(), {}, (), None)
    value = list(range(100_000))
    for _ in range(PREVIEW_MAX_DEPTH):
        value = [value]
    safe = trajectory._redact(value, [PREVIEW_MAX_NODES])
    for _ in range(PREVIEW_MAX_DEPTH):
        safe = safe[0]
    assert len(safe) <= PREVIEW_MAX_NODES and TRUNCATED in safe

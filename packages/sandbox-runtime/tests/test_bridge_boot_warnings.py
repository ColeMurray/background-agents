"""Tests for the bridge's boot-warning drain.

The supervisor queues warnings to a file before the bridge exists; the bridge
forwards each as a `warning` sandbox event after its WebSocket handshake and
consumes the file exactly once.
"""

import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from sandbox_runtime.bridge import AgentBridge


def _create_bridge() -> AgentBridge:
    return AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )


@pytest.mark.asyncio
async def test_drain_forwards_warnings_and_deletes_file(tmp_path: Path):
    warnings_file = tmp_path / "warnings.jsonl"
    warnings_file.write_text(
        json.dumps(
            {"scope": "setup", "message": "setup failed", "repoOwner": "acme", "repoName": "api"}
        )
        + "\n"
        + "not json\n"
        + json.dumps({"scope": "sync", "message": "stale checkout"})
        + "\n"
        + json.dumps({"scope": "sync"})  # no message — dropped
        + "\n"
    )
    bridge = _create_bridge()
    bridge._send_event = AsyncMock()

    with patch("sandbox_runtime.bridge.BOOT_WARNINGS_FILE_PATH", str(warnings_file)):
        await bridge._drain_boot_warnings()

    events = [c.args[0] for c in bridge._send_event.await_args_list]
    assert events == [
        {
            "type": "warning",
            "scope": "setup",
            "message": "setup failed",
            "repoOwner": "acme",
            "repoName": "api",
        },
        {"type": "warning", "scope": "sync", "message": "stale checkout"},
    ]
    assert not warnings_file.exists()


@pytest.mark.asyncio
async def test_drain_is_a_noop_without_file(tmp_path: Path):
    bridge = _create_bridge()
    bridge._send_event = AsyncMock()

    with patch("sandbox_runtime.bridge.BOOT_WARNINGS_FILE_PATH", str(tmp_path / "missing.jsonl")):
        await bridge._drain_boot_warnings()

    bridge._send_event.assert_not_awaited()

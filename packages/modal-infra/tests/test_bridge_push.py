"""Tests for bridge git push handling."""

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.sandbox.bridge import AgentBridge


def _create_bridge(tmp_path: Path) -> AgentBridge:
    bridge = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )
    bridge.repo_path = tmp_path
    repo_dir = tmp_path / "repo"
    (repo_dir / ".git").mkdir(parents=True)
    return bridge


def _push_command() -> dict:
    return {
        "type": "push",
        "pushSpec": {
            "targetBranch": "feature/test",
            "refspec": "HEAD:refs/heads/feature/test",
            "remoteUrl": "https://token@github.com/open-inspect/repo.git",
            "redactedRemoteUrl": "https://***@github.com/open-inspect/repo.git",
            "force": False,
        },
    }


def _fake_process(returncode: int | None, communicate_result: tuple[bytes, bytes] = (b"", b"")):
    process = MagicMock()
    process.returncode = returncode
    process.communicate = AsyncMock(return_value=communicate_result)
    process.wait = AsyncMock(return_value=None)
    process.terminate = MagicMock()
    process.kill = MagicMock()
    return process


@pytest.mark.asyncio
async def test_handle_push_sends_push_complete_on_success(tmp_path: Path):
    bridge = _create_bridge(tmp_path)
    bridge._send_event = AsyncMock()
    process = _fake_process(returncode=0)

    with patch(
        "src.sandbox.bridge.asyncio.create_subprocess_exec", AsyncMock(return_value=process)
    ):
        await bridge._handle_push(_push_command())

    bridge._send_event.assert_awaited_once_with(
        {
            "type": "push_complete",
            "branchName": "feature/test",
        }
    )
    process.terminate.assert_not_called()
    process.kill.assert_not_called()


@pytest.mark.asyncio
async def test_handle_push_sends_auth_error_on_nonzero_exit(tmp_path: Path):
    bridge = _create_bridge(tmp_path)
    bridge._send_event = AsyncMock()
    process = _fake_process(returncode=1)

    with patch(
        "src.sandbox.bridge.asyncio.create_subprocess_exec", AsyncMock(return_value=process)
    ):
        await bridge._handle_push(_push_command())

    bridge._send_event.assert_awaited_once_with(
        {
            "type": "push_error",
            "error": "Push failed - authentication may be required",
            "branchName": "feature/test",
        }
    )
    process.terminate.assert_not_called()
    process.kill.assert_not_called()


@pytest.mark.asyncio
async def test_handle_push_timeout_terminates_process_and_sends_error(tmp_path: Path):
    bridge = _create_bridge(tmp_path)
    bridge._send_event = AsyncMock()
    bridge.GIT_PUSH_TIMEOUT_SECONDS = 42.0
    bridge.GIT_PUSH_TERMINATE_GRACE_SECONDS = 3.0

    process = _fake_process(returncode=None)
    wait_for_calls: list[float | None] = []
    original_wait_for = asyncio.wait_for

    async def timeout_first_wait_for(coro, timeout=None):
        wait_for_calls.append(timeout)
        if len(wait_for_calls) == 1:
            if hasattr(coro, "close"):
                coro.close()
            raise TimeoutError
        return await original_wait_for(coro, timeout=timeout)

    with (
        patch("src.sandbox.bridge.asyncio.create_subprocess_exec", AsyncMock(return_value=process)),
        patch("src.sandbox.bridge.asyncio.wait_for", side_effect=timeout_first_wait_for),
    ):
        await bridge._handle_push(_push_command())

    assert wait_for_calls == [42.0, 3.0]
    process.terminate.assert_called_once()
    process.wait.assert_awaited_once()
    process.kill.assert_not_called()
    bridge._send_event.assert_awaited_once_with(
        {
            "type": "push_error",
            "error": "Push failed - git push timed out after 42s",
            "branchName": "feature/test",
        }
    )

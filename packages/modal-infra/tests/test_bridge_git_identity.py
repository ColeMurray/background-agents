"""Tests for git identity configuration in bridge prompt handling."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest

from src.sandbox.bridge import FALLBACK_GIT_USER, AgentBridge
from src.sandbox.types import GitUser


@pytest.fixture
def bridge() -> AgentBridge:
    """Create a bridge instance for testing."""
    b = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )
    b.opencode_session_id = "oc-session-123"
    return b


class TestGitIdentityConfiguration:
    """Tests for git identity fallback in _handle_prompt."""

    @pytest.mark.asyncio
    async def test_uses_author_identity_when_provided(self, bridge: AgentBridge):
        """Should use scmName/scmEmail from the prompt author when both are present."""
        bridge._configure_git_identity = AsyncMock()
        bridge._stream_opencode_response_sse = AsyncMock(
            return_value=AsyncMock(
                __aiter__=lambda s: s, __anext__=AsyncMock(side_effect=StopAsyncIteration)
            )
        )
        bridge._send_execution_complete = AsyncMock()

        cmd = {
            "messageId": "msg-1",
            "content": "fix the bug",
            "model": "claude-sonnet-4-6",
            "author": {
                "userId": "user-1",
                "scmName": "Jane Dev",
                "scmEmail": "jane@example.com",
            },
        }

        await bridge._handle_prompt(cmd)

        bridge._configure_git_identity.assert_called_once()
        git_user = bridge._configure_git_identity.call_args[0][0]
        assert git_user.name == "Jane Dev"
        assert git_user.email == "jane@example.com"

    @pytest.mark.asyncio
    async def test_falls_back_when_both_missing(self, bridge: AgentBridge):
        """Should use fallback identity when both scmName and scmEmail are null."""
        bridge._configure_git_identity = AsyncMock()
        bridge._stream_opencode_response_sse = AsyncMock(
            return_value=AsyncMock(
                __aiter__=lambda s: s, __anext__=AsyncMock(side_effect=StopAsyncIteration)
            )
        )
        bridge._send_execution_complete = AsyncMock()

        cmd = {
            "messageId": "msg-1",
            "content": "fix the bug",
            "model": "claude-sonnet-4-6",
            "author": {
                "userId": "user-1",
                "scmName": None,
                "scmEmail": None,
            },
        }

        await bridge._handle_prompt(cmd)

        bridge._configure_git_identity.assert_called_once()
        git_user = bridge._configure_git_identity.call_args[0][0]
        assert git_user.name == FALLBACK_GIT_USER.name
        assert git_user.email == FALLBACK_GIT_USER.email

    @pytest.mark.asyncio
    async def test_falls_back_email_when_only_email_missing(self, bridge: AgentBridge):
        """Should use fallback email when scmEmail is null but scmName is present."""
        bridge._configure_git_identity = AsyncMock()
        bridge._stream_opencode_response_sse = AsyncMock(
            return_value=AsyncMock(
                __aiter__=lambda s: s, __anext__=AsyncMock(side_effect=StopAsyncIteration)
            )
        )
        bridge._send_execution_complete = AsyncMock()

        cmd = {
            "messageId": "msg-1",
            "content": "fix the bug",
            "model": "claude-sonnet-4-6",
            "author": {
                "userId": "user-1",
                "scmName": "Jane Dev",
                "scmEmail": None,
            },
        }

        await bridge._handle_prompt(cmd)

        bridge._configure_git_identity.assert_called_once()
        git_user = bridge._configure_git_identity.call_args[0][0]
        assert git_user.name == "Jane Dev"
        assert git_user.email == FALLBACK_GIT_USER.email

    @pytest.mark.asyncio
    async def test_falls_back_name_when_only_name_missing(self, bridge: AgentBridge):
        """Should use fallback name when scmName is null but scmEmail is present."""
        bridge._configure_git_identity = AsyncMock()
        bridge._stream_opencode_response_sse = AsyncMock(
            return_value=AsyncMock(
                __aiter__=lambda s: s, __anext__=AsyncMock(side_effect=StopAsyncIteration)
            )
        )
        bridge._send_execution_complete = AsyncMock()

        cmd = {
            "messageId": "msg-1",
            "content": "fix the bug",
            "model": "claude-sonnet-4-6",
            "author": {
                "userId": "user-1",
                "scmName": None,
                "scmEmail": "jane@example.com",
            },
        }

        await bridge._handle_prompt(cmd)

        bridge._configure_git_identity.assert_called_once()
        git_user = bridge._configure_git_identity.call_args[0][0]
        assert git_user.name == FALLBACK_GIT_USER.name
        assert git_user.email == "jane@example.com"

    @pytest.mark.asyncio
    async def test_falls_back_when_no_author_data(self, bridge: AgentBridge):
        """Should use fallback identity when author dict has no SCM fields."""
        bridge._configure_git_identity = AsyncMock()
        bridge._stream_opencode_response_sse = AsyncMock(
            return_value=AsyncMock(
                __aiter__=lambda s: s, __anext__=AsyncMock(side_effect=StopAsyncIteration)
            )
        )
        bridge._send_execution_complete = AsyncMock()

        cmd = {
            "messageId": "msg-1",
            "content": "fix the bug",
            "model": "claude-sonnet-4-6",
            "author": {"userId": "user-1"},
        }

        await bridge._handle_prompt(cmd)

        bridge._configure_git_identity.assert_called_once()
        git_user = bridge._configure_git_identity.call_args[0][0]
        assert git_user.name == FALLBACK_GIT_USER.name
        assert git_user.email == FALLBACK_GIT_USER.email


class TestFallbackGitUserConstant:
    """Tests for the FALLBACK_GIT_USER constant."""

    def test_fallback_identity_values(self):
        """Fallback should use Open-Inspect noreply identity."""
        assert FALLBACK_GIT_USER.name == "OpenInspect"
        assert FALLBACK_GIT_USER.email == "open-inspect@noreply.github.com"


class TestConfigureGitIdentity:
    """Tests for non-blocking git identity configuration."""

    @pytest.mark.asyncio
    async def test_configures_name_and_email_with_async_subprocess(
        self,
        bridge: AgentBridge,
        tmp_path,
    ):
        repo_dir = tmp_path / "repo"
        (repo_dir / ".git").mkdir(parents=True)
        bridge.repo_path = tmp_path

        name_proc = MagicMock()
        name_proc.communicate = AsyncMock(return_value=(b"", b""))
        name_proc.returncode = 0

        email_proc = MagicMock()
        email_proc.communicate = AsyncMock(return_value=(b"", b""))
        email_proc.returncode = 0

        with patch(
            "src.sandbox.bridge.asyncio.create_subprocess_exec",
            new_callable=AsyncMock,
            side_effect=[name_proc, email_proc],
        ) as mock_exec:
            await bridge._configure_git_identity(GitUser(name="Jane Dev", email="jane@example.com"))

        mock_exec.assert_has_awaits(
            [
                call(
                    "git",
                    "config",
                    "--local",
                    "user.name",
                    "Jane Dev",
                    cwd=repo_dir,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE,
                ),
                call(
                    "git",
                    "config",
                    "--local",
                    "user.email",
                    "jane@example.com",
                    cwd=repo_dir,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE,
                ),
            ]
        )

    @pytest.mark.asyncio
    async def test_logs_error_when_git_config_fails(
        self,
        bridge: AgentBridge,
        tmp_path,
    ):
        repo_dir = tmp_path / "repo"
        (repo_dir / ".git").mkdir(parents=True)
        bridge.repo_path = tmp_path
        bridge.log = MagicMock()

        failed_proc = MagicMock()
        failed_proc.communicate = AsyncMock(return_value=(b"", b"invalid config"))
        failed_proc.returncode = 1

        with patch(
            "src.sandbox.bridge.asyncio.create_subprocess_exec",
            new_callable=AsyncMock,
            return_value=failed_proc,
        ) as mock_exec:
            await bridge._configure_git_identity(GitUser(name="Jane Dev", email="jane@example.com"))

        mock_exec.assert_awaited_once()
        bridge.log.error.assert_called_once()
        assert bridge.log.error.call_args.args[0] == "git.identity_error"

    @pytest.mark.asyncio
    async def test_logs_error_when_git_config_times_out(
        self,
        bridge: AgentBridge,
        tmp_path,
    ):
        repo_dir = tmp_path / "repo"
        (repo_dir / ".git").mkdir(parents=True)
        bridge.repo_path = tmp_path
        bridge.log = MagicMock()

        hanging_proc = MagicMock()
        hanging_proc.communicate = AsyncMock(side_effect=asyncio.TimeoutError)
        hanging_proc.wait = AsyncMock(return_value=0)
        hanging_proc.kill = MagicMock()

        with patch(
            "src.sandbox.bridge.asyncio.create_subprocess_exec",
            new_callable=AsyncMock,
            return_value=hanging_proc,
        ) as mock_exec:
            await bridge._configure_git_identity(GitUser(name="Jane Dev", email="jane@example.com"))

        mock_exec.assert_awaited_once()
        hanging_proc.kill.assert_called_once()
        hanging_proc.wait.assert_awaited_once()
        bridge.log.error.assert_called_once()
        assert bridge.log.error.call_args.args[0] == "git.identity_error"

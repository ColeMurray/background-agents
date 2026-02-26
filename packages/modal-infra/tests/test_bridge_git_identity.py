"""Tests for git identity configuration in bridge prompt handling."""

from unittest.mock import AsyncMock

import pytest

from src.sandbox.bridge import FALLBACK_GIT_USER, AgentBridge


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

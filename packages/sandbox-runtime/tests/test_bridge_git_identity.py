"""Tests for git identity configuration in bridge prompt handling."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.bridge import FALLBACK_GIT_USER, AgentBridge
from sandbox_runtime.git_signing import GitSigningError
from sandbox_runtime.types import GitUser


async def empty_event_stream(*_args, **_kwargs):
    if False:
        yield {}


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
        """Should use the attributed-user identity selected by the control plane."""
        bridge._configure_git_identity = AsyncMock()
        bridge._stream_opencode_response_sse = empty_event_stream
        bridge._send_event = AsyncMock()

        cmd = {
            "messageId": "msg-1",
            "content": "fix the bug",
            "model": "claude-sonnet-4-6",
            "author": {
                "userId": "user-1",
                "gitIdentity": {
                    "mode": "attributed-user",
                    "name": "Jane Dev",
                    "email": "jane@example.com",
                },
            },
        }

        await bridge._handle_prompt(cmd)

        bridge._configure_git_identity.assert_called_once()
        git_user = bridge._configure_git_identity.call_args[0][0]
        assert git_user.name == "Jane Dev"
        assert git_user.email == "jane@example.com"

    @pytest.mark.asyncio
    async def test_uses_agent_only_mode_when_selected(self, bridge: AgentBridge):
        bridge._configure_git_identity = AsyncMock()
        bridge._stream_opencode_response_sse = empty_event_stream
        bridge._send_execution_complete = AsyncMock()

        cmd = {
            "messageId": "msg-1",
            "content": "fix the bug",
            "model": "claude-sonnet-4-6",
            "author": {
                "userId": "user-1",
                "gitIdentity": {"mode": "agent-only"},
            },
        }

        await bridge._handle_prompt(cmd)

        bridge._configure_git_identity.assert_awaited_once_with(None)

    @pytest.mark.asyncio
    async def test_rejects_an_incomplete_attributed_identity(self, bridge: AgentBridge):
        bridge._configure_git_identity = AsyncMock()
        bridge._stream_opencode_response_sse = empty_event_stream
        bridge._send_event = AsyncMock()

        cmd = {
            "messageId": "msg-1",
            "content": "fix the bug",
            "model": "claude-sonnet-4-6",
            "author": {
                "userId": "user-1",
                "gitIdentity": {"mode": "attributed-user", "name": "Jane Dev"},
            },
        }

        await bridge._handle_prompt(cmd)

        bridge._configure_git_identity.assert_not_awaited()
        bridge._send_event.assert_awaited_once_with(
            {
                "type": "execution_complete",
                "messageId": "msg-1",
                "success": False,
                "error": "Invalid prompt Git identity",
            }
        )

    @pytest.mark.asyncio
    async def test_rejects_an_unknown_identity_mode(self, bridge: AgentBridge):
        bridge._configure_git_identity = AsyncMock()
        bridge._stream_opencode_response_sse = empty_event_stream
        bridge._send_event = AsyncMock()

        cmd = {
            "messageId": "msg-1",
            "content": "fix the bug",
            "model": "claude-sonnet-4-6",
            "author": {
                "userId": "user-1",
                "gitIdentity": {"mode": "surprise"},
            },
        }

        await bridge._handle_prompt(cmd)

        bridge._configure_git_identity.assert_not_awaited()
        bridge._send_event.assert_awaited_once_with(
            {
                "type": "execution_complete",
                "messageId": "msg-1",
                "success": False,
                "error": "Invalid prompt Git identity",
            }
        )

    @pytest.mark.asyncio
    async def test_rejects_a_missing_git_identity_mode(self, bridge: AgentBridge):
        bridge._configure_git_identity = AsyncMock()
        bridge._stream_opencode_response_sse = empty_event_stream
        bridge._send_event = AsyncMock()

        cmd = {
            "messageId": "msg-1",
            "content": "fix the bug",
            "model": "claude-sonnet-4-6",
            "author": {"userId": "user-1"},
        }

        await bridge._handle_prompt(cmd)

        bridge._configure_git_identity.assert_not_awaited()
        bridge._send_event.assert_awaited_once_with(
            {
                "type": "execution_complete",
                "messageId": "msg-1",
                "success": False,
                "error": "Invalid prompt Git identity",
            }
        )


class TestFallbackGitUserConstant:
    """Tests for the FALLBACK_GIT_USER constant."""

    def test_fallback_identity_values(self):
        """Fallback should use Open-Inspect noreply identity."""
        assert FALLBACK_GIT_USER.name == "OpenInspect"
        assert FALLBACK_GIT_USER.email == "open-inspect@noreply.github.com"


class TestConfigureGitIdentity:
    """Tests for the bridge-to-signing-runtime boundary."""

    @pytest.mark.asyncio
    async def test_delegates_to_the_signing_runtime(self, bridge: AgentBridge):
        bridge.git_signing.refresh = AsyncMock()
        user = GitUser(name="Jane Dev", email="jane@example.com")

        await bridge._configure_git_identity(user)

        bridge.git_signing.refresh.assert_awaited_once_with(user)

    @pytest.mark.asyncio
    async def test_propagates_broker_or_git_failures(self, bridge: AgentBridge):
        bridge.git_signing.refresh = AsyncMock(
            side_effect=GitSigningError("Commit signing configuration unavailable")
        )

        with pytest.raises(GitSigningError, match="configuration unavailable"):
            await bridge._configure_git_identity(GitUser(name="Jane Dev", email="jane@example.com"))

    @pytest.mark.asyncio
    async def test_prompt_is_blocked_before_opencode_when_refresh_fails(self, bridge: AgentBridge):
        bridge.git_signing.refresh = AsyncMock(
            side_effect=GitSigningError("Commit signing configuration unavailable")
        )
        stream = MagicMock()
        bridge._stream_opencode_response_sse = stream
        bridge._send_event = AsyncMock()

        await bridge._handle_prompt(
            {
                "messageId": "msg-1",
                "content": "fix the bug",
                "author": {
                    "gitIdentity": {
                        "mode": "attributed-user",
                        "name": "Jane Dev",
                        "email": "jane@example.com",
                    }
                },
            }
        )

        stream.assert_not_called()
        bridge._send_event.assert_awaited_once_with(
            {
                "type": "execution_complete",
                "messageId": "msg-1",
                "success": False,
                "error": "Commit signing configuration unavailable",
            }
        )

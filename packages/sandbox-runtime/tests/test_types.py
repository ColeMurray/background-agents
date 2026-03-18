"""Tests for sandbox runtime type definitions."""

from sandbox_runtime.types import (
    GitSyncStatus,
    SandboxStatus,
    SessionConfig,
)


class TestSandboxTypes:
    """Test sandbox type definitions."""

    def test_sandbox_status_values(self):
        """Verify all expected status values exist."""
        assert SandboxStatus.PENDING == "pending"
        assert SandboxStatus.WARMING == "warming"
        assert SandboxStatus.SYNCING == "syncing"
        assert SandboxStatus.READY == "ready"
        assert SandboxStatus.RUNNING == "running"
        assert SandboxStatus.STOPPED == "stopped"
        assert SandboxStatus.FAILED == "failed"

    def test_git_sync_status_values(self):
        """Verify git sync status values."""
        assert GitSyncStatus.PENDING == "pending"
        assert GitSyncStatus.IN_PROGRESS == "in_progress"
        assert GitSyncStatus.COMPLETED == "completed"
        assert GitSyncStatus.FAILED == "failed"

    def test_session_config_defaults(self):
        """Test SessionConfig with default values."""
        config = SessionConfig(
            session_id="test-123",
            repo_owner="acme",
            repo_name="webapp",
        )

        assert config.session_id == "test-123"
        assert config.repo_owner == "acme"
        assert config.repo_name == "webapp"
        assert config.provider == "anthropic"
        assert config.model == "claude-sonnet-4-6"
        assert config.branch is None

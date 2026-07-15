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


class TestSessionConfigRepositories:
    def test_parses_repositories_and_working_branch(self):
        config = SessionConfig(
            session_id="s1",
            repositories=[
                {"repo_owner": "acme", "repo_name": "frontend", "branch": "main"},
                {"repo_owner": "acme", "repo_name": "backend"},
            ],
            working_branch_name="open-inspect/s1",
        )

        round_tripped = SessionConfig.model_validate_json(config.model_dump_json())
        assert round_tripped.repositories is not None
        assert len(round_tripped.repositories) == 2
        assert round_tripped.repositories[0]["repo_name"] == "frontend"
        assert round_tripped.working_branch_name == "open-inspect/s1"

    def test_absent_fields_default_to_none(self):
        config = SessionConfig(session_id="s1")
        assert config.repositories is None
        assert config.working_branch_name is None

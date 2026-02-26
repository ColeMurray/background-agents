"""Tests for entrypoint IMAGE_BUILD_MODE and FROM_REPO_IMAGE branching."""

import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def base_env():
    """Minimal env vars for SandboxSupervisor construction."""
    return {
        "SANDBOX_ID": "test-sandbox",
        "REPO_OWNER": "acme",
        "REPO_NAME": "my-repo",
        "SESSION_CONFIG": "{}",
    }


@pytest.fixture
def build_env(base_env):
    """Env vars for image build mode."""
    return {**base_env, "IMAGE_BUILD_MODE": "true"}


@pytest.fixture
def repo_image_env(base_env):
    """Env vars for starting from a pre-built repo image."""
    return {
        **base_env,
        "FROM_REPO_IMAGE": "true",
        "REPO_IMAGE_SHA": "abc123def456",
    }


def _make_supervisor(env_vars: dict):
    """Create a SandboxSupervisor with the given env vars patched in."""
    with patch.dict(os.environ, env_vars, clear=False):
        from src.sandbox.entrypoint import SandboxSupervisor

        return SandboxSupervisor()


class TestImageBuildMode:
    """IMAGE_BUILD_MODE=true: exit after setup, don't start OpenCode/bridge."""

    @pytest.mark.asyncio
    async def test_exits_after_setup(self, build_env):
        """Should return from run() after git sync + setup, before OpenCode."""
        supervisor = _make_supervisor(build_env)

        supervisor.perform_git_sync = AsyncMock(return_value=True)

        supervisor.run_setup_script = AsyncMock(return_value=True)
        supervisor.start_opencode = AsyncMock()
        supervisor.start_bridge = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()
        # In build mode, entrypoint waits for shutdown_event (builder terminates sandbox).
        # Pre-set so the test doesn't hang.
        supervisor.shutdown_event.set()

        with patch.dict(os.environ, build_env, clear=False):
            await supervisor.run()

        supervisor.perform_git_sync.assert_called_once()
        supervisor.run_setup_script.assert_called_once()
        # OpenCode and bridge should NOT be started in build mode
        supervisor.start_opencode.assert_not_called()
        supervisor.start_bridge.assert_not_called()
        supervisor.monitor_processes.assert_not_called()

    @pytest.mark.asyncio
    async def test_clone_depth_100(self, build_env, tmp_path):
        """Build mode should clone with --depth 100, not --depth 1."""
        supervisor = _make_supervisor(build_env)
        # Point repo_path to a non-existent dir so clone branch is taken
        supervisor.repo_path = tmp_path / "nonexistent"
        # Pre-set so entrypoint doesn't hang waiting for builder to terminate
        supervisor.shutdown_event.set()

        all_calls = []

        async def fake_subprocess(*args, **kwargs):
            all_calls.append(args)
            mock_proc = MagicMock()
            mock_proc.communicate = AsyncMock(return_value=(b"", b""))
            mock_proc.wait = AsyncMock(return_value=0)
            mock_proc.returncode = 0
            return mock_proc

        supervisor.run_setup_script = AsyncMock(return_value=True)
        supervisor.shutdown = AsyncMock()

        with (
            patch.dict(os.environ, build_env, clear=False),
            patch(
                "src.sandbox.entrypoint.asyncio.create_subprocess_exec",
                side_effect=fake_subprocess,
            ),
        ):
            await supervisor.run()

        # Find the clone command (the one with "clone" in the args)
        clone_calls = [args for args in all_calls if "clone" in args]
        assert len(clone_calls) >= 1, f"Expected a git clone call, got: {all_calls}"
        clone_args = clone_calls[0]
        assert "100" in clone_args, f"Expected --depth 100 in clone args, got {clone_args}"
        assert "1" not in clone_args, "Build mode should not use --depth 1"

    @pytest.mark.asyncio
    async def test_setup_script_runs_in_build_mode(self, build_env):
        """Setup script should run in build mode (it IS the build)."""
        supervisor = _make_supervisor(build_env)

        supervisor.perform_git_sync = AsyncMock(return_value=True)

        supervisor.run_setup_script = AsyncMock(return_value=True)
        supervisor.shutdown = AsyncMock()
        # Pre-set so entrypoint doesn't hang waiting for builder to terminate
        supervisor.shutdown_event.set()

        with patch.dict(os.environ, build_env, clear=False):
            await supervisor.run()

        supervisor.run_setup_script.assert_called_once()


class TestFromRepoImage:
    """FROM_REPO_IMAGE=true: incremental sync, skip setup."""

    @pytest.mark.asyncio
    async def test_uses_incremental_sync(self, repo_image_env):
        """Should call _incremental_git_sync instead of perform_git_sync."""
        supervisor = _make_supervisor(repo_image_env)

        supervisor.perform_git_sync = AsyncMock(return_value=True)
        supervisor._incremental_git_sync = AsyncMock(return_value=True)
        supervisor._quick_git_fetch = AsyncMock()

        supervisor.run_setup_script = AsyncMock(return_value=True)
        supervisor.start_opencode = AsyncMock()
        supervisor.start_bridge = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()

        with patch.dict(os.environ, repo_image_env, clear=False):
            await supervisor.run()

        supervisor._incremental_git_sync.assert_called_once()
        supervisor.perform_git_sync.assert_not_called()
        supervisor._quick_git_fetch.assert_not_called()

    @pytest.mark.asyncio
    async def test_skips_setup_script(self, repo_image_env):
        """Setup script should be skipped (already ran during image build)."""
        supervisor = _make_supervisor(repo_image_env)

        supervisor._incremental_git_sync = AsyncMock(return_value=True)

        supervisor.run_setup_script = AsyncMock(return_value=True)
        supervisor.start_opencode = AsyncMock()
        supervisor.start_bridge = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()

        with patch.dict(os.environ, repo_image_env, clear=False):
            await supervisor.run()

        supervisor.run_setup_script.assert_not_called()

    @pytest.mark.asyncio
    async def test_starts_opencode_and_bridge(self, repo_image_env):
        """Should still start OpenCode and bridge (unlike build mode)."""
        supervisor = _make_supervisor(repo_image_env)

        supervisor._incremental_git_sync = AsyncMock(return_value=True)

        supervisor.start_opencode = AsyncMock()
        supervisor.start_bridge = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()

        with patch.dict(os.environ, repo_image_env, clear=False):
            await supervisor.run()

        supervisor.start_opencode.assert_called_once()
        supervisor.start_bridge.assert_called_once()


class TestNormalMode:
    """No build mode or repo image flags: full clone + setup + OpenCode."""

    @pytest.mark.asyncio
    async def test_uses_full_git_sync(self, base_env):
        """Should use perform_git_sync (full clone)."""
        supervisor = _make_supervisor(base_env)

        supervisor.perform_git_sync = AsyncMock(return_value=True)
        supervisor._incremental_git_sync = AsyncMock(return_value=True)
        supervisor._quick_git_fetch = AsyncMock()

        supervisor.run_setup_script = AsyncMock(return_value=True)
        supervisor.start_opencode = AsyncMock()
        supervisor.start_bridge = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()

        with patch.dict(os.environ, base_env, clear=False):
            await supervisor.run()

        supervisor.perform_git_sync.assert_called_once()
        supervisor._incremental_git_sync.assert_not_called()
        supervisor._quick_git_fetch.assert_not_called()

    @pytest.mark.asyncio
    async def test_runs_setup_script(self, base_env):
        """Setup script should run in normal mode."""
        supervisor = _make_supervisor(base_env)

        supervisor.perform_git_sync = AsyncMock(return_value=True)

        supervisor.run_setup_script = AsyncMock(return_value=True)
        supervisor.start_opencode = AsyncMock()
        supervisor.start_bridge = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()

        with patch.dict(os.environ, base_env, clear=False):
            await supervisor.run()

        supervisor.run_setup_script.assert_called_once()

    @pytest.mark.asyncio
    async def test_clone_depth_1(self, base_env, tmp_path):
        """Normal mode should clone with --depth 1."""
        supervisor = _make_supervisor(base_env)
        supervisor.repo_path = tmp_path / "nonexistent"

        all_calls = []

        async def fake_subprocess(*args, **kwargs):
            all_calls.append(args)
            mock_proc = MagicMock()
            mock_proc.communicate = AsyncMock(return_value=(b"", b""))
            mock_proc.wait = AsyncMock(return_value=0)
            mock_proc.returncode = 0
            return mock_proc

        supervisor.run_setup_script = AsyncMock(return_value=True)
        supervisor.start_opencode = AsyncMock()
        supervisor.start_bridge = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()

        with (
            patch.dict(os.environ, base_env, clear=False),
            patch(
                "src.sandbox.entrypoint.asyncio.create_subprocess_exec",
                side_effect=fake_subprocess,
            ),
        ):
            await supervisor.run()

        # Find the clone command
        clone_calls = [args for args in all_calls if "clone" in args]
        assert len(clone_calls) >= 1, f"Expected a git clone call, got: {all_calls}"
        clone_args = clone_calls[0]
        assert "1" in clone_args, f"Expected --depth 1 in clone args, got {clone_args}"
        assert "100" not in clone_args, "Normal mode should not use --depth 100"


class TestIncrementalGitSync:
    """Test _incremental_git_sync() method directly."""

    @pytest.mark.asyncio
    async def test_fetches_and_resets(self, base_env, tmp_path):
        """Should fetch from origin and hard reset to latest."""
        supervisor = _make_supervisor({**base_env, "VCS_CLONE_TOKEN": "test-token"})
        # Point repo_path to an existing directory so the method proceeds
        supervisor.repo_path = tmp_path

        call_log = []

        async def fake_subprocess(*args, **kwargs):
            call_log.append(args)
            mock_proc = MagicMock()
            mock_proc.communicate = AsyncMock(return_value=(b"", b""))
            mock_proc.returncode = 0
            return mock_proc

        with patch(
            "src.sandbox.entrypoint.asyncio.create_subprocess_exec",
            side_effect=fake_subprocess,
        ):
            result = await supervisor._incremental_git_sync()

        assert result is True
        assert supervisor.git_sync_complete.is_set()

        # Verify the three git commands: set-url, fetch, reset
        assert len(call_log) == 3

        # 1. git remote set-url
        assert "set-url" in call_log[0]

        # 2. git fetch origin
        assert "fetch" in call_log[1]
        assert "origin" in call_log[1]

        # 3. git reset --hard origin/main
        assert "reset" in call_log[2]
        assert "--hard" in call_log[2]

    @pytest.mark.asyncio
    async def test_skips_when_no_repo_path(self, base_env, tmp_path):
        """Should return False and set git_sync_complete when repo doesn't exist."""
        supervisor = _make_supervisor(base_env)
        supervisor.repo_path = tmp_path / "nonexistent"

        result = await supervisor._incremental_git_sync()

        assert result is False
        assert supervisor.git_sync_complete.is_set()

    @pytest.mark.asyncio
    async def test_skips_set_url_without_token(self, base_env, tmp_path):
        """Should skip git remote set-url when no clone token."""
        supervisor = _make_supervisor(base_env)
        supervisor.vcs_clone_token = ""
        supervisor.repo_path = tmp_path

        call_log = []

        async def fake_subprocess(*args, **kwargs):
            call_log.append(args)
            mock_proc = MagicMock()
            mock_proc.communicate = AsyncMock(return_value=(b"", b""))
            mock_proc.returncode = 0
            return mock_proc

        with patch(
            "src.sandbox.entrypoint.asyncio.create_subprocess_exec",
            side_effect=fake_subprocess,
        ):
            result = await supervisor._incremental_git_sync()

        assert result is True
        # Only fetch + reset, no set-url
        assert len(call_log) == 2
        assert "fetch" in call_log[0]
        assert "reset" in call_log[1]

"""Tests for entrypoint boot modes and git sync."""

import os
from unittest.mock import ANY, AsyncMock, MagicMock, patch

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


@pytest.fixture
def no_repo_env(base_env):
    """Env vars for a session without a repository workspace."""
    return {
        **base_env,
        "REPO_OWNER": "",
        "REPO_NAME": "",
        "SESSION_CONFIG": "{}",
    }


def _make_supervisor(env_vars: dict):
    """Create a SandboxSupervisor with the given env vars patched in."""
    with patch.dict(os.environ, env_vars, clear=False):
        from sandbox_runtime.entrypoint import SandboxSupervisor

        return SandboxSupervisor()


class TestImageBuildMode:
    """IMAGE_BUILD_MODE=true: setup only, don't run start/OpenCode/bridge."""

    @pytest.mark.asyncio
    async def test_exits_after_setup(self, build_env):
        """Should return from run() after git sync + setup, before OpenCode."""
        supervisor = _make_supervisor(build_env)

        supervisor.sync_repositories = AsyncMock(return_value=[])

        supervisor.run_setup_script = AsyncMock(return_value=True)
        supervisor.run_start_script = AsyncMock(return_value=True)
        supervisor.start_opencode = AsyncMock()
        supervisor.start_bridge = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()
        # In build mode, entrypoint waits for shutdown_event (builder terminates sandbox).
        # Pre-set so the test doesn't hang.
        supervisor.shutdown_event.set()

        with patch.dict(os.environ, build_env, clear=False):
            await supervisor.run()

        supervisor.sync_repositories.assert_called_once()
        supervisor.run_setup_script.assert_called_once()
        supervisor.run_start_script.assert_not_called()
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
        supervisor.repositories = supervisor._parse_repositories()
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
        supervisor.run_start_script = AsyncMock(return_value=True)
        supervisor.shutdown = AsyncMock()

        with (
            patch.dict(os.environ, build_env, clear=False),
            patch(
                "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
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

        supervisor.sync_repositories = AsyncMock(return_value=[])

        supervisor.run_setup_script = AsyncMock(return_value=True)
        supervisor.run_start_script = AsyncMock(return_value=True)
        supervisor.shutdown = AsyncMock()
        # Pre-set so entrypoint doesn't hang waiting for builder to terminate
        supervisor.shutdown_event.set()

        with patch.dict(os.environ, build_env, clear=False):
            await supervisor.run()

        supervisor.run_setup_script.assert_called_once()
        supervisor.run_start_script.assert_not_called()

    @pytest.mark.asyncio
    async def test_setup_failure_is_fatal_in_build_mode(self, build_env):
        """Build mode should fail fast when setup hook fails."""
        supervisor = _make_supervisor(build_env)

        supervisor.sync_repositories = AsyncMock(return_value=[])
        supervisor.run_setup_script = AsyncMock(return_value=False)
        supervisor.run_start_script = AsyncMock(return_value=True)
        supervisor.start_opencode = AsyncMock()
        supervisor.start_bridge = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()

        with patch.dict(os.environ, build_env, clear=False):
            await supervisor.run()

        supervisor._report_fatal_error.assert_called_once()
        supervisor.start_opencode.assert_not_called()
        supervisor.start_bridge.assert_not_called()

    @pytest.mark.asyncio
    async def test_logs_git_sync_complete_with_head_sha(self, build_env, tmp_path):
        """Build mode should log git.sync_complete with head_sha for the image builder."""
        supervisor = _make_supervisor(build_env)
        supervisor.repo_path = tmp_path  # Exists, so _get_head_sha proceeds
        supervisor.repositories = supervisor._parse_repositories()

        supervisor.sync_repositories = AsyncMock(return_value=[])
        supervisor.run_setup_script = AsyncMock(return_value=True)
        supervisor.shutdown = AsyncMock()
        supervisor.shutdown_event.set()
        supervisor.log = MagicMock()

        async def fake_subprocess(*args, **kwargs):
            mock_proc = MagicMock()
            mock_proc.communicate = AsyncMock(return_value=(b"abc123def456\n", b""))
            mock_proc.returncode = 0
            return mock_proc

        with (
            patch.dict(os.environ, build_env, clear=False),
            patch(
                "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
                side_effect=fake_subprocess,
            ),
        ):
            await supervisor.run()

        # Verify git.sync_complete was logged with the SHA
        sync_calls = [
            c
            for c in supervisor.log.info.call_args_list
            if c.args and c.args[0] == "git.sync_complete"
        ]
        assert len(sync_calls) == 1
        assert sync_calls[0].kwargs["head_sha"] == "abc123def456"

    @pytest.mark.asyncio
    async def test_reports_success_callback_from_build_mode(self, build_env, tmp_path):
        """Build mode should report completion itself when callback metadata is configured."""
        supervisor = _make_supervisor(build_env)
        supervisor.repo_path = tmp_path
        supervisor.repositories = supervisor._parse_repositories()

        supervisor.sync_repositories = AsyncMock(return_value=[])
        supervisor.run_setup_script = AsyncMock(return_value=True)
        supervisor.shutdown = AsyncMock()
        supervisor.shutdown_event.set()

        callback = MagicMock()
        callback.report_success = AsyncMock(return_value=True)
        callback.report_failure = AsyncMock(return_value=True)

        async def fake_subprocess(*args, **kwargs):
            mock_proc = MagicMock()
            mock_proc.communicate = AsyncMock(return_value=(b"abc123def456\n", b""))
            mock_proc.returncode = 0
            return mock_proc

        with (
            patch.dict(os.environ, build_env, clear=False),
            patch(
                "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
                side_effect=fake_subprocess,
            ),
            patch(
                "sandbox_runtime.entrypoint.RepoImageBuildCallback.from_env",
                return_value=callback,
            ),
        ):
            await supervisor.run()

        callback.report_success.assert_awaited_once_with(
            base_sha="abc123def456",
            build_duration_seconds=ANY,
        )
        callback.report_failure.assert_not_called()

    @pytest.mark.asyncio
    async def test_reports_failure_callback_from_build_mode(self, build_env):
        """Build mode should report failures itself when callback metadata is configured."""
        supervisor = _make_supervisor(build_env)

        supervisor.sync_repositories = AsyncMock(return_value=[])
        supervisor.run_setup_script = AsyncMock(return_value=False)
        supervisor.shutdown = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()

        callback = MagicMock()
        callback.report_success = AsyncMock(return_value=True)
        callback.report_failure = AsyncMock(return_value=True)

        with (
            patch.dict(os.environ, build_env, clear=False),
            patch(
                "sandbox_runtime.entrypoint.RepoImageBuildCallback.from_env",
                return_value=callback,
            ),
        ):
            await supervisor.run()

        callback.report_success.assert_not_called()
        callback.report_failure.assert_awaited_once_with(
            "setup hook failed for acme/my-repo in build mode"
        )


class TestFromRepoImage:
    """FROM_REPO_IMAGE=true: update repo + start hook, skip setup."""

    @pytest.mark.asyncio
    async def test_updates_existing_checkout_without_cloning(self, repo_image_env, tmp_path):
        """The unified per-repo rule updates the baked checkout in place."""
        supervisor = _make_supervisor(repo_image_env)
        supervisor.repo_path = tmp_path / "my-repo"
        supervisor.repo_path.mkdir(parents=True)
        supervisor.repositories = supervisor._parse_repositories()

        supervisor._clone_repo = AsyncMock(return_value=True)
        supervisor._update_existing_repo = AsyncMock(return_value=True)

        supervisor.run_setup_script = AsyncMock(return_value=True)
        supervisor.run_start_script = AsyncMock(return_value=True)
        supervisor.start_opencode = AsyncMock()
        supervisor.start_bridge = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()

        with patch.dict(os.environ, repo_image_env, clear=False):
            await supervisor.run()

        supervisor._update_existing_repo.assert_called_once_with(supervisor.repositories[0])
        supervisor._clone_repo.assert_not_called()

    @pytest.mark.asyncio
    async def test_skips_setup_and_runs_start_script(self, repo_image_env):
        """Setup is skipped for repo images, but start hook still runs."""
        supervisor = _make_supervisor(repo_image_env)

        supervisor.sync_repositories = AsyncMock(return_value=[])

        supervisor.run_setup_script = AsyncMock(return_value=True)
        supervisor.run_start_script = AsyncMock(return_value=True)
        supervisor.start_opencode = AsyncMock()
        supervisor.start_bridge = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()

        with patch.dict(os.environ, repo_image_env, clear=False):
            await supervisor.run()

        supervisor.run_setup_script.assert_not_called()
        supervisor.run_start_script.assert_called_once()

    @pytest.mark.asyncio
    async def test_starts_opencode_and_bridge(self, repo_image_env):
        """Should still start OpenCode and bridge (unlike build mode)."""
        supervisor = _make_supervisor(repo_image_env)

        supervisor.sync_repositories = AsyncMock(return_value=[])

        supervisor.run_start_script = AsyncMock(return_value=True)
        supervisor.start_opencode = AsyncMock()
        supervisor.start_bridge = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()

        with patch.dict(os.environ, repo_image_env, clear=False):
            await supervisor.run()

        supervisor.start_opencode.assert_called_once()
        supervisor.start_bridge.assert_called_once()

    @pytest.mark.asyncio
    async def test_start_script_failure_is_fatal(self, repo_image_env):
        """Repo-image boot should fail fast when start hook fails."""
        supervisor = _make_supervisor(repo_image_env)

        supervisor.sync_repositories = AsyncMock(return_value=[])
        supervisor.run_setup_script = AsyncMock(return_value=True)
        supervisor.run_start_script = AsyncMock(return_value=False)
        supervisor.start_opencode = AsyncMock()
        supervisor.start_bridge = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()

        with patch.dict(os.environ, repo_image_env, clear=False):
            await supervisor.run()

        supervisor._report_fatal_error.assert_called_once()
        supervisor.start_opencode.assert_not_called()
        supervisor.start_bridge.assert_not_called()


class TestNormalMode:
    """No build mode or repo image flags: full clone + setup + start + OpenCode."""

    @pytest.mark.asyncio
    async def test_uses_full_git_sync(self, base_env, tmp_path):
        """A fresh boot clones (repo missing) then updates — the unified rule."""
        supervisor = _make_supervisor(base_env)
        supervisor.repo_path = tmp_path / "nonexistent"
        supervisor.repositories = supervisor._parse_repositories()

        async def fake_clone(repo):
            repo.path.mkdir(parents=True, exist_ok=True)
            return True

        supervisor._clone_repo = AsyncMock(side_effect=fake_clone)
        supervisor._update_existing_repo = AsyncMock(return_value=True)

        supervisor.run_setup_script = AsyncMock(return_value=True)
        supervisor.run_start_script = AsyncMock(return_value=True)
        supervisor.start_opencode = AsyncMock()
        supervisor.start_bridge = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()

        with patch.dict(os.environ, base_env, clear=False):
            await supervisor.run()

        supervisor._clone_repo.assert_called_once_with(supervisor.repositories[0])
        supervisor._update_existing_repo.assert_called_once_with(supervisor.repositories[0])

    @pytest.mark.asyncio
    async def test_runs_setup_script(self, base_env):
        """Setup script should run in normal mode."""
        supervisor = _make_supervisor(base_env)

        supervisor.sync_repositories = AsyncMock(return_value=[])

        supervisor.run_setup_script = AsyncMock(return_value=True)
        supervisor.run_start_script = AsyncMock(return_value=True)
        supervisor.start_opencode = AsyncMock()
        supervisor.start_bridge = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()

        with patch.dict(os.environ, base_env, clear=False):
            await supervisor.run()

        supervisor.run_setup_script.assert_called_once()
        supervisor.run_start_script.assert_called_once()

    @pytest.mark.asyncio
    async def test_clone_depth_100_in_normal_mode(self, base_env, tmp_path):
        """Normal mode should clone with --depth 100."""
        supervisor = _make_supervisor(base_env)
        supervisor.repo_path = tmp_path / "nonexistent"
        supervisor.repositories = supervisor._parse_repositories()

        all_calls = []

        async def fake_subprocess(*args, **kwargs):
            all_calls.append(args)
            mock_proc = MagicMock()
            mock_proc.communicate = AsyncMock(return_value=(b"", b""))
            mock_proc.wait = AsyncMock(return_value=0)
            mock_proc.returncode = 0
            return mock_proc

        supervisor.run_setup_script = AsyncMock(return_value=True)
        supervisor.run_start_script = AsyncMock(return_value=True)
        supervisor.start_opencode = AsyncMock()
        supervisor.start_bridge = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()

        with (
            patch.dict(os.environ, base_env, clear=False),
            patch(
                "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
                side_effect=fake_subprocess,
            ),
        ):
            await supervisor.run()

        # Find the clone command
        clone_calls = [args for args in all_calls if "clone" in args]
        assert len(clone_calls) >= 1, f"Expected a git clone call, got: {all_calls}"
        clone_args = clone_calls[0]
        assert "100" in clone_args, f"Expected --depth 100 in clone args, got {clone_args}"


class TestSnapshotRestoreMode:
    """RESTORED_FROM_SNAPSHOT=true: update repo (best-effort) + start hook, skip setup."""

    @pytest.mark.asyncio
    async def test_skips_setup_and_runs_start(self, base_env):
        supervisor = _make_supervisor({**base_env, "RESTORED_FROM_SNAPSHOT": "true"})

        supervisor.sync_repositories = AsyncMock(return_value=[])
        supervisor.run_setup_script = AsyncMock(return_value=True)
        supervisor.run_start_script = AsyncMock(return_value=True)
        supervisor.start_opencode = AsyncMock()
        supervisor.start_bridge = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()

        with patch.dict(os.environ, {"RESTORED_FROM_SNAPSHOT": "true"}, clear=False):
            await supervisor.run()

        supervisor.run_setup_script.assert_not_called()
        supervisor.run_start_script.assert_called_once()

    @pytest.mark.asyncio
    async def test_start_failure_is_fatal(self, base_env):
        supervisor = _make_supervisor({**base_env, "RESTORED_FROM_SNAPSHOT": "true"})

        supervisor.sync_repositories = AsyncMock(return_value=[])
        supervisor.run_setup_script = AsyncMock(return_value=True)
        supervisor.run_start_script = AsyncMock(return_value=False)
        supervisor.start_opencode = AsyncMock()
        supervisor.start_bridge = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()

        with patch.dict(os.environ, {"RESTORED_FROM_SNAPSHOT": "true"}, clear=False):
            await supervisor.run()

        supervisor._report_fatal_error.assert_called_once()
        supervisor.start_opencode.assert_not_called()

    @pytest.mark.asyncio
    async def test_resync_failure_is_reported_but_not_fatal(self, base_env, tmp_path):
        supervisor = _make_supervisor({**base_env, "RESTORED_FROM_SNAPSHOT": "true"})
        supervisor.log = MagicMock()

        supervisor.sync_repositories = AsyncMock(return_value=list(supervisor.repositories))
        supervisor.run_setup_script = AsyncMock(return_value=True)
        supervisor.run_start_script = AsyncMock(return_value=True)
        supervisor.start_opencode = AsyncMock()
        supervisor.start_bridge = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()

        with (
            patch.dict(os.environ, {"RESTORED_FROM_SNAPSHOT": "true"}, clear=False),
            patch(
                "sandbox_runtime.entrypoint.BOOT_WARNINGS_FILE_PATH",
                str(tmp_path / "warnings.jsonl"),
            ),
        ):
            await supervisor.run()

        supervisor.log.warn.assert_any_call(
            "supervisor.boot_warning",
            scope="sync",
            warning_message=ANY,
            repo_owner="acme",
            repo_name="my-repo",
        )
        startup_call = next(
            c
            for c in supervisor.log.info.call_args_list
            if c.args and c.args[0] == "sandbox.startup"
        )
        assert startup_call.kwargs["git_sync_success"] is False
        supervisor.start_opencode.assert_called_once()
        # The warning is queued for the bridge to forward as a sandbox event.
        warning_lines = (tmp_path / "warnings.jsonl").read_text().splitlines()
        assert len(warning_lines) == 1
        assert '"scope": "sync"' in warning_lines[0]


class TestNoRepository:
    """Missing repo fields: no clone or repo hooks, but OpenCode still starts."""

    @pytest.mark.asyncio
    async def test_sync_skips_clone(self, no_repo_env):
        supervisor = _make_supervisor(no_repo_env)
        supervisor.log = MagicMock()

        with patch("sandbox_runtime.entrypoint.asyncio.create_subprocess_exec") as mock_exec:
            failed = await supervisor.sync_repositories()

        assert failed == []
        mock_exec.assert_not_called()
        supervisor.log.info.assert_any_call("git.skip_clone", reason="no_repo_configured")

    @pytest.mark.asyncio
    async def test_skips_repo_hooks_but_starts_agent(self, no_repo_env):
        supervisor = _make_supervisor(no_repo_env)
        supervisor.log = MagicMock()

        supervisor._ensure_credential_helper_configured = AsyncMock()
        supervisor.sync_repositories = AsyncMock(return_value=[])
        supervisor.run_setup_script = AsyncMock(return_value=True)
        supervisor.run_start_script = AsyncMock(return_value=True)
        supervisor.start_code_server = AsyncMock()
        supervisor.start_ttyd = AsyncMock()
        supervisor.start_ttyd_proxy = AsyncMock()
        supervisor.start_opencode = AsyncMock()
        supervisor.start_bridge = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()

        with patch.dict(os.environ, no_repo_env, clear=False):
            await supervisor.run()

        assert supervisor.has_repository is False
        assert supervisor.boot_mode == "fresh"
        supervisor.log.info.assert_any_call("supervisor.no_repo_configured")
        supervisor._ensure_credential_helper_configured.assert_not_called()
        supervisor.sync_repositories.assert_called_once()
        supervisor.run_setup_script.assert_not_called()
        supervisor.run_start_script.assert_not_called()
        supervisor.start_opencode.assert_called_once()
        supervisor.start_bridge.assert_called_once()


class TestUpdateExistingRepo:
    """Test _update_existing_repo() — shared by snapshot-restore and repo-image paths."""

    @pytest.mark.asyncio
    async def test_fetches_and_checks_out(self, base_env, tmp_path):
        """Should rewrite origin to a plain URL, fetch with refspec, and checkout.

        The `set-url` step exists to scrub stale embedded tokens from
        snapshots taken before the credential-helper migration.
        """
        supervisor = _make_supervisor(base_env)
        supervisor.repo_path = tmp_path
        supervisor.repositories = supervisor._parse_repositories()

        call_log = []

        async def fake_subprocess(*args, **kwargs):
            call_log.append(args)
            mock_proc = MagicMock()
            mock_proc.communicate = AsyncMock(return_value=(b"", b""))
            mock_proc.returncode = 0
            return mock_proc

        with patch(
            "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
            side_effect=fake_subprocess,
        ):
            result = await supervisor._update_existing_repo(supervisor.repositories[0])

        assert result is True
        # set-url (scrub stale embedded token), fetch, checkout
        assert len(call_log) == 3
        assert "set-url" in call_log[0]
        # The rewrite must use a token-free URL.
        assert call_log[0][-1] == supervisor._build_repo_url(supervisor.repositories[0])
        assert "@" not in call_log[0][-1]
        assert "fetch" in call_log[1]
        assert "checkout" in call_log[2]
        assert "-B" in call_log[2]

    @pytest.mark.asyncio
    async def test_returns_false_when_no_repo_path(self, base_env, tmp_path):
        """Should return False when repo directory doesn't exist."""
        supervisor = _make_supervisor(base_env)
        supervisor.repo_path = tmp_path / "nonexistent"
        supervisor.repositories = supervisor._parse_repositories()

        with patch("sandbox_runtime.entrypoint.asyncio.create_subprocess_exec") as mock_exec:
            result = await supervisor._update_existing_repo(supervisor.repositories[0])
            mock_exec.assert_not_called()

        assert result is False

    @pytest.mark.asyncio
    async def test_uses_explicit_refspec(self, base_env, tmp_path):
        """Fetch must use explicit refspec for shallow/single-branch clones."""
        env = {**base_env, "SESSION_CONFIG": '{"branch": "feature/xyz"}'}
        supervisor = _make_supervisor(env)
        supervisor.repo_path = tmp_path
        supervisor.repositories = supervisor._parse_repositories()

        call_log = []

        async def fake_subprocess(*args, **kwargs):
            call_log.append(args)
            mock_proc = MagicMock()
            mock_proc.communicate = AsyncMock(return_value=(b"", b""))
            mock_proc.returncode = 0
            return mock_proc

        with patch(
            "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
            side_effect=fake_subprocess,
        ):
            await supervisor._update_existing_repo(supervisor.repositories[0])

        fetch_call = next(c for c in call_log if "fetch" in c)
        assert "feature/xyz:refs/remotes/origin/feature/xyz" in fetch_call

    @pytest.mark.asyncio
    async def test_checks_out_target_branch(self, base_env, tmp_path):
        """Checkout must target the session's branch."""
        env = {**base_env, "SESSION_CONFIG": '{"branch": "develop"}'}
        supervisor = _make_supervisor(env)
        supervisor.repo_path = tmp_path
        supervisor.repositories = supervisor._parse_repositories()

        call_log = []

        async def fake_subprocess(*args, **kwargs):
            call_log.append(args)
            mock_proc = MagicMock()
            mock_proc.communicate = AsyncMock(return_value=(b"", b""))
            mock_proc.returncode = 0
            return mock_proc

        with patch(
            "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
            side_effect=fake_subprocess,
        ):
            await supervisor._update_existing_repo(supervisor.repositories[0])

        checkout_call = next(c for c in call_log if "checkout" in c)
        assert "develop" in checkout_call
        assert "origin/develop" in checkout_call

    @pytest.mark.asyncio
    async def test_returns_false_on_fetch_failure(self, base_env, tmp_path):
        """Should return False when fetch fails."""
        supervisor = _make_supervisor(base_env)
        supervisor.repo_path = tmp_path
        supervisor.repositories = supervisor._parse_repositories()

        async def fake_subprocess(*args, **kwargs):
            mock_proc = MagicMock()
            if "fetch" in args:
                mock_proc.returncode = 1
                mock_proc.communicate = AsyncMock(return_value=(b"", b"fetch error"))
            else:
                mock_proc.returncode = 0
                mock_proc.communicate = AsyncMock(return_value=(b"", b""))
            return mock_proc

        with patch(
            "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
            side_effect=fake_subprocess,
        ):
            result = await supervisor._update_existing_repo(supervisor.repositories[0])

        assert result is False

    @pytest.mark.asyncio
    async def test_returns_false_on_checkout_failure(self, base_env, tmp_path):
        """Should return False when checkout fails."""
        supervisor = _make_supervisor(base_env)
        supervisor.repo_path = tmp_path
        supervisor.repositories = supervisor._parse_repositories()

        async def fake_subprocess(*args, **kwargs):
            mock_proc = MagicMock()
            if "checkout" in args:
                mock_proc.returncode = 1
                mock_proc.communicate = AsyncMock(return_value=(b"", b"checkout error"))
            else:
                mock_proc.returncode = 0
                mock_proc.communicate = AsyncMock(return_value=(b"", b""))
            return mock_proc

        with patch(
            "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
            side_effect=fake_subprocess,
        ):
            result = await supervisor._update_existing_repo(supervisor.repositories[0])

        assert result is False


class TestPerformGitSync:
    """Test perform_git_sync() — clone + update flow."""

    @pytest.mark.asyncio
    async def test_clones_with_requested_branch(self, base_env, tmp_path):
        """Fresh clone should use the session's branch, not always 'main'."""
        env = {
            **base_env,
            "SESSION_CONFIG": '{"branch": "staging"}',
        }
        supervisor = _make_supervisor(env)
        supervisor.repo_path = tmp_path / "nonexistent"
        supervisor.repositories = supervisor._parse_repositories()

        call_log = []

        async def fake_subprocess(*args, **kwargs):
            call_log.append(args)
            mock_proc = MagicMock()
            mock_proc.communicate = AsyncMock(return_value=(b"", b""))
            mock_proc.wait = AsyncMock(return_value=0)
            mock_proc.returncode = 0
            # Create the directory so _update_existing_repo proceeds after clone.
            (tmp_path / "nonexistent").mkdir(exist_ok=True)
            return mock_proc

        with patch(
            "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
            side_effect=fake_subprocess,
        ):
            result = await supervisor._sync_repo(supervisor.repositories[0])

        assert result is True

        clone_call = next(c for c in call_log if "clone" in c)
        assert "staging" in clone_call

    @pytest.mark.asyncio
    async def test_fetch_uses_explicit_refspec(self, base_env, tmp_path):
        """After clone exists, fetch must use explicit refspec."""
        env = {
            **base_env,
            "SESSION_CONFIG": '{"branch": "feature/abc"}',
        }
        supervisor = _make_supervisor(env)
        supervisor.repo_path = tmp_path  # Exists, so clone is skipped
        supervisor.repositories = supervisor._parse_repositories()

        call_log = []

        async def fake_subprocess(*args, **kwargs):
            call_log.append(args)
            mock_proc = MagicMock()
            mock_proc.communicate = AsyncMock(return_value=(b"", b""))
            mock_proc.wait = AsyncMock(return_value=0)
            mock_proc.returncode = 0
            return mock_proc

        with patch(
            "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
            side_effect=fake_subprocess,
        ):
            result = await supervisor._sync_repo(supervisor.repositories[0])

        assert result is True

        fetch_call = next(c for c in call_log if "fetch" in c)
        assert "feature/abc:refs/remotes/origin/feature/abc" in fetch_call

    @pytest.mark.asyncio
    async def test_checkout_switches_to_target_branch(self, base_env, tmp_path):
        """After fetch, should checkout -B to the target branch."""
        env = {
            **base_env,
            "SESSION_CONFIG": '{"branch": "release/v2"}',
        }
        supervisor = _make_supervisor(env)
        supervisor.repo_path = tmp_path  # Exists
        supervisor.repositories = supervisor._parse_repositories()

        call_log = []

        async def fake_subprocess(*args, **kwargs):
            call_log.append(args)
            mock_proc = MagicMock()
            mock_proc.communicate = AsyncMock(return_value=(b"", b""))
            mock_proc.wait = AsyncMock(return_value=0)
            mock_proc.returncode = 0
            return mock_proc

        with patch(
            "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
            side_effect=fake_subprocess,
        ):
            await supervisor._sync_repo(supervisor.repositories[0])

        checkout_calls = [c for c in call_log if "checkout" in c]
        assert len(checkout_calls) == 1
        assert "-B" in checkout_calls[0]
        assert "release/v2" in checkout_calls[0]
        assert "origin/release/v2" in checkout_calls[0]

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("method_name", "args", "log_method_name", "event_name"),
        [
            ("_clone_repo", (), "error", "git.clone_error"),
            # `_ensure_plain_origin` logs at error level because a failure
            # here means we'd fall back to the stale embedded-token URL,
            # which surfaces as an opaque 401 — bad.
            ("_ensure_plain_origin", (), "error", "git.set_url_failed"),
            ("_fetch_branch", ("feature/test",), "error", "git.fetch_error"),
            ("_checkout_branch", ("feature/test",), "warn", "git.checkout_error"),
        ],
    )
    async def test_git_failures_redact_credentials_in_logs(
        self, base_env, tmp_path, method_name, args, log_method_name, event_name
    ):
        env = {**base_env, "VCS_HOST": "github.com"}
        supervisor = _make_supervisor(env)
        supervisor.repo_path = tmp_path
        supervisor.repositories = supervisor._parse_repositories()
        supervisor.log = MagicMock()

        # Simulate a redirect chain that leaks credentials from an upstream proxy.
        stderr_text = (
            "fatal: redirected to https://other-user:other-secret@example.com/acme/repo.git"
        )

        async def fake_subprocess(*args, **kwargs):
            mock_proc = MagicMock()
            mock_proc.communicate = AsyncMock(return_value=(b"", stderr_text.encode()))
            mock_proc.returncode = 1
            return mock_proc

        with patch(
            "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
            side_effect=fake_subprocess,
        ):
            await getattr(supervisor, method_name)(supervisor.repositories[0], *args)

        log_call = getattr(supervisor.log, log_method_name).call_args
        assert log_call.args[0] == event_name
        # The generic `user:password@` regex masks the upstream creds.
        assert "other-secret" not in log_call.kwargs["stderr"]
        assert "https://***@example.com/acme/repo.git" in log_call.kwargs["stderr"]

    def test_redact_git_stderr_masks_userinfo_in_urls(self, base_env):
        supervisor = _make_supervisor(base_env)

        stderr_text = (
            "fatal: redirected to https://other-user:other-secret@example.com/acme/my-repo.git"
        )

        redacted_stderr = supervisor._redact_git_stderr(stderr_text)  # type: ignore[attr-defined]

        assert "other-secret" not in redacted_stderr
        assert "https://***@example.com/acme/my-repo.git" in redacted_stderr


class TestBaseBranchProperty:
    """Test base_branch property reads from SESSION_CONFIG correctly."""

    def test_defaults_to_main(self, base_env):
        """Should default to 'main' when no branch in SESSION_CONFIG."""
        supervisor = _make_supervisor(base_env)
        assert supervisor.base_branch == "main"

    def test_reads_branch_from_session_config(self, base_env):
        """Should read branch from SESSION_CONFIG."""
        env = {**base_env, "SESSION_CONFIG": '{"branch": "develop"}'}
        supervisor = _make_supervisor(env)
        assert supervisor.base_branch == "develop"


class TestEnsureCredentialHelperConfigured:
    """Phase-0 git credential helper configuration."""

    @pytest.mark.asyncio
    async def test_configures_helper_and_usehttppath(self, base_env):
        """Must set both credential.helper and credential.useHttpPath.

        useHttpPath is load-bearing: the helper fails closed without a path,
        so a regression dropping it would break every credential request in
        prod while the helper's own tests (which pass path= manually) stayed
        green. This pins it at the boot-config layer.
        """
        supervisor = _make_supervisor(base_env)
        supervisor.log = MagicMock()

        git_config_calls = []

        async def fake_subprocess(*args, **kwargs):
            if "config" in args:
                git_config_calls.append(args)
            proc = MagicMock()
            proc.communicate = AsyncMock(return_value=(b"", b""))
            proc.returncode = 0
            return proc

        with (
            patch(
                "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
                side_effect=fake_subprocess,
            ),
            patch("sandbox_runtime.entrypoint.Path.write_text"),
            patch("sandbox_runtime.entrypoint.Path.chmod"),
            patch("sandbox_runtime.entrypoint.Path.exists", return_value=False),
        ):
            await supervisor._ensure_credential_helper_configured()

        assert all("--replace-all" in c for c in git_config_calls)
        pairs = {(c[4], c[5]) for c in git_config_calls}
        assert ("credential.helper", "/usr/local/bin/oi-git-credentials") in pairs
        assert ("credential.useHttpPath", "true") in pairs

    @pytest.mark.asyncio
    async def test_warns_when_credential_helper_shim_cannot_be_written(self, base_env):
        supervisor = _make_supervisor(base_env)
        supervisor.log = MagicMock()
        git_config_calls = []

        async def fake_subprocess(*args, **kwargs):
            if "config" in args:
                git_config_calls.append(args)
            proc = MagicMock()
            proc.communicate = AsyncMock(return_value=(b"", b""))
            proc.returncode = 0
            return proc

        with (
            patch(
                "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
                side_effect=fake_subprocess,
            ),
            patch("sandbox_runtime.entrypoint.Path.write_text", side_effect=OSError("read-only")),
            patch("sandbox_runtime.entrypoint.Path.exists", return_value=False),
        ):
            await supervisor._ensure_credential_helper_configured()

        supervisor.log.warn.assert_any_call(
            "credential_helper.shim_write_failed",
            error="read-only",
        )
        pairs = {(c[4], c[5]) for c in git_config_calls}
        assert ("credential.helper", "/usr/local/bin/oi-git-credentials") not in pairs
        assert ("credential.useHttpPath", "true") in pairs

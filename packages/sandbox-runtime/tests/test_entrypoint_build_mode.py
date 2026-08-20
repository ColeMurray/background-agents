"""Tests for entrypoint boot modes and git sync."""

import asyncio
import json
import os
import signal
from dataclasses import replace
from unittest.mock import ANY, AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.repository_sync import (
    RepositorySyncOutcome,
    RepositorySyncResult,
    RepositorySyncStatus,
)
from sandbox_runtime.runtime_config import BootMode
from sandbox_runtime.supervisor import ImageBuildExecutionCancelled


@pytest.fixture(autouse=True)
def isolate_optional_runtime_services(monkeypatch):
    """Keep boot policy tests independent from optional service environment gates."""
    monkeypatch.delenv("EXPECTED_TUNNEL_PORTS", raising=False)
    monkeypatch.delenv("TERMINAL_ENABLED", raising=False)
    monkeypatch.delenv("CODE_SERVER_PASSWORD", raising=False)
    monkeypatch.delenv("IMAGE_BUILD_MODE", raising=False)
    monkeypatch.delenv("RESTORED_FROM_SNAPSHOT", raising=False)
    monkeypatch.delenv("FROM_REPO_IMAGE", raising=False)


def _repoint_primary(repository):
    """Repoint the parsed primary entry at the test's reassigned repo_path."""
    repository.repositories = [replace(repository.repositories[0], path=repository.repo_path)]


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
        from tests.runtime_helpers import make_supervisor

        return make_supervisor(env_vars)


def _completion_callback(supervisor):
    """Release the test only after build work reaches its success callback."""
    callback = MagicMock()

    async def report_success(**_kwargs):
        supervisor.shutdown_event.set()
        return True

    callback.report_success = AsyncMock(side_effect=report_success)
    callback.report_failure = AsyncMock(return_value=True)
    return callback


def _sync_result(repositories, status=RepositorySyncStatus.SUCCEEDED):
    repositories = tuple(repositories)
    return RepositorySyncResult(
        repositories,
        tuple(RepositorySyncOutcome(repo, status) for repo in repositories),
    )


def _successful_sync(repository_boot):
    return _sync_result(repository_boot.repositories)


class TestImageBuildMode:
    """IMAGE_BUILD_MODE=true: setup only, don't run start/OpenCode/bridge."""

    @pytest.mark.asyncio
    async def test_exits_after_setup(self, build_env):
        """Should return from run() after git sync + setup, before OpenCode."""
        supervisor = _make_supervisor(build_env)

        supervisor.repository_boot.synchronizer.sync = AsyncMock(
            return_value=_successful_sync(supervisor.repository_boot)
        )

        supervisor.repository_boot.hooks.run_setup = AsyncMock(return_value=True)
        supervisor.repository_boot.hooks.run_start = AsyncMock(return_value=True)
        supervisor.opencode_server.start = AsyncMock()
        supervisor.agent_bridge.start = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()
        with patch.dict(os.environ, build_env, clear=False):
            await supervisor.run(_completion_callback(supervisor))

        supervisor.repository_boot.synchronizer.sync.assert_called_once()
        supervisor.repository_boot.hooks.run_setup.assert_called_once()
        supervisor.repository_boot.hooks.run_start.assert_not_called()
        # OpenCode and bridge should NOT be started in build mode
        supervisor.opencode_server.start.assert_not_called()
        supervisor.agent_bridge.start.assert_not_called()
        supervisor.monitor_processes.assert_not_called()

    @pytest.mark.asyncio
    async def test_preset_shutdown_does_not_create_operation(self, build_env):
        supervisor = _make_supervisor(build_env)
        supervisor.shutdown_event.set()
        operation_factory = MagicMock()

        with pytest.raises(ImageBuildExecutionCancelled):
            await supervisor._run_until_shutdown(operation_factory)

        operation_factory.assert_not_called()

    @pytest.mark.asyncio
    async def test_resolves_diff_baseline_after_sync_before_setup(self, build_env):
        supervisor = _make_supervisor(build_env)
        supervisor.repository_boot.synchronizer.sync = AsyncMock(
            return_value=_sync_result(
                tuple(
                    replace(repo, base_sha="a" * 40)
                    for repo in supervisor.repository_boot.repositories
                )
            )
        )
        observed_baselines = []

        async def assert_baseline_is_ready(_repo, _boot_mode):
            observed_baselines.append(supervisor.repository_boot.repositories[0].base_sha)
            return True

        supervisor.repository_boot.hooks.run_setup = AsyncMock(side_effect=assert_baseline_is_ready)
        supervisor.shutdown = AsyncMock()

        with patch.dict(os.environ, build_env, clear=False):
            await supervisor.run(_completion_callback(supervisor))

        supervisor.repository_boot.hooks.run_setup.assert_awaited_once()
        assert observed_baselines == ["a" * 40]

    @pytest.mark.asyncio
    async def test_clone_depth_100(self, build_env, tmp_path):
        """Build mode should clone with --depth 100, not --depth 1."""
        supervisor = _make_supervisor(build_env)
        # Point repo_path to a non-existent dir so clone branch is taken
        supervisor.repository_boot.repo_path = tmp_path / "nonexistent"
        _repoint_primary(supervisor.repository_boot)
        all_calls = []

        async def fake_subprocess(*args, **kwargs):
            all_calls.append(args)
            mock_proc = MagicMock()
            mock_proc.communicate = AsyncMock(return_value=(b"", b""))
            mock_proc.wait = AsyncMock(return_value=0)
            mock_proc.returncode = 0
            return mock_proc

        supervisor.repository_boot.hooks.run_setup = AsyncMock(return_value=True)
        supervisor.repository_boot.hooks.run_start = AsyncMock(return_value=True)
        supervisor.shutdown = AsyncMock()

        with (
            patch.dict(os.environ, build_env, clear=False),
            patch(
                "sandbox_runtime.repository_sync.asyncio.create_subprocess_exec",
                side_effect=fake_subprocess,
            ),
        ):
            await supervisor.run(_completion_callback(supervisor))

        # Find the clone command (the one with "clone" in the args)
        clone_calls = [args for args in all_calls if "clone" in args]
        assert len(clone_calls) >= 1, f"Expected a git clone call, got: {all_calls}"
        clone_args = clone_calls[0]
        assert "100" in clone_args, f"Expected --depth 100 in clone args, got {clone_args}"
        assert "1" not in clone_args, "Build mode should not use --depth 1"

    @pytest.mark.asyncio
    async def test_clone_cancellation_kills_the_owned_process_group(self, build_env, tmp_path):
        supervisor = _make_supervisor(build_env)
        supervisor.repository_boot.repo_path = tmp_path / "nonexistent"
        _repoint_primary(supervisor.repository_boot)
        started = asyncio.Event()

        async def communicate_forever():
            started.set()
            await asyncio.Event().wait()

        process = MagicMock(returncode=None, pid=4321)
        process.communicate = AsyncMock(side_effect=communicate_forever)
        process.wait = AsyncMock(return_value=-signal.SIGKILL)

        with (
            patch(
                "sandbox_runtime.repository_sync.asyncio.create_subprocess_exec",
                new_callable=AsyncMock,
                return_value=process,
            ) as create_process,
            patch("sandbox_runtime.repository_sync.os.killpg") as kill_process_group,
        ):
            operation = asyncio.create_task(
                supervisor.repository_boot.synchronizer._clone_repo(
                    supervisor.repository_boot.repositories[0]
                )
            )
            await started.wait()
            operation.cancel()
            with pytest.raises(asyncio.CancelledError):
                await operation

        kill_process_group.assert_called_once_with(process.pid, signal.SIGKILL)
        process.wait.assert_awaited_once()
        assert create_process.await_args.kwargs["start_new_session"] is True

    @pytest.mark.asyncio
    async def test_setup_script_runs_in_build_mode(self, build_env):
        """Setup script should run in build mode (it IS the build)."""
        supervisor = _make_supervisor(build_env)

        supervisor.repository_boot.synchronizer.sync = AsyncMock(
            return_value=_successful_sync(supervisor.repository_boot)
        )

        supervisor.repository_boot.hooks.run_setup = AsyncMock(return_value=True)
        supervisor.repository_boot.hooks.run_start = AsyncMock(return_value=True)
        supervisor.shutdown = AsyncMock()
        with patch.dict(os.environ, build_env, clear=False):
            await supervisor.run(_completion_callback(supervisor))

        supervisor.repository_boot.hooks.run_setup.assert_called_once()
        supervisor.repository_boot.hooks.run_start.assert_not_called()

    @pytest.mark.asyncio
    async def test_setup_failure_is_fatal_in_build_mode(self, build_env):
        """Build mode should fail fast when setup hook fails."""
        supervisor = _make_supervisor(build_env)

        supervisor.repository_boot.synchronizer.sync = AsyncMock(
            return_value=_successful_sync(supervisor.repository_boot)
        )
        supervisor.repository_boot.hooks.run_setup = AsyncMock(return_value=False)
        supervisor.repository_boot.hooks.run_start = AsyncMock(return_value=True)
        supervisor.opencode_server.start = AsyncMock()
        supervisor.agent_bridge.start = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()

        with patch.dict(os.environ, build_env, clear=False):
            await supervisor.run()

        supervisor._report_fatal_error.assert_called_once()
        supervisor.opencode_server.start.assert_not_called()
        supervisor.agent_bridge.start.assert_not_called()

    @pytest.mark.asyncio
    async def test_logs_git_sync_complete_with_head_sha(self, build_env, tmp_path):
        """Build mode should log git.sync_complete with head_sha for the image builder."""
        supervisor = _make_supervisor(build_env)
        supervisor.repository_boot.repo_path = tmp_path  # Exists, so _get_head_sha proceeds
        _repoint_primary(supervisor.repository_boot)

        supervisor.repository_boot.synchronizer.sync = AsyncMock(
            return_value=_sync_result(
                tuple(
                    replace(repo, base_sha="abc123def456")
                    for repo in supervisor.repository_boot.repositories
                )
            )
        )
        supervisor.repository_boot.hooks.run_setup = AsyncMock(return_value=True)
        supervisor.shutdown = AsyncMock()
        supervisor.repository_boot.log = MagicMock()

        async def fake_subprocess(*args, **kwargs):
            mock_proc = MagicMock()
            mock_proc.communicate = AsyncMock(return_value=(b"abc123def456\n", b""))
            mock_proc.returncode = 0
            return mock_proc

        with (
            patch.dict(os.environ, build_env, clear=False),
            patch(
                "sandbox_runtime.repository_sync.asyncio.create_subprocess_exec",
                side_effect=fake_subprocess,
            ),
        ):
            await supervisor.run(_completion_callback(supervisor))

        # Verify git.sync_complete was logged with the SHA
        sync_calls = [
            c
            for c in supervisor.repository_boot.log.info.call_args_list
            if c.args and c.args[0] == "git.sync_complete"
        ]
        assert len(sync_calls) == 1
        assert sync_calls[0].kwargs["head_sha"] == "abc123def456"

    @pytest.mark.asyncio
    async def test_build_mode_reports_repository_shas_per_repo(self, build_env, tmp_path):
        """Multi-repo builds report one sha per repository, in position order."""
        env = {
            **build_env,
            "SESSION_CONFIG": json.dumps(
                {
                    "branch": "main",
                    "repositories": [
                        {"repo_owner": "acme", "repo_name": "web", "branch": "main"},
                        {"repo_owner": "acme", "repo_name": "api", "branch": "develop"},
                    ],
                }
            ),
        }
        supervisor = _make_supervisor(env)
        supervisor.repository_boot.workspace_path = tmp_path
        supervisor.repository_boot.repositories = [
            replace(repo, path=tmp_path / repo.name)
            for repo in supervisor.repository_boot.repositories
        ]
        for repo in supervisor.repository_boot.repositories:
            repo.path.mkdir(parents=True, exist_ok=True)

        supervisor.repository_boot.synchronizer.sync = AsyncMock(
            return_value=_sync_result(
                (
                    replace(supervisor.repository_boot.repositories[0], base_sha="aaa111"),
                    replace(supervisor.repository_boot.repositories[1], base_sha="bbb222"),
                )
            )
        )
        supervisor.repository_boot.hooks.run_setup = AsyncMock(return_value=True)
        supervisor.shutdown = AsyncMock()
        supervisor.repository_boot.log = MagicMock()

        shas_by_cwd = {tmp_path / "web": b"aaa111\n", tmp_path / "api": b"bbb222\n"}

        async def fake_subprocess(*args, **kwargs):
            stdout = shas_by_cwd.get(kwargs.get("cwd"), b"")
            mock_proc = MagicMock()
            mock_proc.communicate = AsyncMock(return_value=(stdout, b""))
            mock_proc.wait = AsyncMock(return_value=0)
            mock_proc.returncode = 0
            return mock_proc

        with (
            patch.dict(os.environ, env, clear=False),
            patch(
                "sandbox_runtime.repository_sync.asyncio.create_subprocess_exec",
                side_effect=fake_subprocess,
            ),
        ):
            await supervisor.run(_completion_callback(supervisor))

        sync_calls = [
            c
            for c in supervisor.repository_boot.log.info.call_args_list
            if c.args and c.args[0] == "git.sync_complete"
        ]
        assert len(sync_calls) == 1
        assert sync_calls[0].kwargs["head_sha"] == "aaa111"
        assert sync_calls[0].kwargs["repository_shas"] == [
            {"repoOwner": "acme", "repoName": "web", "baseSha": "aaa111"},
            {"repoOwner": "acme", "repoName": "api", "baseSha": "bbb222"},
        ]

    @pytest.mark.asyncio
    async def test_reports_success_callback_from_build_mode(self, build_env, tmp_path):
        """Build mode should report completion itself when callback metadata is configured."""
        supervisor = _make_supervisor(build_env)
        supervisor.repository_boot.repo_path = tmp_path
        _repoint_primary(supervisor.repository_boot)

        supervisor.repository_boot.synchronizer.sync = AsyncMock(
            return_value=_sync_result(
                tuple(
                    replace(repo, base_sha="abc123def456")
                    for repo in supervisor.repository_boot.repositories
                )
            )
        )
        supervisor.repository_boot.hooks.run_setup = AsyncMock(return_value=True)
        supervisor.shutdown = AsyncMock()

        callback = _completion_callback(supervisor)

        async def fake_subprocess(*args, **kwargs):
            mock_proc = MagicMock()
            mock_proc.communicate = AsyncMock(return_value=(b"abc123def456\n", b""))
            mock_proc.returncode = 0
            return mock_proc

        with (
            patch.dict(os.environ, {**build_env, "SANDBOX_VERSION": "v99-test"}, clear=False),
            patch(
                "sandbox_runtime.repository_sync.asyncio.create_subprocess_exec",
                side_effect=fake_subprocess,
            ),
            patch(
                "sandbox_runtime.supervisor.RepoImageBuildCallback.from_env",
                return_value=callback,
            ),
        ):
            await supervisor.run()

        callback.report_success.assert_awaited_once_with(
            build_duration_seconds=ANY,
            repository_shas=[
                {"repoOwner": "acme", "repoName": "my-repo", "baseSha": "abc123def456"}
            ],
            runtime_version="v99-test",
        )
        callback.report_failure.assert_not_called()

    @pytest.mark.asyncio
    async def test_injected_callback_bypasses_environment_fallback(self, build_env):
        supervisor = _make_supervisor(build_env)
        supervisor._run_image_build_execution = AsyncMock(
            return_value=MagicMock(head_sha="abc123", repository_shas=[])
        )
        supervisor.shutdown = AsyncMock()
        callback = _completion_callback(supervisor)

        with (
            patch.dict(os.environ, build_env, clear=False),
            patch("sandbox_runtime.supervisor.RepoImageBuildCallback.from_env") as from_env,
        ):
            await supervisor.run(callback)

        from_env.assert_not_called()
        callback.report_success.assert_awaited_once()
        callback.report_failure.assert_not_called()

    @pytest.mark.asyncio
    async def test_partial_callback_configuration_aborts_build(self, build_env, monkeypatch):
        """Partial callback env aborts the build instead of silently disabling reporting."""
        from sandbox_runtime.repo_image_callback import (
            BUILD_ID_ENV,
            CALLBACK_TOKEN_ENV,
            CALLBACK_URL_ENV,
            FAILURE_CALLBACK_URL_ENV,
            PROVIDER_SESSION_ID_ENV,
            RepoImageCallbackMisconfigured,
        )

        supervisor = _make_supervisor(build_env)
        supervisor.repository_boot.synchronizer.sync = AsyncMock(
            return_value=_successful_sync(supervisor.repository_boot)
        )
        supervisor.repository_boot.hooks.run_setup = AsyncMock(return_value=True)
        supervisor.shutdown = AsyncMock()

        partial_env = {
            **build_env,
            BUILD_ID_ENV: "build-1",
            CALLBACK_URL_ENV: "https://cp.test/image-builds/build-complete",
            FAILURE_CALLBACK_URL_ENV: "https://cp.test/image-builds/build-failed",
            CALLBACK_TOKEN_ENV: "callback-token",
        }
        monkeypatch.delenv(PROVIDER_SESSION_ID_ENV, raising=False)

        # The raise propagates out of run() (a nonzero exit for the build
        # process) — a completed build must never sit waiting on a shutdown
        # signal with no way to report completion.
        with (
            patch.dict(os.environ, partial_env, clear=False),
            pytest.raises(RepoImageCallbackMisconfigured),
        ):
            await supervisor.run()

        supervisor.repository_boot.synchronizer.sync.assert_not_called()

    @pytest.mark.asyncio
    async def test_reports_failure_callback_from_build_mode(self, build_env):
        """Build mode should report failures itself when callback metadata is configured."""
        supervisor = _make_supervisor(build_env)

        supervisor.repository_boot.synchronizer.sync = AsyncMock(
            return_value=_successful_sync(supervisor.repository_boot)
        )
        supervisor.repository_boot.hooks.run_setup = AsyncMock(return_value=False)
        supervisor.shutdown = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()

        callback = MagicMock()
        callback.report_success = AsyncMock(return_value=True)
        callback.report_failure = AsyncMock(return_value=True)

        with (
            patch.dict(os.environ, build_env, clear=False),
            patch(
                "sandbox_runtime.supervisor.RepoImageBuildCallback.from_env",
                return_value=callback,
            ),
        ):
            build_succeeded = await supervisor.run()

        assert build_succeeded is False
        callback.report_success.assert_not_called()
        callback.report_failure.assert_awaited_once_with(
            "setup hook failed for acme/my-repo in build mode"
        )

    @pytest.mark.asyncio
    async def test_enforces_execution_deadline_before_deferred_finalization(self, build_env):
        supervisor = _make_supervisor(build_env)

        async def wait_forever(_repositories, _boot_mode):
            await asyncio.sleep(3600)

        supervisor.repository_boot.synchronizer.sync = AsyncMock(side_effect=wait_forever)
        supervisor.shutdown = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()

        callback = MagicMock()
        callback.report_success = AsyncMock(return_value=True)
        callback.report_failure = AsyncMock(return_value=True)

        with (
            patch.dict(
                os.environ,
                {**build_env, "OI_IMAGE_BUILD_EXECUTION_TIMEOUT_SECONDS": "1"},
                clear=False,
            ),
            patch(
                "sandbox_runtime.supervisor.RepoImageBuildCallback.from_env",
                return_value=callback,
            ),
        ):
            await supervisor.run()

        callback.report_success.assert_not_called()
        callback.report_failure.assert_awaited_once_with(
            "image build exceeded its 1-second execution timeout"
        )

    @pytest.mark.asyncio
    async def test_external_cancellation_is_not_reported_as_build_timeout(self, build_env):
        supervisor = _make_supervisor(build_env)
        started = asyncio.Event()

        async def wait_for_cancellation(_repositories, _boot_mode):
            started.set()
            await asyncio.Event().wait()

        supervisor.repository_boot.synchronizer.sync = AsyncMock(side_effect=wait_for_cancellation)
        supervisor.shutdown = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()

        callback = MagicMock()
        callback.report_success = AsyncMock(return_value=True)
        callback.report_failure = AsyncMock(return_value=True)

        with (
            patch.dict(
                os.environ,
                {**build_env, "OI_IMAGE_BUILD_EXECUTION_TIMEOUT_SECONDS": "3600"},
                clear=False,
            ),
            patch(
                "sandbox_runtime.supervisor.RepoImageBuildCallback.from_env",
                return_value=callback,
            ),
        ):
            operation = asyncio.create_task(supervisor.run())
            await started.wait()
            operation.cancel()
            with pytest.raises(asyncio.CancelledError):
                await operation

        callback.report_success.assert_not_called()
        callback.report_failure.assert_not_called()
        supervisor._report_fatal_error.assert_not_called()

    @pytest.mark.asyncio
    async def test_signal_during_setup_cancels_build_without_callback(self, build_env):
        supervisor = _make_supervisor(build_env)
        supervisor.repository_boot.synchronizer.sync = AsyncMock(
            return_value=_successful_sync(supervisor.repository_boot)
        )
        supervisor.shutdown = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()
        setup_started = asyncio.Event()
        setup_cancelled = asyncio.Event()

        async def setup_until_cancelled(_repo, _boot_mode):
            setup_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                setup_cancelled.set()

        supervisor.repository_boot.hooks.run_setup = AsyncMock(side_effect=setup_until_cancelled)
        callback = MagicMock()
        callback.report_success = AsyncMock(return_value=True)
        callback.report_failure = AsyncMock(return_value=True)

        with patch.dict(os.environ, build_env, clear=False):
            operation = asyncio.create_task(supervisor.run(callback))
            await setup_started.wait()
            supervisor.request_shutdown(signal.SIGTERM)
            await asyncio.wait_for(operation, timeout=1)

        assert setup_cancelled.is_set()
        callback.report_success.assert_not_called()
        callback.report_failure.assert_not_called()
        supervisor._report_fatal_error.assert_not_called()

    @pytest.mark.asyncio
    async def test_signal_before_success_callback_suppresses_callback(self, build_env):
        supervisor = _make_supervisor(build_env)

        async def finish_as_shutdown_arrives(_expected_tunnel_ports):
            supervisor.shutdown_event.set()
            return MagicMock(head_sha="abc123", repository_shas=[])

        supervisor._run_image_build_execution = AsyncMock(side_effect=finish_as_shutdown_arrives)
        supervisor.shutdown = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()
        callback = MagicMock()
        callback.report_success = AsyncMock(return_value=True)
        callback.report_failure = AsyncMock(return_value=True)

        with patch.dict(os.environ, build_env, clear=False):
            await supervisor.run(callback)

        callback.report_success.assert_not_called()
        callback.report_failure.assert_not_called()
        supervisor._report_fatal_error.assert_not_called()

    @pytest.mark.asyncio
    async def test_signal_during_success_callback_cancels_callback(self, build_env):
        supervisor = _make_supervisor(build_env)
        supervisor._run_image_build_execution = AsyncMock(
            return_value=MagicMock(head_sha="abc123", repository_shas=[])
        )
        supervisor.shutdown = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()
        callback_started = asyncio.Event()
        callback_cancelled = asyncio.Event()

        async def report_until_cancelled(**_kwargs):
            callback_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                callback_cancelled.set()

        callback = MagicMock()
        callback.report_success = AsyncMock(side_effect=report_until_cancelled)
        callback.report_failure = AsyncMock(return_value=True)

        with patch.dict(os.environ, build_env, clear=False):
            operation = asyncio.create_task(supervisor.run(callback))
            await callback_started.wait()
            supervisor.request_shutdown(signal.SIGTERM)
            await asyncio.wait_for(operation, timeout=1)

        assert callback_cancelled.is_set()
        callback.report_failure.assert_not_called()
        supervisor._report_fatal_error.assert_not_called()

    @pytest.mark.asyncio
    async def test_signal_before_failure_callback_suppresses_callback(self, build_env):
        supervisor = _make_supervisor(build_env)

        async def fail_as_shutdown_arrives(_expected_tunnel_ports):
            supervisor.shutdown_event.set()
            raise RuntimeError("setup failed")

        supervisor._run_image_build_execution = AsyncMock(side_effect=fail_as_shutdown_arrives)
        supervisor.shutdown = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()
        callback = MagicMock()
        callback.report_success = AsyncMock(return_value=True)
        callback.report_failure = AsyncMock(return_value=True)

        with patch.dict(os.environ, build_env, clear=False):
            await supervisor.run(callback)

        callback.report_success.assert_not_called()
        callback.report_failure.assert_not_called()
        supervisor._report_fatal_error.assert_not_called()


class TestFromRepoImage:
    """FROM_REPO_IMAGE=true: update repo + start hook, skip setup."""

    @pytest.mark.asyncio
    async def test_updates_existing_checkout_without_cloning(self, repo_image_env, tmp_path):
        """The unified per-repo rule updates the baked checkout in place."""
        supervisor = _make_supervisor(repo_image_env)
        supervisor.repository_boot.repo_path = tmp_path / "my-repo"
        supervisor.repository_boot.repo_path.mkdir(parents=True)
        _repoint_primary(supervisor.repository_boot)

        supervisor.repository_boot.synchronizer._clone_repo = AsyncMock(return_value=True)
        supervisor.repository_boot.synchronizer._update_existing_repo = AsyncMock(return_value=True)

        supervisor.repository_boot.hooks.run_setup = AsyncMock(return_value=True)
        supervisor.repository_boot.hooks.run_start = AsyncMock(return_value=True)
        supervisor.opencode_server.start = AsyncMock()
        supervisor.agent_bridge.start = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()

        with patch.dict(os.environ, repo_image_env, clear=False):
            await supervisor.run()

        supervisor.repository_boot.synchronizer._update_existing_repo.assert_called_once_with(
            supervisor.repository_boot.repositories[0], BootMode.REPO_IMAGE
        )
        supervisor.repository_boot.synchronizer._clone_repo.assert_not_called()

    @pytest.mark.asyncio
    async def test_skips_setup_and_runs_start_script(self, repo_image_env):
        """Setup is skipped for repo images, but start hook still runs."""
        supervisor = _make_supervisor(repo_image_env)

        supervisor.repository_boot.synchronizer.sync = AsyncMock(
            return_value=_successful_sync(supervisor.repository_boot)
        )

        supervisor.repository_boot.hooks.run_setup = AsyncMock(return_value=True)
        supervisor.repository_boot.hooks.run_start = AsyncMock(return_value=True)
        supervisor.opencode_server.start = AsyncMock()
        supervisor.agent_bridge.start = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()

        with patch.dict(os.environ, repo_image_env, clear=False):
            await supervisor.run()

        supervisor.repository_boot.hooks.run_setup.assert_not_called()
        supervisor.repository_boot.hooks.run_start.assert_called_once()

    @pytest.mark.asyncio
    async def test_starts_opencode_and_bridge(self, repo_image_env):
        """Should still start OpenCode and bridge (unlike build mode)."""
        supervisor = _make_supervisor(repo_image_env)

        supervisor.repository_boot.synchronizer.sync = AsyncMock(
            return_value=_successful_sync(supervisor.repository_boot)
        )

        supervisor.repository_boot.hooks.run_start = AsyncMock(return_value=True)
        supervisor.opencode_server.start = AsyncMock()
        supervisor.agent_bridge.start = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()

        with patch.dict(os.environ, repo_image_env, clear=False):
            await supervisor.run()

        supervisor.opencode_server.start.assert_called_once()
        supervisor.agent_bridge.start.assert_called_once()

    @pytest.mark.asyncio
    async def test_start_script_failure_is_fatal(self, repo_image_env):
        """Repo-image boot should fail fast when start hook fails."""
        supervisor = _make_supervisor(repo_image_env)

        supervisor.repository_boot.synchronizer.sync = AsyncMock(
            return_value=_successful_sync(supervisor.repository_boot)
        )
        supervisor.repository_boot.hooks.run_setup = AsyncMock(return_value=True)
        supervisor.repository_boot.hooks.run_start = AsyncMock(return_value=False)
        supervisor.opencode_server.start = AsyncMock()
        supervisor.agent_bridge.start = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()

        with patch.dict(os.environ, repo_image_env, clear=False):
            await supervisor.run()

        supervisor._report_fatal_error.assert_called_once()
        supervisor.opencode_server.start.assert_not_called()
        supervisor.agent_bridge.start.assert_not_called()


class TestNormalMode:
    """No build mode or repo image flags: full clone + setup + start + OpenCode."""

    @pytest.mark.asyncio
    async def test_uses_full_git_sync(self, base_env, tmp_path):
        """A fresh boot clones (repo missing) then updates — the unified rule."""
        supervisor = _make_supervisor(base_env)
        supervisor.repository_boot.repo_path = tmp_path / "nonexistent"
        _repoint_primary(supervisor.repository_boot)

        async def fake_clone(repo):
            repo.path.mkdir(parents=True, exist_ok=True)
            return True

        supervisor.repository_boot.synchronizer._clone_repo = AsyncMock(side_effect=fake_clone)
        supervisor.repository_boot.synchronizer._update_existing_repo = AsyncMock(return_value=True)

        supervisor.repository_boot.hooks.run_setup = AsyncMock(return_value=True)
        supervisor.repository_boot.hooks.run_start = AsyncMock(return_value=True)
        supervisor.opencode_server.start = AsyncMock()
        supervisor.agent_bridge.start = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()

        with patch.dict(os.environ, base_env, clear=False):
            await supervisor.run()

        supervisor.repository_boot.synchronizer._clone_repo.assert_called_once_with(
            supervisor.repository_boot.repositories[0]
        )
        supervisor.repository_boot.synchronizer._update_existing_repo.assert_called_once_with(
            supervisor.repository_boot.repositories[0], BootMode.FRESH
        )

    @pytest.mark.asyncio
    async def test_runs_setup_script(self, base_env):
        """Setup script should run in normal mode."""
        supervisor = _make_supervisor(base_env)

        supervisor.repository_boot.synchronizer.sync = AsyncMock(
            return_value=_successful_sync(supervisor.repository_boot)
        )

        supervisor.repository_boot.hooks.run_setup = AsyncMock(return_value=True)
        supervisor.repository_boot.hooks.run_start = AsyncMock(return_value=True)
        supervisor.opencode_server.start = AsyncMock()
        supervisor.agent_bridge.start = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()

        with patch.dict(os.environ, base_env, clear=False):
            await supervisor.run()

        supervisor.repository_boot.hooks.run_setup.assert_called_once()
        supervisor.repository_boot.hooks.run_start.assert_called_once()

    @pytest.mark.asyncio
    async def test_clone_depth_100_in_normal_mode(self, base_env, tmp_path):
        """Normal mode should clone with --depth 100."""
        supervisor = _make_supervisor(base_env)
        supervisor.repository_boot.repo_path = tmp_path / "nonexistent"
        _repoint_primary(supervisor.repository_boot)

        all_calls = []

        async def fake_subprocess(*args, **kwargs):
            all_calls.append(args)
            mock_proc = MagicMock()
            mock_proc.communicate = AsyncMock(return_value=(b"", b""))
            mock_proc.wait = AsyncMock(return_value=0)
            mock_proc.returncode = 0
            return mock_proc

        supervisor.repository_boot.hooks.run_setup = AsyncMock(return_value=True)
        supervisor.repository_boot.hooks.run_start = AsyncMock(return_value=True)
        supervisor.opencode_server.start = AsyncMock()
        supervisor.agent_bridge.start = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()

        with (
            patch.dict(os.environ, base_env, clear=False),
            patch(
                "sandbox_runtime.repository_sync.asyncio.create_subprocess_exec",
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

        supervisor.repository_boot.synchronizer.sync = AsyncMock(
            return_value=_successful_sync(supervisor.repository_boot)
        )
        supervisor.repository_boot.hooks.run_setup = AsyncMock(return_value=True)
        supervisor.repository_boot.hooks.run_start = AsyncMock(return_value=True)
        supervisor.opencode_server.start = AsyncMock()
        supervisor.agent_bridge.start = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()

        with patch.dict(os.environ, {"RESTORED_FROM_SNAPSHOT": "true"}, clear=False):
            await supervisor.run()

        supervisor.repository_boot.hooks.run_setup.assert_not_called()
        supervisor.repository_boot.hooks.run_start.assert_called_once()

    @pytest.mark.asyncio
    async def test_start_failure_is_fatal(self, base_env):
        supervisor = _make_supervisor({**base_env, "RESTORED_FROM_SNAPSHOT": "true"})

        supervisor.repository_boot.synchronizer.sync = AsyncMock(
            return_value=_successful_sync(supervisor.repository_boot)
        )
        supervisor.repository_boot.hooks.run_setup = AsyncMock(return_value=True)
        supervisor.repository_boot.hooks.run_start = AsyncMock(return_value=False)
        supervisor.opencode_server.start = AsyncMock()
        supervisor.agent_bridge.start = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()

        with patch.dict(os.environ, {"RESTORED_FROM_SNAPSHOT": "true"}, clear=False):
            await supervisor.run()

        supervisor._report_fatal_error.assert_called_once()
        supervisor.opencode_server.start.assert_not_called()

    @pytest.mark.asyncio
    async def test_resync_failure_is_reported_but_not_fatal(self, base_env, tmp_path):
        supervisor = _make_supervisor({**base_env, "RESTORED_FROM_SNAPSHOT": "true"})
        shared_log = MagicMock()
        supervisor.log = shared_log
        supervisor.repository_boot.log = shared_log
        supervisor.repository_boot.warnings.log = shared_log

        supervisor.repository_boot.synchronizer.sync = AsyncMock(
            return_value=_sync_result(
                tuple(supervisor.repository_boot.repositories),
                RepositorySyncStatus.FAILED,
            )
        )
        supervisor.repository_boot.hooks.run_setup = AsyncMock(return_value=True)
        supervisor.repository_boot.hooks.run_start = AsyncMock(return_value=True)
        supervisor.opencode_server.start = AsyncMock()
        supervisor.agent_bridge.start = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()

        with (
            patch.dict(os.environ, {"RESTORED_FROM_SNAPSHOT": "true"}, clear=False),
            patch(
                "sandbox_runtime.boot_warnings.BOOT_WARNINGS_FILE_PATH",
                str(tmp_path / "warnings.jsonl"),
            ),
        ):
            await supervisor.run()

        supervisor.repository_boot.log.warn.assert_any_call(
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
        supervisor.opencode_server.start.assert_called_once()
        # The warning is queued for the bridge to forward as a sandbox event.
        warning_lines = (tmp_path / "warnings.jsonl").read_text().splitlines()
        assert len(warning_lines) == 1
        assert '"scope": "sync"' in warning_lines[0]


class TestNoRepository:
    """Missing repo fields: no clone or repo hooks, but OpenCode still starts."""

    @pytest.mark.asyncio
    async def test_sync_skips_clone(self, no_repo_env):
        supervisor = _make_supervisor(no_repo_env)
        supervisor.repository_boot.synchronizer.log = MagicMock()

        with patch("sandbox_runtime.repository_sync.asyncio.create_subprocess_exec") as mock_exec:
            result = await supervisor.repository_boot.synchronizer.sync([], BootMode.FRESH)

        assert result.failures == ()
        mock_exec.assert_not_called()
        supervisor.repository_boot.synchronizer.log.info.assert_any_call(
            "git.skip_clone", reason="no_repo_configured"
        )

    @pytest.mark.asyncio
    async def test_skips_repo_hooks_but_starts_agent(self, no_repo_env):
        supervisor = _make_supervisor(no_repo_env)
        supervisor.log = MagicMock()

        supervisor.repository_boot.synchronizer.ensure_credentials_configured = AsyncMock()
        supervisor.repository_boot.synchronizer.sync = AsyncMock(
            return_value=_successful_sync(supervisor.repository_boot)
        )
        supervisor.repository_boot.hooks.run_setup = AsyncMock(return_value=True)
        supervisor.repository_boot.hooks.run_start = AsyncMock(return_value=True)
        supervisor.code_server.start = AsyncMock()
        supervisor.web_terminal.start = AsyncMock()
        supervisor.opencode_server.start = AsyncMock()
        supervisor.agent_bridge.start = AsyncMock()
        supervisor.monitor_processes = AsyncMock()
        supervisor.shutdown = AsyncMock()

        with patch.dict(os.environ, no_repo_env, clear=False):
            await supervisor.run()

        assert supervisor.repository_boot.has_repository is False
        assert supervisor.boot_mode.value == "fresh"
        supervisor.log.info.assert_any_call("supervisor.no_repo_configured")
        supervisor.repository_boot.synchronizer.ensure_credentials_configured.assert_not_called()
        supervisor.repository_boot.synchronizer.sync.assert_called_once()
        supervisor.repository_boot.hooks.run_setup.assert_not_called()
        supervisor.repository_boot.hooks.run_start.assert_not_called()
        supervisor.opencode_server.start.assert_called_once()
        supervisor.agent_bridge.start.assert_called_once()


class TestUpdateExistingRepo:
    """Test _update_existing_repo() — shared by snapshot-restore and repo-image paths."""

    @pytest.mark.asyncio
    async def test_fetches_and_checks_out(self, base_env, tmp_path):
        """Should rewrite origin to a plain URL, fetch with refspec, and checkout.

        The `set-url` step exists to scrub stale embedded tokens from
        snapshots taken before the credential-helper migration.
        """
        supervisor = _make_supervisor(base_env)
        supervisor.repository_boot.repo_path = tmp_path
        _repoint_primary(supervisor.repository_boot)

        call_log = []

        async def fake_subprocess(*args, **kwargs):
            call_log.append(args)
            mock_proc = MagicMock()
            mock_proc.communicate = AsyncMock(return_value=(b"", b""))
            mock_proc.returncode = 0
            return mock_proc

        with patch(
            "sandbox_runtime.repository_sync.asyncio.create_subprocess_exec",
            side_effect=fake_subprocess,
        ):
            result = await supervisor.repository_boot.synchronizer._update_existing_repo(
                supervisor.repository_boot.repositories[0], BootMode.FRESH
            )

        assert result is True
        # set-url (scrub stale embedded token), fetch, checkout
        assert len(call_log) == 3
        assert "set-url" in call_log[0]
        # The rewrite must use a token-free URL.
        assert call_log[0][-1] == supervisor.repository_boot.synchronizer._build_repo_url(
            supervisor.repository_boot.repositories[0]
        )
        assert "@" not in call_log[0][-1]
        assert "fetch" in call_log[1]
        assert "checkout" in call_log[2]
        assert "-B" in call_log[2]

    @pytest.mark.asyncio
    async def test_returns_false_when_no_repo_path(self, base_env, tmp_path):
        """Should return False when repo directory doesn't exist."""
        supervisor = _make_supervisor(base_env)
        supervisor.repository_boot.repo_path = tmp_path / "nonexistent"
        _repoint_primary(supervisor.repository_boot)

        with patch("sandbox_runtime.repository_sync.asyncio.create_subprocess_exec") as mock_exec:
            result = await supervisor.repository_boot.synchronizer._update_existing_repo(
                supervisor.repository_boot.repositories[0], BootMode.FRESH
            )
            mock_exec.assert_not_called()

        assert result is False

    @pytest.mark.asyncio
    async def test_uses_explicit_refspec(self, base_env, tmp_path):
        """Fetch must use explicit refspec for shallow/single-branch clones."""
        env = {**base_env, "SESSION_CONFIG": '{"branch": "feature/xyz"}'}
        supervisor = _make_supervisor(env)
        supervisor.repository_boot.repo_path = tmp_path
        _repoint_primary(supervisor.repository_boot)

        call_log = []

        async def fake_subprocess(*args, **kwargs):
            call_log.append(args)
            mock_proc = MagicMock()
            mock_proc.communicate = AsyncMock(return_value=(b"", b""))
            mock_proc.returncode = 0
            return mock_proc

        with patch(
            "sandbox_runtime.repository_sync.asyncio.create_subprocess_exec",
            side_effect=fake_subprocess,
        ):
            await supervisor.repository_boot.synchronizer._update_existing_repo(
                supervisor.repository_boot.repositories[0], BootMode.FRESH
            )

        fetch_call = next(c for c in call_log if "fetch" in c)
        assert "feature/xyz:refs/remotes/origin/feature/xyz" in fetch_call

    @pytest.mark.asyncio
    async def test_checks_out_target_branch(self, base_env, tmp_path):
        """Checkout must target the session's branch."""
        env = {**base_env, "SESSION_CONFIG": '{"branch": "develop"}'}
        supervisor = _make_supervisor(env)
        supervisor.repository_boot.repo_path = tmp_path
        _repoint_primary(supervisor.repository_boot)

        call_log = []

        async def fake_subprocess(*args, **kwargs):
            call_log.append(args)
            mock_proc = MagicMock()
            mock_proc.communicate = AsyncMock(return_value=(b"", b""))
            mock_proc.returncode = 0
            return mock_proc

        with patch(
            "sandbox_runtime.repository_sync.asyncio.create_subprocess_exec",
            side_effect=fake_subprocess,
        ):
            await supervisor.repository_boot.synchronizer._update_existing_repo(
                supervisor.repository_boot.repositories[0], BootMode.FRESH
            )

        checkout_call = next(c for c in call_log if "checkout" in c)
        assert "develop" in checkout_call
        assert "origin/develop" in checkout_call

    @pytest.mark.asyncio
    async def test_returns_false_on_fetch_failure(self, base_env, tmp_path):
        """Should return False when fetch fails."""
        supervisor = _make_supervisor(base_env)
        supervisor.repository_boot.repo_path = tmp_path
        _repoint_primary(supervisor.repository_boot)

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
            "sandbox_runtime.repository_sync.asyncio.create_subprocess_exec",
            side_effect=fake_subprocess,
        ):
            result = await supervisor.repository_boot.synchronizer._update_existing_repo(
                supervisor.repository_boot.repositories[0], BootMode.FRESH
            )

        assert result is False

    @pytest.mark.asyncio
    async def test_returns_false_on_checkout_failure(self, base_env, tmp_path):
        """Should return False when checkout fails."""
        supervisor = _make_supervisor(base_env)
        supervisor.repository_boot.repo_path = tmp_path
        _repoint_primary(supervisor.repository_boot)

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
            "sandbox_runtime.repository_sync.asyncio.create_subprocess_exec",
            side_effect=fake_subprocess,
        ):
            result = await supervisor.repository_boot.synchronizer._update_existing_repo(
                supervisor.repository_boot.repositories[0], BootMode.FRESH
            )

        assert result is False

    @pytest.mark.parametrize(
        ("ensure_origin_result", "fetch_result"),
        [(False, True), (True, False)],
    )
    @pytest.mark.asyncio
    async def test_snapshot_restore_reports_ref_refresh_failures(
        self, base_env, tmp_path, ensure_origin_result, fetch_result
    ):
        supervisor = _make_supervisor(base_env)
        supervisor.repository_boot.repo_path = tmp_path
        _repoint_primary(supervisor.repository_boot)
        supervisor.repository_boot.synchronizer._ensure_plain_origin = AsyncMock(
            return_value=ensure_origin_result
        )
        supervisor.repository_boot.synchronizer._fetch_branch = AsyncMock(return_value=fetch_result)

        result = await supervisor.repository_boot.synchronizer._update_existing_repo(
            supervisor.repository_boot.repositories[0], BootMode.SNAPSHOT_RESTORE
        )

        assert result is False
        if ensure_origin_result:
            supervisor.repository_boot.synchronizer._fetch_branch.assert_awaited_once()
        else:
            supervisor.repository_boot.synchronizer._fetch_branch.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_snapshot_restore_reports_unexpected_refresh_errors(self, base_env, tmp_path):
        supervisor = _make_supervisor(base_env)
        supervisor.repository_boot.repo_path = tmp_path
        _repoint_primary(supervisor.repository_boot)
        supervisor.repository_boot.synchronizer._ensure_plain_origin = AsyncMock(
            side_effect=RuntimeError("refresh failed")
        )
        supervisor.repository_boot.synchronizer.log.warn = MagicMock()

        result = await supervisor.repository_boot.synchronizer._update_existing_repo(
            supervisor.repository_boot.repositories[0], BootMode.SNAPSHOT_RESTORE
        )

        assert result is False
        supervisor.repository_boot.synchronizer.log.warn.assert_called_once()


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
        supervisor.repository_boot.repo_path = tmp_path / "nonexistent"
        _repoint_primary(supervisor.repository_boot)

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
            "sandbox_runtime.repository_sync.asyncio.create_subprocess_exec",
            side_effect=fake_subprocess,
        ):
            result = await supervisor.repository_boot.synchronizer._sync_repo(
                supervisor.repository_boot.repositories[0], BootMode.FRESH
            )

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
        supervisor.repository_boot.repo_path = tmp_path  # Exists, so clone is skipped
        _repoint_primary(supervisor.repository_boot)

        call_log = []

        async def fake_subprocess(*args, **kwargs):
            call_log.append(args)
            mock_proc = MagicMock()
            mock_proc.communicate = AsyncMock(return_value=(b"", b""))
            mock_proc.wait = AsyncMock(return_value=0)
            mock_proc.returncode = 0
            return mock_proc

        with patch(
            "sandbox_runtime.repository_sync.asyncio.create_subprocess_exec",
            side_effect=fake_subprocess,
        ):
            result = await supervisor.repository_boot.synchronizer._sync_repo(
                supervisor.repository_boot.repositories[0], BootMode.FRESH
            )

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
        supervisor.repository_boot.repo_path = tmp_path  # Exists
        _repoint_primary(supervisor.repository_boot)

        call_log = []

        async def fake_subprocess(*args, **kwargs):
            call_log.append(args)
            mock_proc = MagicMock()
            mock_proc.communicate = AsyncMock(return_value=(b"", b""))
            mock_proc.wait = AsyncMock(return_value=0)
            mock_proc.returncode = 0
            return mock_proc

        with patch(
            "sandbox_runtime.repository_sync.asyncio.create_subprocess_exec",
            side_effect=fake_subprocess,
        ):
            await supervisor.repository_boot.synchronizer._sync_repo(
                supervisor.repository_boot.repositories[0], BootMode.FRESH
            )

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
        supervisor.repository_boot.repo_path = tmp_path
        _repoint_primary(supervisor.repository_boot)
        supervisor.repository_boot.synchronizer.log = MagicMock()

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
            "sandbox_runtime.repository_sync.asyncio.create_subprocess_exec",
            side_effect=fake_subprocess,
        ):
            await getattr(supervisor.repository_boot.synchronizer, method_name)(
                supervisor.repository_boot.repositories[0], *args
            )

        log_call = getattr(supervisor.repository_boot.synchronizer.log, log_method_name).call_args
        assert log_call.args[0] == event_name
        # The generic `user:password@` regex masks the upstream creds.
        assert "other-secret" not in log_call.kwargs["stderr"]
        assert "https://***@example.com/acme/repo.git" in log_call.kwargs["stderr"]

    def test_redact_git_stderr_masks_userinfo_in_urls(self, base_env):
        supervisor = _make_supervisor(base_env)

        stderr_text = (
            b"fatal: redirected to https://other-user:other-secret@example.com/acme/my-repo.git"
        )

        redacted_stderr = supervisor.repository_boot.synchronizer._redact_git_stderr(stderr_text)

        assert "other-secret" not in redacted_stderr
        assert "https://***@example.com/acme/my-repo.git" in redacted_stderr

    def test_redact_git_stderr_replaces_malformed_bytes(self, base_env):
        supervisor = _make_supervisor(base_env)

        redacted_stderr = supervisor.repository_boot.synchronizer._redact_git_stderr(b"fatal: \xff")

        assert redacted_stderr == "fatal: �"


class TestBaseBranchProperty:
    """Test base_branch property reads from SESSION_CONFIG correctly."""

    def test_defaults_to_main(self, base_env):
        """Should default to 'main' when no branch in SESSION_CONFIG."""
        supervisor = _make_supervisor(base_env)
        assert supervisor.repository_boot.base_branch == "main"

    def test_reads_branch_from_session_config(self, base_env):
        """Should read branch from SESSION_CONFIG."""
        env = {**base_env, "SESSION_CONFIG": '{"branch": "develop"}'}
        supervisor = _make_supervisor(env)
        assert supervisor.repository_boot.base_branch == "develop"


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
        supervisor.repository_boot.synchronizer.log = MagicMock()

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
                "sandbox_runtime.repository_sync.asyncio.create_subprocess_exec",
                side_effect=fake_subprocess,
            ),
            patch("sandbox_runtime.repository_sync.Path.write_text"),
            patch("sandbox_runtime.repository_sync.Path.chmod"),
            patch("sandbox_runtime.repository_sync.Path.exists", return_value=False),
            patch.object(supervisor.repository_boot.synchronizer, "_install_gh_wrapper"),
        ):
            await supervisor.repository_boot.synchronizer.ensure_credentials_configured()

        assert all("--replace-all" in c for c in git_config_calls)
        pairs = {(c[4], c[5]) for c in git_config_calls}
        assert ("credential.helper", "/usr/local/bin/oi-git-credentials") in pairs
        assert ("credential.useHttpPath", "true") in pairs

    @pytest.mark.asyncio
    async def test_warns_when_credential_helper_shim_cannot_be_written(self, base_env):
        supervisor = _make_supervisor(base_env)
        supervisor.repository_boot.synchronizer.log = MagicMock()
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
                "sandbox_runtime.repository_sync.asyncio.create_subprocess_exec",
                side_effect=fake_subprocess,
            ),
            patch(
                "sandbox_runtime.repository_sync.Path.write_text", side_effect=OSError("read-only")
            ),
            patch("sandbox_runtime.repository_sync.Path.exists", return_value=False),
            patch.object(supervisor.repository_boot.synchronizer, "_install_gh_wrapper"),
        ):
            await supervisor.repository_boot.synchronizer.ensure_credentials_configured()

        supervisor.repository_boot.synchronizer.log.warn.assert_any_call(
            "credential_helper.shim_write_failed",
            error="read-only",
        )
        pairs = {(c[4], c[5]) for c in git_config_calls}
        assert ("credential.helper", "/usr/local/bin/oi-git-credentials") not in pairs
        assert ("credential.useHttpPath", "true") in pairs

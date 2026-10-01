"""Boot timing must distinguish returned failures from successful awaits."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.boot_timing import measure_boot_stage
from sandbox_runtime.repository_boot import RepositoryBoot
from sandbox_runtime.repository_sync import (
    RepositorySyncOutcome,
    RepositorySyncResult,
    RepositorySyncStatus,
)
from sandbox_runtime.runtime_config import BootMode, RepositoryConfig


@pytest.mark.parametrize("succeeded", [True, False])
def test_monotonic_duration_and_returned_outcome(succeeded):
    log = MagicMock()
    with (
        patch("sandbox_runtime.boot_timing.time.monotonic", side_effect=[10.0, 12.5]),
        measure_boot_stage(log, "setup", boot_mode="fresh", repository_index=0) as stage,
    ):
        stage.succeeded = succeeded
    log.info.assert_called_once_with(
        "boot.stage_completed",
        stage="setup",
        boot_mode="fresh",
        repository_index=0,
        outcome="succeeded" if succeeded else "failed",
        duration_seconds=2.5,
    )


@pytest.mark.parametrize(
    ("error", "outcome"),
    [(RuntimeError("secret text"), "failed"), (asyncio.CancelledError(), "cancelled")],
)
def test_exception_propagates_without_logging_contents(error, outcome):
    log = MagicMock()
    with (
        pytest.raises(type(error)),
        measure_boot_stage(log, "repository_sync", boot_mode="fresh"),
    ):
        raise error
    assert log.info.call_count == 1
    assert log.info.call_args.kwargs["outcome"] == outcome
    assert "secret text" not in str(log.info.call_args)


def test_provider_timing_carries_only_explicit_correlation():
    log = MagicMock()
    with measure_boot_stage(
        log,
        "provider_create",
        boot_mode="repo_image",
        image_source="repository",
        sandbox_id="launch-1",
    ):
        pass
    assert log.info.call_args.kwargs["sandbox_id"] == "launch-1"
    assert log.info.call_args.kwargs["image_source"] == "repository"


@pytest.fixture
def boot(tmp_path):
    config = RepositoryConfig(
        sandbox_id="test",
        repo_owner="acme",
        repo_name="repo",
        vcs_host="github.com",
        repositories=(),
        base_sha="",
        branch="main",
        working_branch_name="",
        workspace_path=tmp_path,
        repo_path=tmp_path / "repo",
    )
    synchronizer = MagicMock()
    synchronizer.ensure_credentials_configured = AsyncMock()
    hooks = MagicMock(
        run_setup=AsyncMock(return_value=True), run_start=AsyncMock(return_value=True)
    )
    tunnels = MagicMock(wait_until_ready=AsyncMock(return_value=True))
    result = RepositoryBoot(config, MagicMock(), MagicMock(), tunnels, hooks, synchronizer)
    result._write_repo_manifest = MagicMock()
    synchronizer.sync = AsyncMock(
        return_value=RepositorySyncResult(
            tuple(result.repositories),
            tuple(
                RepositorySyncOutcome(repo, RepositorySyncStatus.SUCCEEDED, tracked_clean=True)
                for repo in result.repositories
            ),
        )
    )
    return result


def stages(boot):
    return [
        call.kwargs
        for call in boot.log.info.call_args_list
        if call.args == ("boot.stage_completed",)
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", list(BootMode))
async def test_only_executed_stages_are_recorded(boot, mode):
    await boot.boot(mode, [])
    expected = ["credentials", "repository_sync"]
    if mode in (BootMode.FRESH, BootMode.BUILD, BootMode.REPO_IMAGE):
        expected.append("setup")
    if mode is not BootMode.BUILD:
        expected.extend(["tunnel_readiness", "start"])
    assert [stage["stage"] for stage in stages(boot)] == expected
    assert all(stage["outcome"] == "succeeded" for stage in stages(boot))


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", [BootMode.FRESH, BootMode.SNAPSHOT_RESTORE])
async def test_sync_returned_failure_is_not_success(boot, mode):
    boot.synchronizer.sync.return_value = RepositorySyncResult(
        tuple(boot.repositories),
        tuple(
            RepositorySyncOutcome(repo, RepositorySyncStatus.FAILED) for repo in boot.repositories
        ),
    )
    if mode is BootMode.FRESH:
        with pytest.raises(RuntimeError, match="git sync failed"):
            await boot.boot(mode, [])
    else:
        result = await boot.boot(mode, [])
        assert not result.git_sync_success
    assert stages(boot)[1]["outcome"] == "failed"


@pytest.mark.asyncio
@pytest.mark.parametrize("stage_name", ["setup", "start", "tunnel_readiness"])
async def test_hook_and_tunnel_returned_failures(boot, stage_name):
    if stage_name == "tunnel_readiness":
        boot.tunnel_environment.wait_until_ready.return_value = False
    else:
        getattr(boot.hooks, f"run_{stage_name}").return_value = False
    if stage_name == "start":
        with pytest.raises(RuntimeError, match="start hook failed"):
            await boot.boot(BootMode.FRESH, [])
    else:
        await boot.boot(BootMode.FRESH, [])
    assert (
        next(stage for stage in stages(boot) if stage["stage"] == stage_name)["outcome"] == "failed"
    )

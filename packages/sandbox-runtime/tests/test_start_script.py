"""Tests for RepositoryHooks.run_start() and strict repository boot integration."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.repository_boot import RepositoryBoot
from sandbox_runtime.repository_sync import (
    RepositorySyncOutcome,
    RepositorySyncResult,
    RepositorySyncStatus,
)
from sandbox_runtime.runtime_config import BootMode
from tests.runtime_helpers import make_repository_boot


def _make_repository_boot(tmp_path) -> RepositoryBoot:
    """Create a RepositoryBoot with repo_path pointing at tmp_path."""
    with patch.dict(
        "os.environ",
        {
            "SANDBOX_ID": "test-sandbox",
            "CONTROL_PLANE_URL": "https://cp.example.com",
            "SANDBOX_AUTH_TOKEN": "tok",
            "REPO_OWNER": "acme",
            "REPO_NAME": "app",
        },
        clear=True,
    ):
        sup = make_repository_boot()
    sup.workspace_path = tmp_path
    sup.repo_path = tmp_path / "app"
    sup.repositories = sup._parse_repositories()
    return sup


def _create_start_script(repo_path, content="#!/bin/bash\necho start\n"):
    """Create .openinspect/start.sh inside repo_path."""
    repo_path.mkdir(parents=True, exist_ok=True)
    setup_dir = repo_path / ".openinspect"
    setup_dir.mkdir(parents=True, exist_ok=True)
    script = setup_dir / "start.sh"
    script.write_text(content)
    return script


def _fake_process(returncode=0):
    """Return a mock async process."""
    proc = MagicMock()
    proc.returncode = returncode
    proc.communicate = AsyncMock(side_effect=AssertionError("hooks must wait for shell exit"))
    proc.kill = MagicMock()
    proc.wait = AsyncMock(return_value=returncode)
    proc.stdout = asyncio.StreamReader()
    proc.stdout.feed_eof()
    return proc


class TestStartScriptSkip:
    """Cases where the start script is not run."""

    async def test_skip_when_no_start_script(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        sup.repo_path.mkdir(parents=True, exist_ok=True)

        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock) as mock_exec:
            result = await sup.hooks.run_start(sup.repositories[0], BootMode.FRESH)

        assert result is True
        mock_exec.assert_not_called()

    async def test_skip_when_repo_path_missing(self, tmp_path):
        sup = _make_repository_boot(tmp_path)

        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock) as mock_exec:
            result = await sup.hooks.run_start(sup.repositories[0], BootMode.FRESH)

        assert result is True
        mock_exec.assert_not_called()


class TestStartScriptSuccess:
    """Cases where the start script runs successfully."""

    async def test_successful_run(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _create_start_script(sup.repo_path)
        fake_proc = _fake_process(returncode=0)

        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc
        ):
            result = await sup.hooks.run_start(sup.repositories[0], BootMode.FRESH)

        assert result is True

    async def test_bash_called_with_correct_args(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        script = _create_start_script(sup.repo_path)
        fake_proc = _fake_process(returncode=0)

        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc
        ) as mock_exec:
            await sup.hooks.run_start(sup.repositories[0], BootMode.FRESH)

        mock_exec.assert_called_once()
        call_args = mock_exec.call_args
        assert call_args[0][0] == "bash"
        assert call_args[0][1] == str(script)
        assert call_args[1]["cwd"] == sup.repo_path
        assert call_args[1]["stdout"] == asyncio.subprocess.PIPE
        assert call_args[1]["stderr"] == asyncio.subprocess.STDOUT
        fake_proc.wait.assert_awaited_once()
        fake_proc.communicate.assert_not_awaited()

    async def test_sets_boot_mode_env_for_script(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _create_start_script(sup.repo_path)
        fake_proc = _fake_process(returncode=0)

        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc
        ) as mock_exec:
            await sup.hooks.run_start(sup.repositories[0], BootMode.REPO_IMAGE)

        env_arg = mock_exec.call_args[1]["env"]
        assert env_arg["OPENINSPECT_BOOT_MODE"] == "repo_image"


class TestStartScriptFailure:
    """Cases where the start script fails."""

    async def test_nonzero_exit_returns_false(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _create_start_script(sup.repo_path, content="#!/bin/bash\nexit 1\n")
        fake_proc = _fake_process(returncode=1)

        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc
        ):
            result = await sup.hooks.run_start(sup.repositories[0], BootMode.FRESH)

        assert result is False

    async def test_exception_returns_false(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _create_start_script(sup.repo_path)

        with patch(
            "asyncio.create_subprocess_exec",
            new_callable=AsyncMock,
            side_effect=OSError("exec failed"),
        ):
            result = await sup.hooks.run_start(sup.repositories[0], BootMode.FRESH)

        assert result is False


class TestStartScriptWaitPolicy:
    """Start waits for the script instead of imposing a hook-specific deadline."""

    async def test_legacy_timeout_environment_does_not_bound_script(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _create_start_script(sup.repo_path)
        fake_proc = _fake_process(returncode=0)

        with (
            patch.dict("os.environ", {"START_TIMEOUT_SECONDS": "0"}, clear=False),
            patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc),
        ):
            result = await sup.hooks.run_start(sup.repositories[0], BootMode.FRESH)

        assert result is True
        fake_proc.wait.assert_awaited_once()
        fake_proc.communicate.assert_not_awaited()


class TestStartInRepositoryBootStrict:
    """Verify run() treats start script failures as fatal."""

    async def test_run_fails_fast_when_start_script_fails(self, tmp_path):
        sup = _make_repository_boot(tmp_path)

        sup.synchronizer.sync = AsyncMock(
            return_value=RepositorySyncResult(
                tuple(sup.repositories),
                tuple(
                    RepositorySyncOutcome(repo, RepositorySyncStatus.SUCCEEDED)
                    for repo in sup.repositories
                ),
            )
        )
        sup._write_repo_manifest = MagicMock()
        sup.synchronizer.ensure_credentials_configured = AsyncMock()
        sup.hooks.run_setup = AsyncMock(return_value=True)
        sup.hooks.run_start = AsyncMock(return_value=False)

        with pytest.raises(RuntimeError, match="start hook failed for acme/app"):
            await sup.boot(BootMode.FRESH, [])

        sup.hooks.run_start.assert_awaited_once()

"""Tests for RepositoryHooks.run_setup() and its integration in RepositoryBoot.boot()."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from sandbox_runtime.repository_boot import RepositoryBoot
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


def _create_setup_script(repo_path, content="#!/bin/bash\necho hello\n"):
    """Create .openinspect/setup.sh inside repo_path."""
    repo_path.mkdir(parents=True, exist_ok=True)
    setup_dir = repo_path / ".openinspect"
    setup_dir.mkdir(parents=True, exist_ok=True)
    script = setup_dir / "setup.sh"
    script.write_text(content)
    return script


def _fake_process(returncode=0, stdout=b""):
    """Return a mock async process."""
    proc = MagicMock()
    proc.returncode = returncode
    proc.communicate = AsyncMock(return_value=(stdout, None))
    proc.kill = MagicMock()
    proc.wait = AsyncMock()
    return proc


# ---------------------------------------------------------------------------
# TestSetupScriptSkip
# ---------------------------------------------------------------------------


class TestSetupScriptSkip:
    """Cases where the setup script is not run."""

    async def test_skip_when_no_setup_script(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        # repo_path exists but no .openinspect/setup.sh
        sup.repo_path.mkdir(parents=True, exist_ok=True)

        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock) as mock_exec:
            result = await sup.hooks.run_setup(sup.repositories[0], BootMode.FRESH)

        assert result is True
        mock_exec.assert_not_called()


# ---------------------------------------------------------------------------
# TestSetupScriptSuccess
# ---------------------------------------------------------------------------


class TestSetupScriptSuccess:
    """Cases where the setup script runs successfully."""

    async def test_bash_called_with_correct_args(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        script = _create_setup_script(sup.repo_path)
        fake_proc = _fake_process(returncode=0, stdout=b"ok\n")

        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc
        ) as mock_exec:
            await sup.hooks.run_setup(sup.repositories[0], BootMode.FRESH)

        mock_exec.assert_called_once()
        call_args = mock_exec.call_args
        assert call_args[0][0] == "bash"
        assert call_args[0][1] == str(script)
        assert call_args[1]["cwd"] == sup.repo_path

    async def test_inherits_environment(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _create_setup_script(sup.repo_path)
        fake_proc = _fake_process(returncode=0, stdout=b"")

        with (
            patch.dict("os.environ", {"MY_VAR": "hello"}, clear=False),
            patch(
                "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc
            ) as mock_exec,
        ):
            await sup.hooks.run_setup(sup.repositories[0], BootMode.FRESH)

        env_arg = mock_exec.call_args[1]["env"]
        assert "MY_VAR" in env_arg
        assert env_arg["MY_VAR"] == "hello"


# ---------------------------------------------------------------------------
# TestSetupScriptFailure
# ---------------------------------------------------------------------------


class TestSetupScriptFailure:
    """Cases where the setup script fails."""

    async def test_nonzero_exit_returns_false(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _create_setup_script(sup.repo_path, content="#!/bin/bash\nexit 1\n")
        fake_proc = _fake_process(returncode=1, stdout=b"error: something broke\n")

        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc
        ):
            result = await sup.hooks.run_setup(sup.repositories[0], BootMode.FRESH)

        assert result is False

    async def test_exception_returns_false(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _create_setup_script(sup.repo_path)

        with patch(
            "asyncio.create_subprocess_exec",
            new_callable=AsyncMock,
            side_effect=OSError("exec failed"),
        ):
            result = await sup.hooks.run_setup(sup.repositories[0], BootMode.FRESH)

        assert result is False

    async def test_build_failure_log_omits_hook_output(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        sup.hooks.log = MagicMock()
        _create_setup_script(sup.repo_path, content="#!/bin/bash\nexit 1\n")
        fake_proc = _fake_process(returncode=1, stdout=b"secret from repository hook\n")

        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc
        ):
            result = await sup.hooks.run_setup(sup.repositories[0], BootMode.BUILD)

        assert result is False
        failure = sup.hooks.log.error.call_args
        assert failure.args == ("setup.failed",)
        assert failure.kwargs["exit_code"] == 1
        assert "output_tail" not in failure.kwargs


# ---------------------------------------------------------------------------
# TestSetupScriptTimeout
# ---------------------------------------------------------------------------


class TestSetupScriptTimeout:
    """Timeout handling for the setup script."""

    async def test_timeout_kills_process(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _create_setup_script(sup.repo_path)
        fake_proc = _fake_process(returncode=None)
        fake_proc.communicate = AsyncMock(side_effect=TimeoutError)
        fake_proc.stdout = MagicMock()
        fake_proc.stdout.read = AsyncMock(return_value=b"partial output\n")

        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc
        ):
            result = await sup.hooks.run_setup(sup.repositories[0], BootMode.FRESH)

        assert result is False
        fake_proc.kill.assert_called_once()
        fake_proc.wait.assert_awaited_once()

    async def test_build_timeout_log_omits_hook_output(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        sup.hooks.log = MagicMock()
        _create_setup_script(sup.repo_path)
        fake_proc = _fake_process(returncode=None)
        fake_proc.communicate = AsyncMock(side_effect=TimeoutError)
        fake_proc.stdout = MagicMock()
        fake_proc.stdout.read = AsyncMock(return_value=b"secret partial output\n")

        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc
        ):
            result = await sup.hooks.run_setup(sup.repositories[0], BootMode.BUILD)

        assert result is False
        timeout = sup.hooks.log.error.call_args
        assert timeout.args == ("setup.timeout",)
        assert "output_tail" not in timeout.kwargs

    async def test_default_timeout_300(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _create_setup_script(sup.repo_path)
        fake_proc = _fake_process(returncode=0, stdout=b"ok\n")
        captured_timeout = {}

        original_wait_for = asyncio.wait_for

        async def capturing_wait_for(coro, *, timeout=None):
            captured_timeout["value"] = timeout
            return await original_wait_for(coro, timeout=timeout)

        with (
            patch.dict("os.environ", {}, clear=False),
            patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc),
            patch("asyncio.wait_for", side_effect=capturing_wait_for),
        ):
            import os

            os.environ.pop("SETUP_TIMEOUT_SECONDS", None)
            await sup.hooks.run_setup(sup.repositories[0], BootMode.FRESH)

        assert captured_timeout["value"] == 300

    async def test_custom_timeout_from_env(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _create_setup_script(sup.repo_path)
        fake_proc = _fake_process(returncode=0, stdout=b"ok\n")
        captured_timeout = {}

        original_wait_for = asyncio.wait_for

        async def capturing_wait_for(coro, *, timeout=None):
            captured_timeout["value"] = timeout
            return await original_wait_for(coro, timeout=timeout)

        with (
            patch.dict("os.environ", {"SETUP_TIMEOUT_SECONDS": "60"}, clear=False),
            patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc),
            patch("asyncio.wait_for", side_effect=capturing_wait_for),
        ):
            await sup.hooks.run_setup(sup.repositories[0], BootMode.FRESH)

        assert captured_timeout["value"] == 60

    async def test_invalid_timeout_env_uses_default(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _create_setup_script(sup.repo_path)
        fake_proc = _fake_process(returncode=0, stdout=b"ok\n")
        captured_timeout = {}

        original_wait_for = asyncio.wait_for

        async def capturing_wait_for(coro, *, timeout=None):
            captured_timeout["value"] = timeout
            return await original_wait_for(coro, timeout=timeout)

        with (
            patch.dict("os.environ", {"SETUP_TIMEOUT_SECONDS": "not_a_number"}, clear=False),
            patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc),
            patch("asyncio.wait_for", side_effect=capturing_wait_for),
        ):
            result = await sup.hooks.run_setup(sup.repositories[0], BootMode.FRESH)

        assert result is True
        assert captured_timeout["value"] == 300


# ---------------------------------------------------------------------------
# TestSetupInRun (integration)
# ---------------------------------------------------------------------------


class TestSetupInRepositoryBoot:
    """Verify setup hooks run at the right point in repository boot."""

    async def test_run_skips_setup_on_snapshot_restore(self, tmp_path):
        sup = _make_repository_boot(tmp_path)

        sup._write_repo_manifest = MagicMock()
        sup._write_workspace_manifest = MagicMock()
        sup.synchronizer.ensure_credentials_configured = AsyncMock()
        from sandbox_runtime.repository_sync import RepositorySyncResult

        sup.synchronizer.sync = AsyncMock(
            return_value=RepositorySyncResult(tuple(sup.repositories), ())
        )
        sup.hooks.run_setup = AsyncMock(return_value=True)
        sup.hooks.run_start = AsyncMock(return_value=True)

        await sup.boot(BootMode.SNAPSHOT_RESTORE, [])

        sup.hooks.run_setup.assert_not_called()
        sup.hooks.run_start.assert_called_once_with(sup.repositories[0], BootMode.SNAPSHOT_RESTORE)

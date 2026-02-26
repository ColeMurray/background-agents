"""Tests for SandboxSupervisor.run_start_script() and strict startup integration."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from src.sandbox.entrypoint import SandboxSupervisor


def _make_supervisor(tmp_path) -> SandboxSupervisor:
    """Create a SandboxSupervisor with repo_path pointing at tmp_path."""
    with patch.dict(
        "os.environ",
        {
            "SANDBOX_ID": "test-sandbox",
            "CONTROL_PLANE_URL": "https://cp.example.com",
            "SANDBOX_AUTH_TOKEN": "tok",
            "REPO_OWNER": "acme",
            "REPO_NAME": "app",
        },
    ):
        sup = SandboxSupervisor()
    sup.repo_path = tmp_path / "app"
    return sup


def _create_start_script(repo_path, content="#!/bin/bash\necho start\n"):
    """Create .openinspect/start.sh inside repo_path."""
    repo_path.mkdir(parents=True, exist_ok=True)
    setup_dir = repo_path / ".openinspect"
    setup_dir.mkdir(parents=True, exist_ok=True)
    script = setup_dir / "start.sh"
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


class TestStartScriptSkip:
    """Cases where the start script is not run."""

    async def test_skip_when_no_start_script(self, tmp_path):
        sup = _make_supervisor(tmp_path)
        sup.repo_path.mkdir(parents=True, exist_ok=True)

        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock) as mock_exec:
            result = await sup.run_start_script()

        assert result is True
        mock_exec.assert_not_called()

    async def test_skip_when_repo_path_missing(self, tmp_path):
        sup = _make_supervisor(tmp_path)

        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock) as mock_exec:
            result = await sup.run_start_script()

        assert result is True
        mock_exec.assert_not_called()


class TestStartScriptSuccess:
    """Cases where the start script runs successfully."""

    async def test_successful_run(self, tmp_path):
        sup = _make_supervisor(tmp_path)
        _create_start_script(sup.repo_path)
        fake_proc = _fake_process(returncode=0, stdout=b"started\n")

        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc
        ):
            result = await sup.run_start_script()

        assert result is True

    async def test_bash_called_with_correct_args(self, tmp_path):
        sup = _make_supervisor(tmp_path)
        script = _create_start_script(sup.repo_path)
        fake_proc = _fake_process(returncode=0, stdout=b"ok\n")

        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc
        ) as mock_exec:
            await sup.run_start_script()

        mock_exec.assert_called_once()
        call_args = mock_exec.call_args
        assert call_args[0][0] == "bash"
        assert call_args[0][1] == str(script)
        assert call_args[1]["cwd"] == sup.repo_path

    async def test_sets_boot_mode_env_for_script(self, tmp_path):
        sup = _make_supervisor(tmp_path)
        _create_start_script(sup.repo_path)
        sup.boot_mode = "repo_image"
        fake_proc = _fake_process(returncode=0, stdout=b"ok\n")

        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc
        ) as mock_exec:
            await sup.run_start_script()

        env_arg = mock_exec.call_args[1]["env"]
        assert env_arg["OPENINSPECT_BOOT_MODE"] == "repo_image"


class TestStartScriptFailure:
    """Cases where the start script fails."""

    async def test_nonzero_exit_returns_false(self, tmp_path):
        sup = _make_supervisor(tmp_path)
        _create_start_script(sup.repo_path, content="#!/bin/bash\nexit 1\n")
        fake_proc = _fake_process(returncode=1, stdout=b"start failed\n")

        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc
        ):
            result = await sup.run_start_script()

        assert result is False

    async def test_exception_returns_false(self, tmp_path):
        sup = _make_supervisor(tmp_path)
        _create_start_script(sup.repo_path)

        with patch(
            "asyncio.create_subprocess_exec",
            new_callable=AsyncMock,
            side_effect=OSError("exec failed"),
        ):
            result = await sup.run_start_script()

        assert result is False


class TestStartScriptTimeout:
    """Timeout handling for the start script."""

    async def test_timeout_kills_process(self, tmp_path):
        sup = _make_supervisor(tmp_path)
        _create_start_script(sup.repo_path)
        fake_proc = _fake_process()
        fake_proc.communicate = AsyncMock(side_effect=TimeoutError)
        fake_proc.stdout = MagicMock()
        fake_proc.stdout.read = AsyncMock(return_value=b"partial output\n")

        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc
        ):
            result = await sup.run_start_script()

        assert result is False
        fake_proc.kill.assert_called_once()
        fake_proc.wait.assert_awaited_once()

    async def test_default_timeout_120(self, tmp_path):
        sup = _make_supervisor(tmp_path)
        _create_start_script(sup.repo_path)
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

            os.environ.pop("START_TIMEOUT_SECONDS", None)
            await sup.run_start_script()

        assert captured_timeout["value"] == 120

    async def test_custom_timeout_from_env(self, tmp_path):
        sup = _make_supervisor(tmp_path)
        _create_start_script(sup.repo_path)
        fake_proc = _fake_process(returncode=0, stdout=b"ok\n")
        captured_timeout = {}

        original_wait_for = asyncio.wait_for

        async def capturing_wait_for(coro, *, timeout=None):
            captured_timeout["value"] = timeout
            return await original_wait_for(coro, timeout=timeout)

        with (
            patch.dict("os.environ", {"START_TIMEOUT_SECONDS": "45"}, clear=False),
            patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc),
            patch("asyncio.wait_for", side_effect=capturing_wait_for),
        ):
            await sup.run_start_script()

        assert captured_timeout["value"] == 45


class TestStartInRunStrict:
    """Verify run() treats start script failures as fatal."""

    async def test_run_fails_fast_when_start_script_fails(self, tmp_path):
        sup = _make_supervisor(tmp_path)

        sup.perform_git_sync = AsyncMock(return_value=True)
        sup.run_setup_script = AsyncMock(return_value=True)
        sup.run_start_script = AsyncMock(return_value=False)
        sup.start_opencode = AsyncMock()
        sup.start_bridge = AsyncMock()
        sup.monitor_processes = AsyncMock()
        sup.shutdown = AsyncMock()
        sup._report_fatal_error = AsyncMock()

        with patch("asyncio.get_event_loop") as mock_loop:
            mock_loop.return_value.add_signal_handler = MagicMock()
            await sup.run()

        sup._report_fatal_error.assert_called_once()
        sup.start_opencode.assert_not_called()
        sup.start_bridge.assert_not_called()

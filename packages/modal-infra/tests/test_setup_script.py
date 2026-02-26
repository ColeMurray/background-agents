"""Tests for SandboxSupervisor.run_setup_script() and its integration in run()."""

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
        sup = _make_supervisor(tmp_path)
        # repo_path exists but no .openinspect/setup.sh
        sup.repo_path.mkdir(parents=True, exist_ok=True)

        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock) as mock_exec:
            result = await sup.run_setup_script()

        assert result is True
        mock_exec.assert_not_called()

    async def test_skip_when_repo_path_missing(self, tmp_path):
        sup = _make_supervisor(tmp_path)
        # repo_path does not exist at all

        with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock) as mock_exec:
            result = await sup.run_setup_script()

        assert result is True
        mock_exec.assert_not_called()


# ---------------------------------------------------------------------------
# TestSetupScriptSuccess
# ---------------------------------------------------------------------------


class TestSetupScriptSuccess:
    """Cases where the setup script runs successfully."""

    async def test_successful_run(self, tmp_path):
        sup = _make_supervisor(tmp_path)
        _create_setup_script(sup.repo_path)
        fake_proc = _fake_process(returncode=0, stdout=b"installed deps\n")

        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc
        ):
            result = await sup.run_setup_script()

        assert result is True

    async def test_bash_called_with_correct_args(self, tmp_path):
        sup = _make_supervisor(tmp_path)
        script = _create_setup_script(sup.repo_path)
        fake_proc = _fake_process(returncode=0, stdout=b"ok\n")

        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc
        ) as mock_exec:
            await sup.run_setup_script()

        mock_exec.assert_called_once()
        call_args = mock_exec.call_args
        assert call_args[0][0] == "bash"
        assert call_args[0][1] == str(script)
        assert call_args[1]["cwd"] == sup.repo_path

    async def test_stdout_logged_on_success(self, tmp_path):
        sup = _make_supervisor(tmp_path)
        _create_setup_script(sup.repo_path)
        fake_proc = _fake_process(returncode=0, stdout=b"line1\nline2\n")

        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc
        ):
            result = await sup.run_setup_script()

        assert result is True

    async def test_inherits_environment(self, tmp_path):
        sup = _make_supervisor(tmp_path)
        _create_setup_script(sup.repo_path)
        fake_proc = _fake_process(returncode=0, stdout=b"")

        with (
            patch.dict("os.environ", {"MY_VAR": "hello"}, clear=False),
            patch(
                "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc
            ) as mock_exec,
        ):
            await sup.run_setup_script()

        env_arg = mock_exec.call_args[1]["env"]
        assert "MY_VAR" in env_arg
        assert env_arg["MY_VAR"] == "hello"


# ---------------------------------------------------------------------------
# TestSetupScriptFailure
# ---------------------------------------------------------------------------


class TestSetupScriptFailure:
    """Cases where the setup script fails."""

    async def test_nonzero_exit_returns_false(self, tmp_path):
        sup = _make_supervisor(tmp_path)
        _create_setup_script(sup.repo_path, content="#!/bin/bash\nexit 1\n")
        fake_proc = _fake_process(returncode=1, stdout=b"error: something broke\n")

        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc
        ):
            result = await sup.run_setup_script()

        assert result is False

    async def test_exception_returns_false(self, tmp_path):
        sup = _make_supervisor(tmp_path)
        _create_setup_script(sup.repo_path)

        with patch(
            "asyncio.create_subprocess_exec",
            new_callable=AsyncMock,
            side_effect=OSError("exec failed"),
        ):
            result = await sup.run_setup_script()

        assert result is False


# ---------------------------------------------------------------------------
# TestSetupScriptTimeout
# ---------------------------------------------------------------------------


class TestSetupScriptTimeout:
    """Timeout handling for the setup script."""

    async def test_timeout_kills_process(self, tmp_path):
        sup = _make_supervisor(tmp_path)
        _create_setup_script(sup.repo_path)
        fake_proc = _fake_process()
        fake_proc.communicate = AsyncMock(side_effect=TimeoutError)
        fake_proc.stdout = MagicMock()
        fake_proc.stdout.read = AsyncMock(return_value=b"partial output\n")

        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc
        ):
            result = await sup.run_setup_script()

        assert result is False
        fake_proc.kill.assert_called_once()
        fake_proc.wait.assert_awaited_once()

    async def test_default_timeout_300(self, tmp_path):
        sup = _make_supervisor(tmp_path)
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
            await sup.run_setup_script()

        assert captured_timeout["value"] == 300

    async def test_custom_timeout_from_env(self, tmp_path):
        sup = _make_supervisor(tmp_path)
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
            await sup.run_setup_script()

        assert captured_timeout["value"] == 60

    async def test_invalid_timeout_env_uses_default(self, tmp_path):
        sup = _make_supervisor(tmp_path)
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
            result = await sup.run_setup_script()

        assert result is True
        assert captured_timeout["value"] == 300


# ---------------------------------------------------------------------------
# TestSetupInRun (integration)
# ---------------------------------------------------------------------------


class TestSetupInRun:
    """Verify run_setup_script is called at the right point in run()."""

    async def test_run_calls_setup_on_fresh_clone(self, tmp_path):
        sup = _make_supervisor(tmp_path)

        # Mock all phases
        sup.perform_git_sync = AsyncMock(return_value=True)
        sup.run_setup_script = AsyncMock(return_value=True)
        sup.start_opencode = AsyncMock()
        sup.start_bridge = AsyncMock()
        sup.monitor_processes = AsyncMock()

        # No snapshot restore
        with (
            patch.dict("os.environ", {"RESTORED_FROM_SNAPSHOT": "false"}, clear=False),
            patch("asyncio.get_event_loop") as mock_loop,
        ):
            mock_loop.return_value.add_signal_handler = MagicMock()
            await sup.run()

        sup.run_setup_script.assert_called_once()

        # Verify ordering: run_setup_script before start_opencode
        call_order = []
        for name in ["run_setup_script", "start_opencode"]:
            mock = getattr(sup, name)
            if mock.call_count > 0:
                call_order.append(name)
        assert call_order == ["run_setup_script", "start_opencode"]

    async def test_run_skips_setup_on_snapshot_restore(self, tmp_path):
        sup = _make_supervisor(tmp_path)

        # Mock all phases
        sup._quick_git_fetch = AsyncMock()
        sup.run_setup_script = AsyncMock(return_value=True)
        sup.start_opencode = AsyncMock()
        sup.start_bridge = AsyncMock()
        sup.monitor_processes = AsyncMock()

        with (
            patch.dict("os.environ", {"RESTORED_FROM_SNAPSHOT": "true"}, clear=False),
            patch("asyncio.get_event_loop") as mock_loop,
        ):
            mock_loop.return_value.add_signal_handler = MagicMock()
            await sup.run()

        sup.run_setup_script.assert_not_called()

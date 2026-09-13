"""Tests for RepositoryHooks.run_setup() and its integration in RepositoryBoot.boot()."""

import asyncio
import contextlib
import os
import signal
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.process_output import PROCESS_OUTPUT_TAIL_BYTES
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


def _background_writer_script(*, exit_code: int) -> str:
    return (
        "#!/bin/bash\n"
        f'"{sys.executable}" -c \'import os,time\n'
        "while True:\n"
        '    os.write(1, b"x" * 4095 + b"\\n")\n'
        "    time.sleep(0.01)' &\n"
        "echo $! > child.pid\n"
        "echo diagnostic\n"
        f"exit {exit_code}\n"
    )


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
        fake_proc = _fake_process(returncode=0)

        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc
        ) as mock_exec:
            await sup.hooks.run_setup(sup.repositories[0], BootMode.FRESH)

        mock_exec.assert_called_once()
        call_args = mock_exec.call_args
        assert call_args[0][0] == "bash"
        assert call_args[0][1] == str(script)
        assert call_args[1]["cwd"] == sup.repo_path
        assert call_args[1]["stdout"] == asyncio.subprocess.PIPE
        assert call_args[1]["stderr"] == asyncio.subprocess.STDOUT
        fake_proc.wait.assert_awaited_once()
        fake_proc.communicate.assert_not_awaited()

    async def test_inherits_environment(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _create_setup_script(sup.repo_path)
        fake_proc = _fake_process(returncode=0)

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
        fake_proc = _fake_process(returncode=1)

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
        fake_proc = _fake_process(returncode=1)

        with patch(
            "asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc
        ):
            result = await sup.hooks.run_setup(sup.repositories[0], BootMode.BUILD)

        assert result is False
        failure = sup.hooks.log.error.call_args
        assert failure.args == ("setup.failed",)
        assert failure.kwargs["exit_code"] == 1
        assert "output_tail" not in failure.kwargs

    async def test_fresh_failure_log_preserves_hook_output_tail(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        sup.hooks.log = MagicMock()
        _create_setup_script(sup.repo_path, content="#!/bin/bash\necho diagnostic\nexit 1\n")

        result = await sup.hooks.run_setup(sup.repositories[0], BootMode.FRESH)

        assert result is False
        failure = sup.hooks.log.error.call_args
        assert failure.args == ("setup.failed",)
        assert failure.kwargs["output_tail"] == "diagnostic"

    async def test_failed_hook_stops_background_writer_before_reading_bounded_tail(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        sup.hooks.log = MagicMock()
        _create_setup_script(sup.repo_path, content=_background_writer_script(exit_code=1))
        child_pid = None

        try:
            async with asyncio.timeout(2):
                result = await sup.hooks.run_setup(sup.repositories[0], BootMode.FRESH)
            child_pid = int((sup.repo_path / "child.pid").read_text())
            output_tail = sup.hooks.log.error.call_args.kwargs["output_tail"]
            assert result is False
            assert "diagnostic" in output_tail
            assert len(output_tail.encode()) <= PROCESS_OUTPUT_TAIL_BYTES
        finally:
            if child_pid is not None:
                with contextlib.suppress(ProcessLookupError):
                    os.kill(child_pid, signal.SIGKILL)


# ---------------------------------------------------------------------------
# TestSetupScriptWaitPolicy
# ---------------------------------------------------------------------------


class TestSetupScriptWaitPolicy:
    """Setup waits for the script instead of imposing a hook-specific deadline."""

    async def test_legacy_timeout_environment_does_not_bound_script(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _create_setup_script(sup.repo_path)
        fake_proc = _fake_process(returncode=0)

        with (
            patch.dict("os.environ", {"SETUP_TIMEOUT_SECONDS": "0"}, clear=False),
            patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc),
        ):
            result = await sup.hooks.run_setup(sup.repositories[0], BootMode.FRESH)

        assert result is True
        fake_proc.wait.assert_awaited_once()
        fake_proc.communicate.assert_not_awaited()

    async def test_background_child_does_not_delay_shell_completion(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _create_setup_script(
            sup.repo_path,
            content=_background_writer_script(exit_code=0),
        )
        child_pid = None

        try:
            async with asyncio.timeout(2):
                result = await sup.hooks.run_setup(sup.repositories[0], BootMode.FRESH)
            child_pid = int((sup.repo_path / "child.pid").read_text())
            assert result is True
            await asyncio.sleep(0.1)
            os.kill(child_pid, 0)
            assert sup.hooks._output_collectors
        finally:
            if child_pid is not None:
                with contextlib.suppress(ProcessLookupError):
                    os.kill(child_pid, signal.SIGKILL)

    async def test_cancellation_stops_the_hook_process_group(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _create_setup_script(sup.repo_path)
        fake_proc = _fake_process(returncode=None)
        fake_proc.pid = 12345
        wait_started = asyncio.Event()
        wait_calls = 0

        async def wait():
            nonlocal wait_calls
            wait_calls += 1
            if wait_calls == 1:
                wait_started.set()
                await asyncio.Event().wait()
            fake_proc.returncode = -signal.SIGKILL
            return fake_proc.returncode

        fake_proc.wait.side_effect = wait
        with (
            patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc),
            patch("sandbox_runtime.repository_hooks.os.killpg") as kill_process_group,
        ):
            task = asyncio.create_task(sup.hooks.run_setup(sup.repositories[0], BootMode.FRESH))
            await asyncio.wait_for(wait_started.wait(), timeout=1)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

        kill_process_group.assert_called_once_with(12345, signal.SIGKILL)
        assert wait_calls == 2


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
        from sandbox_runtime.repository_sync import (
            RepositorySyncOutcome,
            RepositorySyncResult,
            RepositorySyncStatus,
        )

        sup.synchronizer.sync = AsyncMock(
            return_value=RepositorySyncResult(
                tuple(sup.repositories),
                tuple(
                    RepositorySyncOutcome(repo, RepositorySyncStatus.SUCCEEDED)
                    for repo in sup.repositories
                ),
            )
        )
        sup.hooks.run_setup = AsyncMock(return_value=True)
        sup.hooks.run_start = AsyncMock(return_value=True)

        await sup.boot(BootMode.SNAPSHOT_RESTORE, [])

        sup.hooks.run_setup.assert_not_called()
        sup.hooks.run_start.assert_called_once_with(sup.repositories[0], BootMode.SNAPSHOT_RESTORE)

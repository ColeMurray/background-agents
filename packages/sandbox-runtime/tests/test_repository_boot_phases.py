"""Boot phases reported by RepositoryBoot and the failure tail hooks retain.

Phases are the supervisor's side of the early-connect contract: the bridge
relays each line as a ``boot_progress`` event, and a fatal phase carries the
failing script's bounded, redacted output tail to the control plane.
"""

import json
import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime import boot_events
from sandbox_runtime.boot_events import BootPhaseError
from sandbox_runtime.process_output import PROCESS_OUTPUT_TAIL_BYTES
from sandbox_runtime.repository_sync import RepositorySyncStatus
from sandbox_runtime.runtime_config import BootMode
from tests.test_multi_repo_workspace import (
    _make_repository_boot,
    _mock_repository_boot,
    _sync_result,
)


def _all_lines() -> list[dict]:
    path = Path(boot_events.BOOT_EVENTS_FILE_PATH)
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines()]


def _phase_lines() -> list[tuple]:
    return [
        (line["phase"], line["status"], line.get("repoName"))
        for line in _all_lines()
        if line["kind"] == "phase"
    ]


class TestPhaseOrder:
    async def test_fresh_two_repository_boot_reports_every_phase_in_order(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _mock_repository_boot(sup)

        await sup.boot(BootMode.FRESH, [])

        assert _phase_lines() == [
            ("sync", "started", None),
            ("sync", "completed", None),
            ("setup", "started", "frontend"),
            ("setup", "completed", "frontend"),
            ("setup", "started", "backend"),
            ("setup", "completed", "backend"),
            ("start", "started", "frontend"),
            ("start", "completed", "frontend"),
            ("start", "started", "backend"),
            ("start", "completed", "backend"),
        ]
        assert [line["seq"] for line in _all_lines()] == list(range(1, 11))

    async def test_snapshot_restore_skips_setup(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _mock_repository_boot(sup)

        with patch.dict(os.environ, {"RESTORED_FROM_SNAPSHOT": "true"}, clear=False):
            await sup.boot(BootMode.SNAPSHOT_RESTORE, [])

        assert [phase for phase, _status, _repo in _phase_lines()] == [
            "sync",
            "sync",
            "start",
            "start",
            "start",
            "start",
        ]

    async def test_build_mode_writes_no_phases(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _mock_repository_boot(sup)

        await sup.boot(BootMode.BUILD, [])

        assert _all_lines() == []


class TestToleratedFailures:
    async def test_setup_failure_completes_with_a_warning_after_the_warning_line(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _mock_repository_boot(sup)
        sup.hooks.run_setup = AsyncMock(side_effect=[False, True])

        await sup.boot(BootMode.FRESH, [])

        lines = _all_lines()
        frontend = [line for line in lines if line.get("repoName") == "frontend"]
        assert [(line["kind"], line.get("status")) for line in frontend[:3]] == [
            ("phase", "started"),
            ("warning", None),
            ("phase", "completed"),
        ]
        assert frontend[1]["scope"] == "setup"
        assert frontend[2]["warning"] is True
        backend_setup = next(
            line
            for line in lines
            if line.get("repoName") == "backend" and line.get("status") == "completed"
        )
        assert "warning" not in backend_setup

    async def test_restore_sync_failure_completes_sync_with_a_warning(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _mock_repository_boot(sup)
        sup.synchronizer.sync = AsyncMock(
            return_value=_sync_result(
                sup.repositories,
                (RepositorySyncStatus.SUCCEEDED, RepositorySyncStatus.FAILED),
            )
        )

        with patch.dict(os.environ, {"RESTORED_FROM_SNAPSHOT": "true"}, clear=False):
            await sup.boot(BootMode.SNAPSHOT_RESTORE, [])

        sync_completed = next(
            line
            for line in _all_lines()
            if line.get("phase") == "sync" and line["status"] == "completed"
        )
        assert sync_completed["warning"] is True


class TestFatalFailures:
    async def test_primary_start_failure_fails_the_phase_with_its_tail(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _mock_repository_boot(sup)
        sup.hooks.run_start = AsyncMock(return_value=False)
        sup.hooks.failure_tail = MagicMock(return_value=("npm ERR! missing script: dev",))

        with pytest.raises(RuntimeError, match="start hook failed for acme/frontend") as raised:
            await sup.boot(BootMode.FRESH, [])

        error = raised.value
        assert isinstance(error, BootPhaseError)
        assert error.phase == "start"
        assert (error.repo_owner, error.repo_name) == ("acme", "frontend")
        assert error.output_tail == ("npm ERR! missing script: dev",)
        sup.hooks.failure_tail.assert_called_once_with(sup.repositories[0], "start")
        failed = _all_lines()[-1]
        assert (failed["phase"], failed["status"]) == ("start", "failed")
        assert failed["outputTail"] == ["npm ERR! missing script: dev"]
        assert failed["repoName"] == "frontend"
        assert error.boot_seq == failed["seq"]

    async def test_fresh_sync_failure_fails_the_sync_phase(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _mock_repository_boot(sup)
        sup.synchronizer.sync = AsyncMock(
            return_value=_sync_result(
                sup.repositories,
                (RepositorySyncStatus.SUCCEEDED, RepositorySyncStatus.FAILED),
            )
        )

        with pytest.raises(BootPhaseError) as raised:
            await sup.boot(BootMode.FRESH, [])

        assert raised.value.phase == "sync"
        assert raised.value.repo_owner is None
        failed = _all_lines()[-1]
        assert (failed["phase"], failed["status"]) == ("sync", "failed")
        assert failed["detail"] == "git sync failed for acme/backend"


class TestHookFailureTail:
    def _boot(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        sup.repo_path = tmp_path / "frontend"
        return sup

    async def test_failed_hook_retains_a_redacted_bounded_tail(self, tmp_path, monkeypatch):
        sup = self._boot(tmp_path)
        repo = sup.repositories[0]
        script_dir = repo.path / ".openinspect"
        script_dir.mkdir(parents=True)
        (script_dir / "start.sh").write_text(
            "#!/bin/bash\n"
            'for i in $(seq 1 80); do echo "line $i"; done\n'
            'echo "token=$NPM_TOKEN"\n'
            "exit 3\n"
        )
        monkeypatch.setenv("NPM_TOKEN", "npm_secret_value_123")

        assert await sup.hooks.run_start(repo, BootMode.FRESH) is False

        tail = sup.hooks.failure_tail(repo, "start")
        assert len(tail) == boot_events.OUTPUT_TAIL_MAX_LINES
        assert tail[-1] == "token=***"
        assert tail[0] == "line 22"
        assert "npm_secret_value_123" not in "\n".join(tail)

    async def test_a_secret_cut_by_the_output_window_leaves_no_fragment(
        self, tmp_path, monkeypatch
    ):
        """The collector keeps the last 64 KiB; a secret straddling its start must not leak."""
        sup = self._boot(tmp_path)
        repo = sup.repositories[0]
        script_dir = repo.path / ".openinspect"
        script_dir.mkdir(parents=True)
        secret = "npm_" + "s" * 40
        # Exactly enough output after the secret for the window to start
        # part way through it.
        trailing = PROCESS_OUTPUT_TAIL_BYTES - 30
        (script_dir / "start.sh").write_text(
            "#!/bin/bash\n"
            'printf "%s" "$NPM_TOKEN"\n'
            f"head -c {trailing} /dev/zero | tr '\\0' z\n"
            "echo\n"
            "echo after\n"
            "exit 3\n"
        )
        monkeypatch.setenv("NPM_TOKEN", secret)
        sup.hooks.log = MagicMock()

        assert await sup.hooks.run_start(repo, BootMode.FRESH) is False

        tail = sup.hooks.failure_tail(repo, "start")
        assert tail == ("after",)
        logged = json.dumps(sup.hooks.log.error.call_args.kwargs)
        assert all(secret[i:] not in logged for i in range(1, len(secret) - 3))

    async def test_tail_is_empty_without_a_failure(self, tmp_path):
        sup = self._boot(tmp_path)
        repo = sup.repositories[0]

        assert sup.hooks.failure_tail(repo, "start") == ()

    async def test_the_structured_log_carries_the_redacted_tail_too(self, tmp_path, monkeypatch):
        """The runtime's stdout is the provider log an operator reads; no credentials there."""
        sup = self._boot(tmp_path)
        repo = sup.repositories[0]
        script_dir = repo.path / ".openinspect"
        script_dir.mkdir(parents=True)
        (script_dir / "start.sh").write_text('#!/bin/bash\necho "token=$NPM_TOKEN"\nexit 3\n')
        monkeypatch.setenv("NPM_TOKEN", "npm_secret_value_123")
        sup.hooks.log = MagicMock()

        assert await sup.hooks.run_start(repo, BootMode.FRESH) is False

        failed = next(
            call for call in sup.hooks.log.error.call_args_list if call.args == ("start.failed",)
        )
        assert failed.kwargs["output_tail"] == "token=***"
        assert "npm_secret_value_123" not in json.dumps(failed.kwargs)

    async def test_a_hook_that_cannot_run_does_not_report_an_earlier_tail(self, tmp_path):
        sup = self._boot(tmp_path)
        repo = sup.repositories[0]
        script_dir = repo.path / ".openinspect"
        script_dir.mkdir(parents=True)
        script = script_dir / "start.sh"
        script.write_text("#!/bin/bash\necho boom\nexit 1\n")
        await sup.hooks.run_start(repo, BootMode.FRESH)
        assert sup.hooks.failure_tail(repo, "start") == ("boom",)

        # A spawn failure reports no tail of its own; it must not report the
        # previous run's output as if it were this one's.
        sup.hooks._collect_output = MagicMock(side_effect=RuntimeError("no output pipe"))
        assert await sup.hooks.run_start(repo, BootMode.FRESH) is False

        assert sup.hooks.failure_tail(repo, "start") == ()

    async def test_a_build_mode_failure_does_not_report_an_earlier_tail(self, tmp_path):
        sup = self._boot(tmp_path)
        repo = sup.repositories[0]
        script_dir = repo.path / ".openinspect"
        script_dir.mkdir(parents=True)
        script = script_dir / "setup.sh"
        script.write_text("#!/bin/bash\necho boom\nexit 1\n")
        await sup.hooks.run_setup(repo, BootMode.FRESH)
        assert sup.hooks.failure_tail(repo, "setup") == ("boom",)

        assert await sup.hooks.run_setup(repo, BootMode.BUILD) is False

        assert sup.hooks.failure_tail(repo, "setup") == ()

    async def test_success_clears_an_earlier_failure_tail(self, tmp_path):
        sup = self._boot(tmp_path)
        repo = sup.repositories[0]
        script_dir = repo.path / ".openinspect"
        script_dir.mkdir(parents=True)
        script = script_dir / "start.sh"
        script.write_text("#!/bin/bash\necho boom\nexit 1\n")
        await sup.hooks.run_start(repo, BootMode.FRESH)
        assert sup.hooks.failure_tail(repo, "start") == ("boom",)

        script.write_text("#!/bin/bash\nexit 0\n")
        assert await sup.hooks.run_start(repo, BootMode.FRESH) is True

        assert sup.hooks.failure_tail(repo, "start") == ()

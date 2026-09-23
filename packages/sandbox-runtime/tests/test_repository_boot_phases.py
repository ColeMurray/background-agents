"""Boot phases reported by RepositoryBoot.

Phases are the supervisor's side of the early-connect contract: the bridge
relays each line as a ``boot_progress`` event.
"""

import json
import os
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from sandbox_runtime import boot_events
from sandbox_runtime.boot_events import BootPhaseError
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
    async def test_primary_start_failure_fails_the_phase_with_metadata(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _mock_repository_boot(sup)
        sup.hooks.run_start = AsyncMock(return_value=False)

        with pytest.raises(RuntimeError, match="start hook failed for acme/frontend") as raised:
            await sup.boot(BootMode.FRESH, [])

        error = raised.value
        assert isinstance(error, BootPhaseError)
        assert error.phase == "start"
        assert (error.repo_owner, error.repo_name) == ("acme", "frontend")
        assert not hasattr(error, "output_tail")
        failed = _all_lines()[-1]
        assert (failed["phase"], failed["status"]) == ("start", "failed")
        assert failed["detail"] == "start hook failed for acme/frontend"
        assert failed["repoName"] == "frontend"
        assert "outputTail" not in failed
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

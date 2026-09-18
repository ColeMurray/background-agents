"""Tests for the supervisor -> bridge boot-events channel."""

import asyncio
import json
from unittest.mock import MagicMock

import pytest

from sandbox_runtime.boot_events import (
    DETAIL_MAX_CHARS,
    BootEventLog,
    BootEventWriteError,
    BootPhaseError,
    boot_events_cursor_path,
)
from sandbox_runtime.repo_config import RepoEntry


def _repo(tmp_path, owner="acme", name="api") -> RepoEntry:
    return RepoEntry(owner=owner, name=name, branch="main", base_sha="", path=tmp_path / name)


def _lines(path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines()]


@pytest.fixture
def events(tmp_path, monkeypatch):
    path = tmp_path / "oi-boot-events.jsonl"
    monkeypatch.setattr("sandbox_runtime.boot_events.BOOT_EVENTS_FILE_PATH", str(path))
    return BootEventLog(MagicMock()), path


class TestBootEventLog:
    def test_reset_truncates_a_previous_boot(self, events):
        log, path = events
        path.write_text('{"seq": 9, "kind": "phase"}\n')

        log.reset()

        assert path.read_text() == ""

    def test_phase_lines_carry_a_monotonic_sequence(self, events, tmp_path):
        log, path = events
        log.reset()

        first = log.phase("sync", "started")
        second = log.phase("setup", "started", repo=_repo(tmp_path))

        assert (first, second) == (1, 2)
        lines = _lines(path)
        assert lines[0]["seq"] == 1
        assert lines[0]["kind"] == "phase"
        assert lines[0]["phase"] == "sync"
        assert lines[0]["status"] == "started"
        assert "repoOwner" not in lines[0]
        assert isinstance(lines[0]["at"], float)
        assert lines[1] == {
            "seq": 2,
            "kind": "phase",
            "phase": "setup",
            "status": "started",
            "repoOwner": "acme",
            "repoName": "api",
            "at": lines[1]["at"],
        }

    def test_warnings_share_the_sequence_and_keep_the_warning_shape(self, events, tmp_path):
        log, path = events
        log.reset()
        log.phase("setup", "started", repo=_repo(tmp_path))

        log.record("setup", "setup.sh exited 2", _repo(tmp_path))

        warning = _lines(path)[1]
        assert warning == {
            "seq": 2,
            "kind": "warning",
            "scope": "setup",
            "message": "setup.sh exited 2",
            "repoOwner": "acme",
            "repoName": "api",
            "at": warning["at"],
        }
        log.log.warn.assert_called_with(
            "supervisor.boot_warning",
            scope="setup",
            warning_message="setup.sh exited 2",
            repo_owner="acme",
            repo_name="api",
        )

    def test_reset_forgets_the_cursor(self, events):
        log, path = events
        cursor = boot_events_cursor_path(path)
        cursor.write_text("17")

        log.reset()

        assert not cursor.exists()

    def test_reset_raises_when_the_new_boot_cannot_own_the_file(self, tmp_path, monkeypatch):
        missing = tmp_path / "missing" / "events.jsonl"
        monkeypatch.setattr("sandbox_runtime.boot_events.BOOT_EVENTS_FILE_PATH", str(missing))

        with pytest.raises(BootEventWriteError):
            BootEventLog(MagicMock()).reset()

    def test_phase_write_failure_raises(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            "sandbox_runtime.boot_events.BOOT_EVENTS_FILE_PATH", str(tmp_path / "missing" / "x")
        )
        log = BootEventLog(MagicMock())

        with pytest.raises(BootEventWriteError):
            log.phase("harness", "completed")

    def test_warning_write_failure_is_logged_not_raised(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            "sandbox_runtime.boot_events.BOOT_EVENTS_FILE_PATH", str(tmp_path / "missing" / "x")
        )
        log = BootEventLog(MagicMock())

        log.record("sync", "stale checkout")

        log.log.warn.assert_called_with(
            "supervisor.boot_event_write_failed", exc=log.log.warn.call_args.kwargs["exc"]
        )


class TestPhaseScope:
    async def test_completed_phase_reports_elapsed_and_warning(self, events, tmp_path):
        log, path = events
        log.reset()

        with log.phase_scope("setup", repo=_repo(tmp_path)) as scope:
            await asyncio.sleep(0.01)
            scope.warning = True

        started, completed = _lines(path)
        assert (started["status"], completed["status"]) == ("started", "completed")
        assert completed["warning"] is True
        assert completed["elapsedMs"] >= 10
        assert completed["repoName"] == "api"
        assert "warning" not in started

    def test_completed_phase_omits_warning_when_clean(self, events):
        log, path = events
        log.reset()

        with log.phase_scope("skills"):
            pass

        assert "warning" not in _lines(path)[1]

    def test_boot_phase_error_writes_failed_with_metadata(self, events, tmp_path):
        log, path = events
        log.reset()

        with (
            pytest.raises(BootPhaseError) as raised,
            log.phase_scope("start", repo=_repo(tmp_path)),
        ):
            raise BootPhaseError(
                "start hook failed for acme/api",
                phase="start",
                repo=_repo(tmp_path),
            )

        failed = _lines(path)[1]
        assert failed["status"] == "failed"
        assert failed["detail"] == "start hook failed for acme/api"
        assert failed["repoOwner"] == "acme"
        assert "outputTail" not in failed
        assert not hasattr(raised.value, "output_tail")
        assert raised.value.boot_seq == failed["seq"] == 2

    def test_plain_exception_becomes_a_phase_error_naming_the_phase(self, events):
        log, path = events
        log.reset()

        with pytest.raises(BootPhaseError) as raised, log.phase_scope("harness"):
            raise RuntimeError("OpenCode server failed to become healthy")

        error = raised.value
        assert str(error) == "OpenCode server failed to become healthy"
        assert isinstance(error, RuntimeError)
        assert isinstance(error.__cause__, RuntimeError)
        assert error.phase == "harness"
        assert error.repo_owner is None
        assert error.boot_seq == 2
        assert _lines(path)[1]["detail"] == "OpenCode server failed to become healthy"

    def test_exception_without_a_message_still_names_itself(self, events):
        log, _path = events
        log.reset()

        with pytest.raises(BootPhaseError) as raised, log.phase_scope("harness"):
            raise TimeoutError

        assert str(raised.value) == "TimeoutError"

    def test_a_phase_transition_that_cannot_be_written_fails_the_phase(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            "sandbox_runtime.boot_events.BOOT_EVENTS_FILE_PATH", str(tmp_path / "missing" / "x")
        )
        log = BootEventLog(MagicMock())

        with pytest.raises(BootEventWriteError), log.phase_scope("harness"):
            pass

    def test_an_unwritable_failed_line_keeps_the_original_cause(self, events, monkeypatch):
        log, _path = events
        log.reset()

        def fail_after_started(*_args, **_kwargs):
            raise OSError("no space left on device")

        with pytest.raises(BootPhaseError) as raised, log.phase_scope("harness"):
            monkeypatch.setattr(
                "sandbox_runtime.boot_events.open", fail_after_started, raising=False
            )
            raise RuntimeError("OpenCode server failed to become healthy")

        assert str(raised.value) == "OpenCode server failed to become healthy"
        assert raised.value.boot_seq is None

    def test_detail_is_redacted_and_bounded(self, events, monkeypatch):
        log, path = events
        log.reset()
        monkeypatch.setenv("FIXTURE_API_TOKEN", "tok-abcdef123456")

        with pytest.raises(BootPhaseError) as raised, log.phase_scope("harness"):
            raise RuntimeError("login failed with tok-abcdef123456 " + "x" * DETAIL_MAX_CHARS)

        detail = _lines(path)[1]["detail"]
        assert "tok-abcdef123456" not in detail
        assert detail.startswith("login failed with *** ")
        assert len(detail) == DETAIL_MAX_CHARS
        assert str(raised.value) == detail

    async def test_cancellation_writes_no_failed_line(self, events):
        log, path = events
        log.reset()

        async def cancelled_phase() -> None:
            with log.phase_scope("setup"):
                await asyncio.Event().wait()

        task = asyncio.create_task(cancelled_phase())
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        assert [line["status"] for line in _lines(path)] == ["started"]

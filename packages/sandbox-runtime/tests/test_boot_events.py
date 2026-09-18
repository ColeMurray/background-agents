"""Tests for the supervisor -> bridge boot-events channel."""

import asyncio
import json
from unittest.mock import MagicMock

import pytest

from sandbox_runtime.boot_events import (
    OUTPUT_TAIL_MAX_CHARS,
    OUTPUT_TAIL_MAX_LINE_CHARS,
    OUTPUT_TAIL_MAX_LINES,
    BootEventLog,
    BootPhaseError,
    bounded_output_tail,
    secret_values,
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

    def test_reset_forgets_the_cursor_even_when_truncation_fails(self, tmp_path, monkeypatch):
        from sandbox_runtime.boot_events import boot_events_cursor_path

        missing = tmp_path / "missing" / "events.jsonl"
        monkeypatch.setattr("sandbox_runtime.boot_events.BOOT_EVENTS_FILE_PATH", str(missing))
        cursor = boot_events_cursor_path(missing)
        unlinked = []
        monkeypatch.setattr(
            "sandbox_runtime.boot_events.Path.unlink",
            lambda self, missing_ok=False: unlinked.append(self),
        )

        BootEventLog(MagicMock()).reset()

        assert unlinked == [cursor]

    def test_write_failure_is_logged_not_raised(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            "sandbox_runtime.boot_events.BOOT_EVENTS_FILE_PATH", str(tmp_path / "missing" / "x")
        )
        log = BootEventLog(MagicMock())

        assert log.phase("sync", "started") == 1
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

    def test_boot_phase_error_writes_failed_with_its_tail(self, events, tmp_path):
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
                output_tail=("npm ERR! missing script", "exit 1"),
            )

        failed = _lines(path)[1]
        assert failed["status"] == "failed"
        assert failed["outputTail"] == ["npm ERR! missing script", "exit 1"]
        assert failed["detail"] == "start hook failed for acme/api"
        assert failed["repoOwner"] == "acme"
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
        assert error.output_tail == ()
        assert error.boot_seq == 2
        assert _lines(path)[1]["detail"] == "OpenCode server failed to become healthy"

    def test_exception_without_a_message_still_names_itself(self, events):
        log, _path = events
        log.reset()

        with pytest.raises(BootPhaseError) as raised, log.phase_scope("harness"):
            raise TimeoutError

        assert str(raised.value) == "TimeoutError"

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


class TestOutputTail:
    def test_keeps_only_the_final_lines(self):
        text = "\n".join(f"line {index}" for index in range(100))

        tail = bounded_output_tail(text)

        assert len(tail) == OUTPUT_TAIL_MAX_LINES
        assert tail[0] == "line 40"
        assert tail[-1] == "line 99"

    def test_truncates_long_lines_and_bounds_total_size(self):
        text = "\n".join("x" * 2000 for _ in range(10))

        tail = bounded_output_tail(text)

        assert all(len(line) <= OUTPUT_TAIL_MAX_LINE_CHARS for line in tail)
        assert sum(len(line) for line in tail) <= OUTPUT_TAIL_MAX_CHARS
        # The newest lines survive; older ones are dropped from the front.
        assert len(tail) == OUTPUT_TAIL_MAX_CHARS // OUTPUT_TAIL_MAX_LINE_CHARS

    def test_redacts_secret_values_before_they_leave(self):
        secrets = secret_values(
            {
                "NPM_TOKEN": "npm_abcdef123456",
                "DATABASE_PASSWORD": "hunter2hunter2",
                "SANDBOX_AUTH_TOKEN": "sbx-token-value",
                "HOME": "/home/user",
                "SHORT_KEY": "abc",
            }
        )

        tail = bounded_output_tail(
            "auth: npm_abcdef123456\npg: hunter2hunter2 at /home/user\nkey abc kept",
            secrets=secrets,
        )

        assert tail == ["auth: ***", "pg: *** at /home/user", "key abc kept"]

    def test_bounds_are_measured_the_way_the_control_plane_measures(self):
        # zod's .max() counts UTF-16 code units; an astral character is two.
        exact = "x" * 1022 + "\U0001f680"
        over = "x" * 1023 + "\U0001f680"

        assert bounded_output_tail(exact) == [exact]
        assert bounded_output_tail(over) == ["x" * 1023]

    def test_empty_output_is_an_empty_tail(self):
        assert bounded_output_tail("") == []
        assert bounded_output_tail("\n\n") == []

"""The bridge's reader for the supervisor's boot-events file."""

import json
from pathlib import Path
from unittest.mock import MagicMock

from sandbox_runtime.boot_event_relay import BootEventRelay


def _write(path: Path, *entries: dict, partial: str = "") -> None:
    with path.open("a") as handle:
        for entry in entries:
            handle.write(json.dumps(entry) + "\n")
        handle.write(partial)


def _relay(tmp_path) -> tuple[BootEventRelay, Path]:
    path = tmp_path / "events.jsonl"
    return BootEventRelay(path, MagicMock()), path


class TestReading:
    def test_missing_file_reads_as_nothing(self, tmp_path):
        relay, _path = _relay(tmp_path)

        assert relay.read_new_lines() == []
        assert relay.latest_phase is None
        assert relay.harness_completed is False

    def test_reads_only_lines_appended_since_the_last_read(self, tmp_path):
        relay, path = _relay(tmp_path)
        _write(path, {"seq": 1, "kind": "phase", "phase": "sync", "status": "started", "at": 1.0})
        assert [line["seq"] for line in relay.read_new_lines()] == [1]

        _write(path, {"seq": 2, "kind": "phase", "phase": "sync", "status": "completed", "at": 2.0})

        assert [line["seq"] for line in relay.read_new_lines()] == [2]
        assert relay.read_new_lines() == []

    def test_partial_trailing_line_waits_for_its_newline(self, tmp_path):
        relay, path = _relay(tmp_path)
        _write(path, partial='{"seq": 1, "kind": "pha')
        assert relay.read_new_lines() == []

        _write(path, partial='se", "phase": "setup", "status": "started", "at": 3.0}\n')

        assert [line["phase"] for line in relay.read_new_lines()] == ["setup"]

    def test_invalid_lines_are_skipped(self, tmp_path):
        relay, path = _relay(tmp_path)
        path.write_text(
            'not json\n{"seq": 1, "kind": "warning", "message": "m", "scope": "sync", "at": 1.0}\n\n'
        )

        assert [line["seq"] for line in relay.read_new_lines()] == [1]

    def test_truncation_starts_a_new_boot(self, tmp_path):
        relay, path = _relay(tmp_path)
        _write(
            path,
            {"seq": 1, "kind": "phase", "phase": "sync", "status": "started", "at": 1.0},
            {"seq": 2, "kind": "phase", "phase": "harness", "status": "completed", "at": 2.0},
        )
        relay.read_new_lines()
        assert relay.harness_completed is True

        path.write_text("")
        assert relay.read_new_lines() == []
        assert relay.latest_phase is None
        assert relay.harness_completed is False
        _write(path, {"seq": 1, "kind": "phase", "phase": "sync", "status": "started", "at": 5.0})

        assert [line["seq"] for line in relay.read_new_lines()] == [1]
        assert relay.latest_phase["at"] == 5.0


class TestCursor:
    def test_lines_already_relayed_by_an_earlier_bridge_are_skipped(self, tmp_path):
        relay, path = _relay(tmp_path)
        _write(
            path,
            {"seq": 1, "kind": "phase", "phase": "sync", "status": "started", "at": 1.0},
            {"seq": 2, "kind": "warning", "scope": "sync", "message": "stale", "at": 1.5},
            {"seq": 3, "kind": "phase", "phase": "harness", "status": "completed", "at": 2.0},
        )
        relay.read_new_lines()
        relay.mark_relayed(3)

        restarted = BootEventRelay(path, MagicMock())
        unrelayed = restarted.read_new_lines()

        assert [line["seq"] for line in unrelayed] == []
        assert restarted.latest_phase["seq"] == 3
        assert restarted.harness_completed is True
        _write(path, {"seq": 4, "kind": "warning", "scope": "start", "message": "m", "at": 3.0})
        assert [line["seq"] for line in restarted.read_new_lines()] == [4]

    def test_truncation_forgets_the_cursor(self, tmp_path):
        relay, path = _relay(tmp_path)
        _write(path, {"seq": 1, "kind": "phase", "phase": "sync", "status": "started", "at": 1.0})
        relay.read_new_lines()
        relay.mark_relayed(1)

        path.write_text("")
        relay.read_new_lines()
        _write(path, {"seq": 1, "kind": "phase", "phase": "sync", "status": "started", "at": 5.0})

        assert [line["seq"] for line in relay.read_new_lines()] == [1]

    def test_cursor_file_is_removed_by_a_new_boot(self, tmp_path, monkeypatch):
        from sandbox_runtime.boot_events import BootEventLog

        relay, path = _relay(tmp_path)
        monkeypatch.setattr("sandbox_runtime.boot_events.BOOT_EVENTS_FILE_PATH", str(path))
        relay.mark_relayed(7)
        assert relay.cursor_path.exists()

        BootEventLog(MagicMock()).reset()

        assert not relay.cursor_path.exists()
        assert BootEventRelay(path, MagicMock()).read_new_lines() == []


class TestEventMapping:
    def test_phase_line_becomes_boot_progress(self):
        event = BootEventRelay.to_event(
            {
                "seq": 5,
                "kind": "phase",
                "phase": "setup",
                "status": "completed",
                "warning": True,
                "elapsedMs": 751000,
                "repoOwner": "acme",
                "repoName": "api",
                "at": 1789420751.4,
            }
        )

        assert event == {
            "type": "boot_progress",
            "bootSeq": 5,
            "phase": "setup",
            "status": "completed",
            "warning": True,
            "elapsedMs": 751000,
            "repoOwner": "acme",
            "repoName": "api",
            "timestamp": 1789420751.4,
        }

    def test_failed_phase_carries_tail_and_detail(self):
        event = BootEventRelay.to_event(
            {
                "seq": 9,
                "kind": "phase",
                "phase": "start",
                "status": "failed",
                "outputTail": ["boom"],
                "detail": "start hook failed for acme/api",
                "at": 3.0,
            }
        )

        assert event["outputTail"] == ["boom"]
        assert event["detail"] == "start hook failed for acme/api"
        assert "warning" not in event

    def test_warning_line_becomes_warning_event(self):
        event = BootEventRelay.to_event(
            {
                "seq": 4,
                "kind": "warning",
                "scope": "setup",
                "message": "setup.sh exited 2",
                "repoOwner": "acme",
                "repoName": "api",
                "at": 2.0,
            }
        )

        assert event == {
            "type": "warning",
            "scope": "setup",
            "message": "setup.sh exited 2",
            "repoOwner": "acme",
            "repoName": "api",
            "timestamp": 2.0,
        }

    def test_unknown_or_incomplete_lines_map_to_nothing(self):
        assert BootEventRelay.to_event({"seq": 1, "kind": "warning", "scope": "sync"}) is None
        assert BootEventRelay.to_event({"seq": 1, "kind": "other"}) is None
        assert (
            BootEventRelay.to_event(
                {"seq": 1, "kind": "phase", "phase": "bogus", "status": "started"}
            )
            is None
        )

    def test_latest_phase_event_defaults_to_starting(self, tmp_path):
        relay, path = _relay(tmp_path)

        assert relay.latest_phase_event() == {
            "type": "boot_progress",
            "bootSeq": 0,
            "phase": "starting",
            "status": "started",
        }
        _write(
            path,
            {"seq": 1, "kind": "phase", "phase": "sync", "status": "started", "at": 1.0},
            {"seq": 2, "kind": "warning", "scope": "sync", "message": "m", "at": 1.5},
        )
        relay.read_new_lines()

        assert relay.latest_phase_event()["bootSeq"] == 1
        assert relay.latest_phase_event()["phase"] == "sync"

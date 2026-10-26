"""The completed-boot marker a provider can ask the supervisor to leave behind."""

from unittest.mock import MagicMock

from sandbox_runtime.constants import BOOT_COMPLETE_MARKER_ENV_VAR
from sandbox_runtime.supervisor import record_boot_complete


def test_marker_is_created_with_its_parent_when_requested(tmp_path):
    marker = tmp_path / "state" / "boot-complete"
    log = MagicMock()

    record_boot_complete({BOOT_COMPLETE_MARKER_ENV_VAR: str(marker)}, log)

    assert marker.is_file()
    log.warn.assert_not_called()


def test_nothing_happens_without_a_requested_marker(tmp_path):
    log = MagicMock()

    record_boot_complete({}, log)
    record_boot_complete({BOOT_COMPLETE_MARKER_ENV_VAR: ""}, log)

    assert list(tmp_path.iterdir()) == []
    log.warn.assert_not_called()


def test_an_unwritable_marker_is_logged_not_fatal(tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("not a directory")
    log = MagicMock()

    record_boot_complete({BOOT_COMPLETE_MARKER_ENV_VAR: str(blocker / "boot-complete")}, log)

    log.warn.assert_called_once()
    assert log.warn.call_args.args[0] == "supervisor.boot_marker_write_failed"

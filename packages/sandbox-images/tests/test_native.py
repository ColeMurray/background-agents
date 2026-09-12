"""The public CLI only builds; verification is an internal build gate."""

import sys
from unittest.mock import Mock

import pytest

from sandbox_images import cli, native


@pytest.mark.parametrize(
    "arguments",
    [
        ["verify", "--provider", "e2b"],
        ["build", "--provider", "e2b", "--reference", "old-image"],
        ["build"],
    ],
)
def test_unsupported_operations_do_not_invoke_builders(monkeypatch, arguments):
    run = Mock()
    monkeypatch.setattr(cli, "build_image", run)
    monkeypatch.setattr(sys, "argv", ["images", *arguments])
    with pytest.raises(SystemExit) as error:
        cli.main()
    assert error.value.code == 2
    run.assert_not_called()


def test_stale_locks_prevent_native_allocation(monkeypatch, tmp_path):
    monkeypatch.setattr(native, "update_locks", Mock(side_effect=ValueError("stale")))
    run = Mock()
    monkeypatch.setattr(native.subprocess, "run", run)
    with pytest.raises(ValueError, match="stale"):
        native.build_image(tmp_path, "e2b")
    run.assert_not_called()

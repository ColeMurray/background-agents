"""Verification must never turn malformed supplied evidence into a native build."""

from unittest.mock import Mock

import pytest

from sandbox_images import native


@pytest.mark.parametrize("provider", ["modal", "daytona", "e2b", "vercel", "opencomputer"])
def test_empty_reference_never_invokes_provider_commands(tmp_path, monkeypatch, provider):
    monkeypatch.setattr(native, "update_locks", Mock())
    run = Mock()
    monkeypatch.setattr(native.subprocess, "run", run)
    with pytest.raises(ValueError):
        native.native_operation(tmp_path, provider, "")
    run.assert_not_called()

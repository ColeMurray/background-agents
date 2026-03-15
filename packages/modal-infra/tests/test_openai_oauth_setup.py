"""Tests for SandboxSupervisor._setup_openai_oauth()."""

import json
import os
from unittest.mock import patch

from src.sandbox.entrypoint import SandboxSupervisor


def _make_supervisor() -> SandboxSupervisor:
    """Create a SandboxSupervisor with default test config."""
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
        return SandboxSupervisor()


def _auth_file(tmp_path):
    """Return the expected auth.json path under tmp_path."""
    return tmp_path / ".local" / "share" / "opencode" / "auth.json"


class TestOpenaiOauthSetup:
    """Cases for _setup_openai_oauth()."""

    def test_writes_auth_json_when_refresh_token_present(self, tmp_path):
        sup = _make_supervisor()

        with (
            patch.dict("os.environ", {"OPENAI_OAUTH_REFRESH_TOKEN": "rt_abc123"}, clear=False),
            patch("pathlib.Path.home", return_value=tmp_path),
        ):
            sup._setup_openai_oauth()

        data = json.loads(_auth_file(tmp_path).read_text())
        assert data == {
            "openai": {
                "type": "oauth",
                "refresh": "managed-by-control-plane",
                "access": "",
                "expires": 0,
            }
        }

    def test_includes_account_id_when_present(self, tmp_path):
        sup = _make_supervisor()

        with (
            patch.dict(
                "os.environ",
                {
                    "OPENAI_OAUTH_REFRESH_TOKEN": "rt_abc123",
                    "OPENAI_OAUTH_ACCOUNT_ID": "acct_xyz",
                },
                clear=False,
            ),
            patch("pathlib.Path.home", return_value=tmp_path),
        ):
            sup._setup_openai_oauth()

        data = json.loads(_auth_file(tmp_path).read_text())
        assert data["openai"]["accountId"] == "acct_xyz"

    def test_skips_when_no_providers_configured(self, tmp_path, monkeypatch):
        sup = _make_supervisor()

        # Explicitly remove all provider keys so none are present
        monkeypatch.delenv("OPENAI_OAUTH_REFRESH_TOKEN", raising=False)
        monkeypatch.delenv("OPENCODE_ZEN_API_KEY", raising=False)
        monkeypatch.delenv("OPENCODE_GO_API_KEY", raising=False)

        with patch("pathlib.Path.home", return_value=tmp_path):
            sup._setup_openai_oauth()

        assert not _auth_file(tmp_path).exists()

    def test_writes_zen_only(self, tmp_path, monkeypatch):
        sup = _make_supervisor()

        monkeypatch.delenv("OPENAI_OAUTH_REFRESH_TOKEN", raising=False)
        monkeypatch.delenv("OPENCODE_GO_API_KEY", raising=False)

        with (
            patch.dict("os.environ", {"OPENCODE_ZEN_API_KEY": "zen_key_123"}, clear=False),
            patch("pathlib.Path.home", return_value=tmp_path),
        ):
            sup._setup_openai_oauth()

        data = json.loads(_auth_file(tmp_path).read_text())
        assert data == {"opencode": {"type": "api", "key": "zen_key_123"}}

    def test_writes_go_only(self, tmp_path, monkeypatch):
        sup = _make_supervisor()

        monkeypatch.delenv("OPENAI_OAUTH_REFRESH_TOKEN", raising=False)
        monkeypatch.delenv("OPENCODE_ZEN_API_KEY", raising=False)

        with (
            patch.dict("os.environ", {"OPENCODE_GO_API_KEY": "go_key_456"}, clear=False),
            patch("pathlib.Path.home", return_value=tmp_path),
        ):
            sup._setup_openai_oauth()

        data = json.loads(_auth_file(tmp_path).read_text())
        assert data == {"opencode-go": {"type": "api", "key": "go_key_456"}}

    def test_writes_all_providers_combined(self, tmp_path, monkeypatch):
        sup = _make_supervisor()

        with (
            patch.dict(
                "os.environ",
                {
                    "OPENAI_OAUTH_REFRESH_TOKEN": "rt_abc",
                    "OPENCODE_ZEN_API_KEY": "zen_key",
                    "OPENCODE_GO_API_KEY": "go_key",
                },
                clear=False,
            ),
            patch("pathlib.Path.home", return_value=tmp_path),
        ):
            sup._setup_openai_oauth()

        data = json.loads(_auth_file(tmp_path).read_text())
        assert "openai" in data
        assert data["opencode"] == {"type": "api", "key": "zen_key"}
        assert data["opencode-go"] == {"type": "api", "key": "go_key"}

    def test_sets_secure_permissions(self, tmp_path):
        sup = _make_supervisor()

        with (
            patch.dict("os.environ", {"OPENAI_OAUTH_REFRESH_TOKEN": "rt_abc123"}, clear=False),
            patch("pathlib.Path.home", return_value=tmp_path),
        ):
            sup._setup_openai_oauth()

        mode = _auth_file(tmp_path).stat().st_mode & 0o777
        assert mode == 0o600

    def test_does_not_crash_on_write_failure(self, tmp_path):
        sup = _make_supervisor()

        with (
            patch.dict("os.environ", {"OPENAI_OAUTH_REFRESH_TOKEN": "rt_abc123"}, clear=False),
            patch("pathlib.Path.home", return_value=tmp_path),
            patch("os.open", side_effect=OSError("disk full")),
        ):
            sup._setup_openai_oauth()

    def test_no_temp_file_left_on_write_failure(self, tmp_path):
        sup = _make_supervisor()
        original_open = os.open

        def fail_on_tmp(path, *args, **kwargs):
            if ".auth.json.tmp" in path:
                raise OSError("disk full")
            return original_open(path, *args, **kwargs)

        with (
            patch.dict("os.environ", {"OPENAI_OAUTH_REFRESH_TOKEN": "rt_abc123"}, clear=False),
            patch("pathlib.Path.home", return_value=tmp_path),
            patch("os.open", side_effect=fail_on_tmp),
        ):
            sup._setup_openai_oauth()

        auth_dir = tmp_path / ".local" / "share" / "opencode"
        tmp_file = auth_dir / ".auth.json.tmp"
        assert not tmp_file.exists()

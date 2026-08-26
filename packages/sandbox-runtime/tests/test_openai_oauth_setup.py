"""Tests for OpenCodeServer._setup_openai_oauth()."""

import json
import os
from unittest.mock import patch

from sandbox_runtime.opencode_server import OpenCodeServer
from tests.runtime_helpers import make_opencode_server


def _make_opencode_server() -> OpenCodeServer:
    """Create an OpenCodeServer with default test config."""
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
        return make_opencode_server()


def _auth_file(tmp_path):
    """Return the expected auth.json path under tmp_path."""
    return tmp_path / ".local" / "share" / "opencode" / "auth.json"


class TestOpenaiOauthSetup:
    """Cases for _setup_openai_oauth()."""

    def test_writes_auth_json_when_refresh_token_present(self, tmp_path):
        sup = _make_opencode_server()

        with (
            patch.dict("os.environ", {"OPENAI_OAUTH_MANAGED": "1"}, clear=True),
            patch("pathlib.Path.home", return_value=tmp_path),
        ):
            sup._setup_managed_oauth()

        data = json.loads(_auth_file(tmp_path).read_text())
        assert data == {
            "openai": {
                "type": "oauth",
                "refresh": "managed-by-control-plane",
                "access": "",
                "expires": 0,
            }
        }

    def test_does_not_require_account_id_in_sandbox_env(self, tmp_path):
        sup = _make_opencode_server()

        with (
            patch.dict(
                "os.environ",
                {
                    "OPENAI_OAUTH_MANAGED": "1",
                    "OPENAI_OAUTH_ACCOUNT_ID": "acct_xyz",
                },
                clear=False,
            ),
            patch("pathlib.Path.home", return_value=tmp_path),
        ):
            sup._setup_managed_oauth()

        data = json.loads(_auth_file(tmp_path).read_text())
        assert "accountId" not in data["openai"]

    def test_skips_when_no_refresh_token(self, tmp_path, monkeypatch):
        sup = _make_opencode_server()

        # Explicitly remove the key so it is absent regardless of test ordering
        monkeypatch.delenv("OPENAI_OAUTH_MANAGED", raising=False)
        monkeypatch.delenv("XAI_OAUTH_MANAGED", raising=False)

        with patch("pathlib.Path.home", return_value=tmp_path):
            sup._setup_managed_oauth()

        assert not _auth_file(tmp_path).exists()

    def test_sets_secure_permissions(self, tmp_path):
        sup = _make_opencode_server()

        with (
            patch.dict("os.environ", {"OPENAI_OAUTH_MANAGED": "1"}, clear=False),
            patch("pathlib.Path.home", return_value=tmp_path),
        ):
            sup._setup_managed_oauth()

        mode = _auth_file(tmp_path).stat().st_mode & 0o777
        assert mode == 0o600

    def test_does_not_crash_on_write_failure(self, tmp_path):
        sup = _make_opencode_server()

        with (
            patch.dict("os.environ", {"OPENAI_OAUTH_MANAGED": "1"}, clear=False),
            patch("pathlib.Path.home", return_value=tmp_path),
            patch("os.open", side_effect=OSError("disk full")),
        ):
            sup._setup_managed_oauth()

    def test_no_temp_file_left_on_write_failure(self, tmp_path):
        sup = _make_opencode_server()
        original_open = os.open

        def fail_on_tmp(path, *args, **kwargs):
            if ".auth.json.tmp" in path:
                raise OSError("disk full")
            return original_open(path, *args, **kwargs)

        with (
            patch.dict("os.environ", {"OPENAI_OAUTH_MANAGED": "1"}, clear=False),
            patch("pathlib.Path.home", return_value=tmp_path),
            patch("os.open", side_effect=fail_on_tmp),
        ):
            sup._setup_managed_oauth()

        auth_dir = tmp_path / ".local" / "share" / "opencode"
        tmp_file = auth_dir / ".auth.json.tmp"
        assert not tmp_file.exists()

    def test_restricts_existing_temp_file_before_write(self, tmp_path):
        sup = _make_opencode_server()
        auth_dir = tmp_path / ".local" / "share" / "opencode"
        auth_dir.mkdir(parents=True)
        tmp_file = auth_dir / ".auth.json.tmp"
        tmp_file.write_text("old")
        tmp_file.chmod(0o644)

        with (
            patch.dict("os.environ", {"OPENAI_OAUTH_MANAGED": "1"}, clear=False),
            patch("pathlib.Path.home", return_value=tmp_path),
        ):
            sup._setup_managed_oauth()

        assert _auth_file(tmp_path).stat().st_mode & 0o777 == 0o600

    def test_removes_temp_file_when_replace_fails(self, tmp_path):
        sup = _make_opencode_server()

        with (
            patch.dict("os.environ", {"OPENAI_OAUTH_MANAGED": "1"}, clear=False),
            patch("pathlib.Path.home", return_value=tmp_path),
            patch("pathlib.Path.replace", side_effect=OSError("replace failed")),
        ):
            sup._setup_managed_oauth()

        assert not (_auth_file(tmp_path).parent / ".auth.json.tmp").exists()

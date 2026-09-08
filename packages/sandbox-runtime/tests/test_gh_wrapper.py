"""Shell-level tests for the gh CLI wrapper.

The wrapper (`GH_WRAPPER_BODY`) is a thin /bin/sh delegator: it asks the
credential helper's `gh-token` action for a token and, if one is printed,
exports it as GH_TOKEN before exec'ing the real gh. The token-precedence
decision itself lives in Python (see ``test_git_credential_helper.py``);
these tests only verify the shell wiring — that a printed token reaches gh
via the environment (never argv), and that an empty or failed helper falls
through to whatever was already in the env.

We rebuild the wrapper here with the real gh and the helper invocation
pointed at fakes so the actual control flow runs under a real shell.
"""

from __future__ import annotations

import os
import subprocess
from typing import TYPE_CHECKING

import pytest

from sandbox_runtime import entrypoint
from sandbox_runtime.entrypoint import GH_WRAPPER_BODY, SandboxSupervisor

if TYPE_CHECKING:
    from pathlib import Path

# Fake "real gh": echoes the token env vars and argv so a test can see which
# token (if any) the wrapper handed to gh and confirm it never hit argv.
REAL_GH_DECISION = (
    '#!/bin/sh\necho "GH_TOKEN=${GH_TOKEN}"\necho "GITHUB_TOKEN=${GITHUB_TOKEN}"\n'
    'echo "GITHUB_APP_TOKEN=${GITHUB_APP_TOKEN}"\necho "ARGS=$*"\n'
)

# Fake `gh-token` helper behaviours.
PRINTS_FRESH_TOKEN = "#!/bin/sh\nprintf '%s' 'ghs_fresh'\n"
PRINTS_NOTHING = "#!/bin/sh\nexit 0\n"
EXITS_NONZERO = "#!/bin/sh\nexit 1\n"

# Anchors we substitute in GH_WRAPPER_BODY to point at the fakes. Asserted
# present before use so that a drift in the wrapper body fails loudly here
# instead of silently leaving the test running the real gh / helper.
REAL_GH_ANCHOR = 'REAL_GH="/usr/bin/gh"'
HELPER_ANCHOR = "python3 -m sandbox_runtime.credentials.git_credential_helper gh-token"


def _build_wrapper(tmp_path: Path, *, token_cmd_body: str) -> Path:
    """Materialize the wrapper with fakes for the real gh and the helper."""
    real_gh = tmp_path / "real-gh"
    real_gh.write_text(REAL_GH_DECISION)
    real_gh.chmod(0o755)

    token_cmd = tmp_path / "token-cmd"
    token_cmd.write_text(token_cmd_body)
    token_cmd.chmod(0o755)

    assert REAL_GH_ANCHOR in GH_WRAPPER_BODY
    assert HELPER_ANCHOR in GH_WRAPPER_BODY
    body = GH_WRAPPER_BODY.replace(REAL_GH_ANCHOR, f'REAL_GH="{real_gh}"')
    body = body.replace(HELPER_ANCHOR, str(token_cmd))

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


def test_exports_minted_token_as_gh_token(tmp_path: Path) -> None:
    wrapper = _build_wrapper(tmp_path, token_cmd_body=PRINTS_FRESH_TOKEN)
    out = _run(wrapper, {"VCS_HOST": "github.com"})
    assert "GH_TOKEN=ghs_fresh" in out
    assert "ARGS=api user" in out


def test_minted_token_never_reaches_argv(tmp_path: Path) -> None:
    """P1-2: the token must reach gh via the environment, never via argv."""
    wrapper = _build_wrapper(tmp_path, token_cmd_body=PRINTS_FRESH_TOKEN)
    out = _run(wrapper, {"VCS_HOST": "github.com"})
    args_line = next(line for line in out.splitlines() if line.startswith("ARGS="))
    assert "ghs_fresh" not in args_line


def test_no_export_when_helper_prints_nothing(tmp_path: Path) -> None:
    """Helper declined to mint → gh runs with the pre-existing env untouched."""
    wrapper = _build_wrapper(tmp_path, token_cmd_body=PRINTS_NOTHING)
    out = _run(wrapper, {"VCS_HOST": "github.com", "GITHUB_TOKEN": "user_token"})
    assert "GH_TOKEN=\n" in out
    assert "GITHUB_TOKEN=user_token" in out


def test_falls_through_when_helper_fails(tmp_path: Path) -> None:
    """A nonzero helper (swallowed by `|| true`) leaves the existing env for gh."""
    wrapper = _build_wrapper(tmp_path, token_cmd_body=EXITS_NONZERO)
    out = _run(wrapper, {"VCS_HOST": "github.com", "GITHUB_TOKEN": "stale_token"})
    assert "GH_TOKEN=\n" in out
    assert "GITHUB_TOKEN=stale_token" in out


def test_runtime_installs_canonical_wrapper(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real_gh = tmp_path / "real-gh"
    real_gh.touch()
    real_gh.chmod(0o755)
    wrapper = tmp_path / "gh"
    monkeypatch.setattr(entrypoint, "GH_WRAPPER_REAL_PATH", str(real_gh))
    monkeypatch.setattr(entrypoint, "GH_WRAPPER_INSTALL_PATH", wrapper)

    supervisor = object.__new__(SandboxSupervisor)
    supervisor._install_gh_wrapper()

    assert wrapper.read_text() == GH_WRAPPER_BODY
    assert os.access(wrapper, os.X_OK)


def test_runtime_fails_when_wrapper_cannot_be_installed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real_gh = tmp_path / "real-gh"
    real_gh.touch()
    real_gh.chmod(0o755)
    wrapper = tmp_path / "missing" / "gh"
    monkeypatch.setattr(entrypoint, "GH_WRAPPER_REAL_PATH", str(real_gh))
    monkeypatch.setattr(entrypoint, "GH_WRAPPER_INSTALL_PATH", wrapper)

    with pytest.raises(RuntimeError, match="Cannot install authenticated gh wrapper"):
        supervisor = object.__new__(SandboxSupervisor)
        supervisor._install_gh_wrapper()

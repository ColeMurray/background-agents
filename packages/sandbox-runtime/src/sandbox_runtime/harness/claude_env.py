"""Clean-environment launch for the Claude Agent SDK child.

The SDK merges ``os.environ`` under ``ClaudeAgentOptions.env`` when it spawns
the ``claude`` binary, and the bridge inherits the supervisor's full
environment: the platform-delivered ``ANTHROPIC_API_KEY``, the sandbox auth
token, ``SESSION_CONFIG`` and every user secret. So the harness never hands
the SDK the real binary. It hands it a generated wrapper that re-executes the
binary with exactly the allowlisted variables and nothing else, for every
invocation including the SDK's version probe.

The wrapper carries variable *names* only. Credential values travel through
``ClaudeAgentOptions.env`` in process memory and are never written to disk.
"""

from __future__ import annotations

import os
import stat
import sys
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import TYPE_CHECKING, Final

if TYPE_CHECKING:
    from collections.abc import Mapping

# Variables the child always receives when the bridge has them.
BASE_ALLOWLIST: Final[tuple[str, ...]] = (
    "PATH",
    "HOME",
    "USER",
    "LANG",
    "LC_ALL",
    "TERM",
    "TMPDIR",
    "SHELL",
    "PWD",
    "NODE_OPTIONS",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "https_proxy",
    "HTTPS_PROXY",
    "http_proxy",
    "HTTP_PROXY",
    "no_proxy",
    "NO_PROXY",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_SSH_COMMAND",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    # Set by the SDK itself on every spawn.
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_AGENT_SDK_VERSION",
    "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
    # Set by the harness through options.env.
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
    "CLAUDE_CODE_SUBAGENT_MODEL",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "DISABLE_TELEMETRY",
    "DISABLE_ERROR_REPORTING",
    "DISABLE_AUTOUPDATER",
    "MAX_THINKING_TOKENS",
)

# Credential variables per auth mode. Exactly one mode is ever active, so the
# child sees either the key family or the OAuth token, never both.
API_KEY_ALLOWLIST: Final[tuple[str, ...]] = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
)
OAUTH_ALLOWLIST: Final[tuple[str, ...]] = ("CLAUDE_CODE_OAUTH_TOKEN",)

OAUTH_TOKEN_ENV_VAR: Final = "CLAUDE_CODE_OAUTH_TOKEN"
API_KEY_ENV_VAR: Final = "ANTHROPIC_API_KEY"
OAUTH_MANAGED_ENV_VAR: Final = "ANTHROPIC_OAUTH_MANAGED"
CONFIG_DIR_ENV_VAR: Final = "CLAUDE_CONFIG_DIR"

WRAPPER_NAME: Final = "claude-clean-env"


class ClaudeAuthMode(StrEnum):
    API_KEY = "api_key"
    OAUTH_TOKEN = "oauth_token"


@dataclass(frozen=True)
class ClaudeCredential:
    """The one credential the child receives, held in memory only."""

    mode: ClaudeAuthMode
    # Variables to pass through ``ClaudeAgentOptions.env``; never logged.
    env: Mapping[str, str]

    @classmethod
    def api_key(cls, environ: Mapping[str, str]) -> ClaudeCredential | None:
        """Adopt the bridge's Anthropic key family (a user-configured gateway keeps working)."""
        if not environ.get(API_KEY_ENV_VAR):
            return None
        return cls(
            ClaudeAuthMode.API_KEY,
            {name: environ[name] for name in API_KEY_ALLOWLIST if environ.get(name)},
        )

    @classmethod
    def oauth_token(cls, token: str) -> ClaudeCredential:
        return cls(ClaudeAuthMode.OAUTH_TOKEN, {OAUTH_TOKEN_ENV_VAR: token})


def allowlist_for(mode: ClaudeAuthMode) -> tuple[str, ...]:
    credential = API_KEY_ALLOWLIST if mode is ClaudeAuthMode.API_KEY else OAUTH_ALLOWLIST
    return BASE_ALLOWLIST + credential


def clean_child_env(
    parent: Mapping[str, str], mode: ClaudeAuthMode, extra: Mapping[str, str]
) -> dict[str, str]:
    """What the child ends up with: the allowlisted subset of parent+extra.

    This is the reference the sentinel test compares the wrapper's real
    output against.
    """
    merged = {**parent, **extra}
    return {name: merged[name] for name in allowlist_for(mode) if name in merged}


def bundled_claude_binary() -> Path:
    """The ``claude`` binary the pinned SDK wheel ships (``claude_agent_sdk/_bundled``)."""
    import claude_agent_sdk

    package_dir = Path(claude_agent_sdk.__file__).parent
    binary = package_dir / "_bundled" / "claude"
    if not binary.is_file():
        raise FileNotFoundError(f"The Claude Agent SDK wheel has no bundled binary at {binary}")
    return binary


def write_clean_env_wrapper(
    directory: Path,
    *,
    mode: ClaudeAuthMode,
    binary: Path,
    python_executable: str | None = None,
) -> Path:
    """Generate the wrapper set as ``ClaudeAgentOptions.cli_path``.

    A Python script rather than a shell one so the allowlist is applied
    exactly (no word splitting, no accidental empty exports). It re-executes
    ``binary`` with the allowlisted variables it finds in its own environment,
    which is the SDK's merged ``os.environ`` + ``options.env``.
    """
    python = python_executable or sys.executable
    names = allowlist_for(mode)
    script = "\n".join(
        [
            f"#!{python}",
            '"""Generated by the Open Inspect Claude harness. Do not edit."""',
            "import os",
            "import sys",
            "",
            f"BINARY = {str(binary)!r}",
            f"ALLOWLIST = {names!r}",
            "",
            "env = {name: os.environ[name] for name in ALLOWLIST if name in os.environ}",
            "os.execve(BINARY, [BINARY, *sys.argv[1:]], env)",
            "",
        ]
    )
    directory.mkdir(parents=True, exist_ok=True)
    wrapper = directory / WRAPPER_NAME
    wrapper.write_text(script)
    wrapper.chmod(wrapper.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return wrapper


def harness_env(config_dir: Path, credential: ClaudeCredential) -> dict[str, str]:
    """``ClaudeAgentOptions.env``: config dir, policy, and the one credential."""
    return {
        CONFIG_DIR_ENV_VAR: str(config_dir),
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "DISABLE_AUTOUPDATER": "1",
        "DISABLE_ERROR_REPORTING": "1",
        "DISABLE_TELEMETRY": "1",
        **credential.env,
    }


def resolve_api_key_credential(environ: Mapping[str, str] = os.environ) -> ClaudeCredential | None:
    return ClaudeCredential.api_key(environ)

"""Authoritative native launch configuration and session MCP translation."""

from __future__ import annotations

import json
import tomllib
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from ..base import HarnessStartError

CODEX_VERSION = "0.163.0"
# The image's pinned install, never a /usr/local/bin link: a substrate may
# re-link its own coding agents there at boot (Boat does).
CODEX_BINARY = "/opt/openinspect/codex/bin/codex"
# The parent thread plus three concurrent sub-agents.
MAX_AGENT_THREADS = 4


def clean_codex_env(parent: Mapping[str, str], state_dir: Path) -> dict[str, str]:
    # Sandbox helpers need SESSION_CONFIG, just as they do for the other harnesses.
    env = {
        key: value
        for key, value in parent.items()
        if not key.startswith(("OPENAI_", "CODEX_", "OTEL_", "OI_MCP_"))
    }
    env.update(
        {
            "CODEX_HOME": str(state_dir),
            "RUST_LOG": "off",
            "OTEL_SDK_DISABLED": "true",
        }
    )
    return env


def validate_native_configuration(workdir: Path, parent: Mapping[str, str]) -> None:
    if any(
        (Path("/etc/codex") / name).exists()
        for name in (
            "config.toml",
            "managed_config.toml",
            "requirements.toml",
        )
    ):
        raise HarnessStartError("System Codex configuration is not supported in this runtime")
    if any(parent.get(key) for key in ("OPENAI_BASE_URL", "OPENAI_API_BASE", "CODEX_API_ENDPOINT")):
        raise HarnessStartError("Custom OpenAI endpoints are not supported by the Codex harness")
    # Native repository overrides include credential routing and executable
    # hooks. Until individual settings can be safely imported, fail explicitly.
    # AGENTS.md and skills remain native inputs and are not rejected.
    for directory in (workdir, *workdir.parents):
        if (directory / ".codex" / "config.toml").exists():
            raise HarnessStartError(
                "Repository Codex configuration is not supported; use session MCP settings and AGENTS.md"
            )


def validate_native_state(state_dir: Path) -> None:
    """Accept native project trust bookkeeping, not restored configuration authority."""
    message = "Codex state contains unsupported credential or configuration files"
    if any(
        (state_dir / name).exists()
        for name in ("auth.json", "managed_config.toml", "requirements.toml")
    ):
        raise HarnessStartError(message)
    path = state_dir / "config.toml"
    if not path.exists():
        return
    # thread/start writes this file when it trusts a Git repository. It must
    # remain usable on subsequent turns and after snapshot/restart.
    try:
        config = tomllib.loads(path.read_text())
    except (OSError, ValueError):
        raise HarnessStartError(message) from None
    projects = config.get("projects", {})
    if (
        config.keys() - {"projects"}
        or not isinstance(projects, dict)
        or any(
            not isinstance(project, dict)
            or project.keys() != {"trust_level"}
            or project["trust_level"] not in ("trusted", "untrusted")
            for project in projects.values()
        )
    ):
        raise HarnessStartError(message)


def launch_arguments(state_dir: Path) -> tuple[str, ...]:
    overrides = {
        "cli_auth_credentials_store": '"ephemeral"',
        "mcp_oauth_credentials_store": '"keyring"',
        "approval_policy": '"never"',
        "sandbox_mode": '"danger-full-access"',
        "model_provider": '"openai"',
        "model_providers": "{}",
        # Leave the built-in provider's base unset: Codex selects /v1 for API
        # keys and /backend-api/codex plus workspace routing for ChatGPT auth.
        "chatgpt_base_url": '"https://chatgpt.com/backend-api"',
        "mcp_servers": "{}",
        "hooks": "{}",
        # Sub-agents are the model-declared v2 ``collaboration`` tools, which
        # this flag does not gate; it keeps the v1 tools, whose activity the
        # harness does not project, unavailable.
        "features.multi_agent": "false",
        # Counts the parent thread: at most this many threads run at once.
        "features.multi_agent_v2.max_concurrent_threads_per_session": str(MAX_AGENT_THREADS),
        # Removes send_message and followup_task, which can re-task a sub-agent
        # with no signal of whether a turn will follow. A sub-agent then runs
        # only the turn its spawn starts, which settles with its prompt.
        "features.multi_agent_v2.disable_direct_message": "true",
        "features.memories": "false",
        "features.apps": "false",
        "features.hooks": "false",
        "features.plugins": "false",
        # Shell snapshots export the child environment, including sandbox
        # authority. Native history must never persist that state.
        "features.shell_snapshot": "false",
        "features.shell_snapshot_v2": "false",
        # API-key model discovery sends the API key to the ChatGPT backend's
        # model catalog. API keys stay on the OpenAI API.
        "features.api_key_model_discovery": "false",
        "analytics.enabled": "false",
        "feedback.enabled": "false",
        "check_for_update_on_startup": "false",
        "history.persistence": '"none"',
        "log_dir": json.dumps(str(state_dir / "logs")),
        "sqlite_home": json.dumps(str(state_dir)),
    }
    return tuple(value for key, item in overrides.items() for value in ("-c", f"{key}={item}"))


def mcp_configuration(
    servers: tuple[Mapping[str, Any], ...],
) -> dict[str, Any]:
    """Translate session MCP settings to Codex's native transport configuration.

    Like the existing harnesses, configured MCP credentials are sandbox-scoped.
    Native thread state may persist these settings; do not copy them into the
    app-server's environment or log them.
    """

    result: dict[str, Any] = {}
    for index, server in enumerate(servers):
        if server.get("enabled") is False:
            continue
        name = str(server.get("name") or f"external-{index}")
        if name == "oi" or name in result:
            raise HarnessStartError(
                "MCP server name conflicts with a reserved or duplicate namespace"
            )
        for field in ("environment", "env", "headers"):
            values = server.get(field)
            if values is not None and (
                not isinstance(values, Mapping)
                or not all(isinstance(k, str) and isinstance(v, str) for k, v in values.items())
            ):
                raise HarnessStartError("Invalid MCP environment or headers")
        config: dict[str, Any] = {"startup_timeout_sec": 30, "tool_timeout_sec": 120}
        command = server.get("command")
        if server.get("type") == "local" or command:
            if (
                not isinstance(command, list)
                or not command
                or not all(isinstance(x, str) for x in command)
            ):
                raise HarnessStartError("Local MCP server requires a command array")
            config.update(command=command[0], args=command[1:])
            environment = server.get("env") or server.get("environment")
            if environment:
                config["env"] = dict(environment)
        else:
            url = server.get("url")
            if not isinstance(url, str) or not url.strip():
                raise HarnessStartError("Remote MCP server requires a URL")
            parsed = urlsplit(url)
            if parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise HarnessStartError(
                    "Credential-bearing MCP URLs are not supported by the Codex harness"
                )
            config["url"] = url
            headers = server.get("headers") or server.get("env")
            if headers:
                config["http_headers"] = dict(headers)
        result[name] = config
    return result

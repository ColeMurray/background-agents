"""Canonical sandbox toolchain install contract shared by Python providers."""

# OpenCode version to install.
#
# Pinned to 1.14.41 — the last release before opencode's Hono → Effect Schema
# migration (landed across v1.14.42+, released 2026-05-09 onward) broke event
# publishing on the legacy `/event` SSE endpoint. With newer versions the
# bridge connects, posts the prompt, opencode processes it and records the
# assistant response in the session store, but no `message.updated` /
# `message.part.updated` / `session.idle` events are streamed back — so the
# session shows execution_complete with no reply.
#
# Symptom in bridge logs: `prompt.run outcome=success duration_ms=35-367`,
# which means `_stream_opencode_response_sse` returned with zero yielded
# events. Tracked in #567.
OPENCODE_VERSION = "1.14.41"
CODE_SERVER_VERSION = "4.109.5"
AGENT_BROWSER_VERSION = "0.21.2"
TTYD_VERSION = "1.7.7"
TTYD_SHA256 = "8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55"


def opencode_deps_staging_commands() -> tuple[str, ...]:
    """Commands that pre-stage OpenCode plugin deps and global config."""
    return (
        "mkdir -p /app/opencode-deps",
        f'echo \'{{"name":"opencode-tools","type":"module",'
        f'"dependencies":{{"@opencode-ai/plugin":"{OPENCODE_VERSION}"}}}}\''
        " > /app/opencode-deps/package.json",
        "cd /app/opencode-deps && npm install --ignore-scripts --no-audit --no-fund",
        "mkdir -p /root/.config/opencode",
        "cp -a /app/opencode-deps/. /root/.config/opencode/",
    )


def ttyd_install_commands() -> tuple[str, ...]:
    """Commands that install pinned ttyd from the upstream release binary."""
    return (
        f"curl -fsSL -o /usr/local/bin/ttyd "
        f"https://github.com/tsl0922/ttyd/releases/download/{TTYD_VERSION}/ttyd.x86_64",
        f'echo "{TTYD_SHA256}  /usr/local/bin/ttyd" | sha256sum -c -',
        "chmod +x /usr/local/bin/ttyd",
        "ttyd --version",
    )


def git_credential_helper_commands() -> tuple[str, ...]:
    """Commands that install and configure the Open-Inspect git credential helper."""
    return (
        "printf '%s\\n'"
        " '#!/bin/sh'"
        " 'exec python3 -m sandbox_runtime.credentials.git_credential_helper \"$@\"'"
        " > /usr/local/bin/oi-git-credentials",
        "chmod 0755 /usr/local/bin/oi-git-credentials",
        "git config --system credential.helper /usr/local/bin/oi-git-credentials",
        "git config --system credential.useHttpPath true",
    )

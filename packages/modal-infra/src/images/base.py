"""
Base image definition for Open-Inspect sandboxes.

This image provides a complete development environment with:
- Debian slim base with git, curl, build-essential
- Node.js 22 LTS, pnpm, Bun runtime
- Python 3.12 with uv
- OpenCode CLI pre-installed
- agent-browser CLI with headless Chrome for browser automation
- ffmpeg for browser video encoding
- Sandbox entrypoint and bridge code
"""

import os
from pathlib import Path

import modal

import sandbox_runtime

# Modal reads image builder version from process/workspace config while resolving
# images, not from an individual image option. Docker-in-sandbox launch support
# requires the 2025.06 builder, so set a default for every image defined here
# while preserving an explicit deployment override.
os.environ.setdefault("MODAL_IMAGE_BUILDER_VERSION", "2025.06")

# Get the path to the sandbox runtime code (provider-agnostic)
SANDBOX_RUNTIME_DIR = Path(sandbox_runtime.__file__).parent

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

# code-server version to install (pinned for reproducible images)
CODE_SERVER_VERSION = "4.109.5"

# agent-browser version to install (pinned for reproducible images)
AGENT_BROWSER_VERSION = "0.21.2"

# ttyd version to install (pinned for reproducible images)
TTYD_VERSION = "1.7.7"
TTYD_SHA256 = "8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55"
DOCKER_CE_VERSION = "5:29.5.2-1~debian.12~bookworm"
DOCKER_CE_CLI_VERSION = "5:29.5.2-1~debian.12~bookworm"
CONTAINERD_VERSION = "2.2.4-1~debian.12~bookworm"
DOCKER_BUILDX_PLUGIN_VERSION = "0.34.1-1~debian.12~bookworm"
DOCKER_COMPOSE_PLUGIN_VERSION = "5.1.4-1~debian.12~bookworm"
RUNC_VERSION = "1.3.0"
RUNC_SHA256 = "028986516ab5646370edce981df2d8e8a8d12188deaf837142a02097000ae2f2"

# Cache buster - change this to force Modal image rebuild
# v51: SCM credential helper backed by control plane; remove embedded VCS tokens
CACHE_BUSTER = "v51-scm-credential-helper"

# Base image with all development tools
base_image = (
    modal.Image.debian_slim(python_version="3.12")
    # System packages
    .apt_install(
        "git",
        "curl",
        "build-essential",
        "ca-certificates",
        "gnupg",
        "openssh-client",
        "jq",
        "unzip",  # Required for Bun installation
        "ffmpeg",
        # Shared libraries required by headless Chromium
        "libnss3",
        "libnspr4",
        "libatk1.0-0",
        "libatk-bridge2.0-0",
        "libcups2",
        "libdrm2",
        "libxkbcommon0",
        "libxcomposite1",
        "libxdamage1",
        "libxfixes3",
        "libxrandr2",
        "libgbm1",
        "libasound2",
        "libpango-1.0-0",
        "libcairo2",
    )
    # Install GitHub CLI (for agent-direct GitHub interaction via gh API)
    .run_commands(
        "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg"
        " | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg",
        "echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg]"
        " https://cli.github.com/packages stable main'"
        " > /etc/apt/sources.list.d/github-cli.list",
        "apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*",
    )
    # Install Node.js 22 LTS
    .run_commands(
        # Add NodeSource repository for Node.js 22
        "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
        "apt-get install -y nodejs",
        # Verify installation
        "node --version",
        "npm --version",
    )
    # Install pnpm and Bun
    .run_commands(
        # Install pnpm globally
        "npm install -g pnpm@latest",
        "pnpm --version",
        # Install Bun
        "curl -fsSL https://bun.sh/install | bash",
        # Add Bun to PATH for subsequent commands
        'echo "export BUN_INSTALL="$HOME/.bun"" >> /etc/profile.d/bun.sh',
        'echo "export PATH="$BUN_INSTALL/bin:$PATH"" >> /etc/profile.d/bun.sh',
    )
    # Install Python tools
    .pip_install(
        "uv",
        "httpx",
        "websockets",
        "pydantic>=2.0",  # Required for sandbox types
        "PyJWT[crypto]",  # For GitHub App token generation (includes cryptography)
    )
    # Install OpenCode CLI and plugin for custom tools
    # CACHE_BUSTER is embedded in a no-op echo so Modal invalidates this layer on bump.
    .run_commands(
        f"echo 'cache: {CACHE_BUSTER}' > /dev/null",
        f"npm install -g opencode-ai@{OPENCODE_VERSION}",
        "opencode --version || echo 'OpenCode installed'",
        # Install @opencode-ai/plugin globally for custom tools
        # This ensures tools can import the plugin without needing to run bun add
        f"npm install -g @opencode-ai/plugin@{OPENCODE_VERSION} zod",
    )
    # Pre-build OpenCode plugin deps into a staging directory.
    # At boot, _install_tools() copies these into .opencode/ so that
    # OpenCode's Npm.install() finds package-lock.json in sync and skips
    # the slow arborist reify() call (2-22s) that would otherwise block
    # the first prompt and exceed the bridge's HTTP timeout.
    .run_commands(
        "mkdir -p /app/opencode-deps",
        # Pin staged plugin to OPENCODE_VERSION so the pre-staged tree copied
        # into .opencode/ at boot matches the globally installed plugin (#567).
        f'echo \'{{"name":"opencode-tools","type":"module",'
        f'"dependencies":{{"@opencode-ai/plugin":"{OPENCODE_VERSION}"}}}}\''
        " > /app/opencode-deps/package.json",
        "cd /app/opencode-deps && npm install --ignore-scripts --no-audit --no-fund",
    )
    # Install code-server for browser-based VS Code editing (direct .deb from GitHub releases)
    .run_commands(
        f"curl -fsSL -o /tmp/code-server.deb"
        f" https://github.com/coder/code-server/releases/download/v{CODE_SERVER_VERSION}"
        f"/code-server_{CODE_SERVER_VERSION}_amd64.deb",
        "dpkg -i /tmp/code-server.deb",
        "rm /tmp/code-server.deb",
        "code-server --version",
    )
    # Install ttyd web terminal (direct binary from GitHub releases)
    .run_commands(
        f"curl -fsSL -o /usr/local/bin/ttyd"
        f" https://github.com/tsl0922/ttyd/releases/download/{TTYD_VERSION}"
        f"/ttyd.x86_64",
        f'echo "{TTYD_SHA256}  /usr/local/bin/ttyd" | sha256sum -c -',
        "chmod +x /usr/local/bin/ttyd",
        "ttyd --version",
    )
    # Install agent-browser CLI and download Chromium
    .run_commands(
        f"npm install -g agent-browser@{AGENT_BROWSER_VERSION}",
        "agent-browser install",
        "agent-browser --version",
    )
    # Create working directories
    .run_commands(
        "mkdir -p /workspace",
        "mkdir -p /app/plugins",
        "mkdir -p /tmp/opencode",
        "echo 'Image rebuilt at: v21-force-rebuild' > /app/image-version.txt",
    )
    # Install the git credential helper shim.
    #
    # Each `git` invocation in the sandbox runs this shim, which delegates to
    # the sandbox-runtime helper module. The helper talks to the control plane
    # to mint fresh per-request credentials, so git operations no longer rely
    # on a 1h-TTL token captured at sandbox creation time. Configured at the
    # system level so it applies before entrypoint.py has a chance to run
    # (e.g. when restoring a snapshot whose first action is a `git fetch`).
    .run_commands(
        "printf '%s\\n'"
        " '#!/bin/sh'"
        " 'exec python3 -m sandbox_runtime.credentials.git_credential_helper \"$@\"'"
        " > /usr/local/bin/oi-git-credentials",
        "chmod 0755 /usr/local/bin/oi-git-credentials",
        "git config --system credential.helper /usr/local/bin/oi-git-credentials",
        # Pass the repo path to the helper so it can scope credentials to the
        # session repo, not just the host.
        "git config --system credential.useHttpPath true",
    )
    # Set environment variables (including cache buster to force rebuild)
    .env(
        {
            "HOME": "/root",
            "NODE_ENV": "development",
            "PNPM_HOME": "/root/.local/share/pnpm",
            "PATH": "/root/.bun/bin:/root/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin",
            "PYTHONPATH": "/app",
            "SANDBOX_VERSION": CACHE_BUSTER,
            # NODE_PATH for globally installed modules (used by custom tools)
            "NODE_PATH": "/usr/lib/node_modules",
        }
    )
    # Add sandbox runtime code to the image (provider-agnostic bridge, entrypoint, tools, plugins)
    .add_local_dir(
        str(SANDBOX_RUNTIME_DIR),
        remote_path="/app/sandbox_runtime",
    )
)

# Image variant optimized for Node.js/TypeScript projects
node_image = base_image.run_commands(
    # Pre-cache common Node.js development dependencies
    "npm cache clean --force",
)

# Image variant with Docker Engine, Buildx, and Docker Compose for Modal's
# Docker-in-Sandboxes alpha. The runtime starts dockerd on demand.
docker_image = (
    base_image.apt_install("iproute2", "iptables", "wget")
    .run_commands(
        "install -m 0755 -d /etc/apt/keyrings",
        "curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc",
        "chmod a+r /etc/apt/keyrings/docker.asc",
        'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] '
        'https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" '
        "> /etc/apt/sources.list.d/docker.list",
        "apt-get update && apt-get install -y "
        f"docker-ce={DOCKER_CE_VERSION} "
        f"docker-ce-cli={DOCKER_CE_CLI_VERSION} "
        f"containerd.io={CONTAINERD_VERSION} "
        f"docker-buildx-plugin={DOCKER_BUILDX_PLUGIN_VERSION} "
        f"docker-compose-plugin={DOCKER_COMPOSE_PLUGIN_VERSION} "
        "&& rm -rf /var/lib/apt/lists/*",
    )
    .run_commands(
        "rm -f $(command -v runc)",
        f"wget -q https://github.com/opencontainers/runc/releases/download/v{RUNC_VERSION}/runc.amd64",
        f'echo "{RUNC_SHA256}  runc.amd64" | sha256sum -c -',
        "chmod +x runc.amd64",
        "mv runc.amd64 /usr/local/bin/runc",
        "update-alternatives --set iptables /usr/sbin/iptables-legacy",
        "update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy",
        "mkdir -p /opt/docker-data",
        "docker --version",
        "docker compose version",
        "runc --version",
    )
)

# Image variant optimized for Python projects
python_image = base_image.run_commands(
    # Pre-create virtual environment
    "uv venv /workspace/.venv",
)

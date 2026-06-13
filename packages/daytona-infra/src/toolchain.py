"""Repo-local Daytona base snapshot builder."""

from __future__ import annotations

import time
from pathlib import Path

from daytona import CreateSnapshotParams, Daytona, Image

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
# Bump when changing image contents to invalidate the Daytona snapshot.
# daytona-v2: install the SCM credential-helper shim and configure
# git system-wide so per-request token brokerage matches the Modal base image.
SANDBOX_VERSION = "daytona-v2-credential-helper"
SANDBOX_ENTRYPOINT = ["/bin/sh", "-lc", "exec python3 -m sandbox_runtime.entrypoint"]
SNAPSHOT_DELETE_TIMEOUT_SECONDS = 180
SNAPSHOT_READY_TIMEOUT_SECONDS = 300


def build_base_image(repo_root: Path) -> Image:
    """Build the Open-Inspect Daytona base image."""
    sandbox_runtime_dir = (
        repo_root / "packages" / "sandbox-runtime" / "src" / "sandbox_runtime"
    )

    return (
        # Build on Daytona's stock sandbox image so custom snapshots stay
        # compatible with the runner pool used for normal sandbox launches.
        Image.base("daytonaio/sandbox:0.8.0")
        .dockerfile_commands(["USER root"])
        .run_commands(
            "apt-get update",
            "apt-get install -y python3 python3-pip python-is-python3 "
            "git curl build-essential ca-certificates gnupg "
            "openssh-client jq unzip libnss3 libnspr4 libatk1.0-0 "
            "libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 "
            "libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 "
            "libpango-1.0-0 libcairo2 ffmpeg",
            "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg "
            "| dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg",
            "echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] "
            "https://cli.github.com/packages stable main' "
            "> /etc/apt/sources.list.d/github-cli.list",
            "apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*",
            "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
            "apt-get install -y nodejs",
            "npm install -g pnpm@latest",
            "curl -fsSL https://bun.sh/install | bash",
            "python -m pip install --upgrade pip",
        )
        .pip_install(
            "uv",
            "httpx",
            "websockets",
            "pydantic>=2.0",
            "PyJWT[crypto]",
        )
        .run_commands(
            f"npm install -g opencode-ai@{OPENCODE_VERSION}",
            f"npm install -g @opencode-ai/plugin@{OPENCODE_VERSION} zod",
            f"curl -fsSL -o /tmp/code-server.deb "
            f"https://github.com/coder/code-server/releases/download/v{CODE_SERVER_VERSION}/"
            f"code-server_{CODE_SERVER_VERSION}_amd64.deb",
            "dpkg -i /tmp/code-server.deb",
            "rm /tmp/code-server.deb",
            f"npm install -g agent-browser@{AGENT_BROWSER_VERSION}",
            "agent-browser install",
            "mkdir -p /workspace /app /tmp/opencode",
            # Install the SCM credential-helper shim and configure git
            # system-wide. The shim delegates to the Python helper module
            # under sandbox_runtime, baked in at build time via add_local_dir
            # below. Mirror packages/modal-infra/src/images/base.py.
            "printf '%s\\n'"
            " '#!/bin/sh'"
            ' \'exec python3 -m sandbox_runtime.credentials.git_credential_helper "$@"\''
            " > /usr/local/bin/oi-git-credentials",
            "chmod 0755 /usr/local/bin/oi-git-credentials",
            "git config --system credential.helper /usr/local/bin/oi-git-credentials",
            # Pass the repo path to the helper so it can scope credentials to
            # the session repo, not just the host.
            "git config --system credential.useHttpPath true",
        )
        .env(
            {
                "HOME": "/root",
                "NODE_ENV": "development",
                "PATH": "/root/.bun/bin:/usr/local/bin:/usr/bin:/bin",
                "PYTHONPATH": "/app",
                "NODE_PATH": "/usr/lib/node_modules",
                "SANDBOX_VERSION": SANDBOX_VERSION,
            }
        )
        .add_local_dir(str(sandbox_runtime_dir), "/app/sandbox_runtime")
        .workdir("/workspace")
    )


def _snapshot_state_name(snapshot: object) -> str:
    state = getattr(snapshot, "state", "")
    return str(getattr(state, "value", state)).lower()


def _delete_snapshot_if_present(daytona: Daytona, name: str) -> None:
    try:
        snapshot = daytona.snapshot.get(name)
    except Exception:
        return

    daytona.snapshot.delete(snapshot)
    deadline = time.monotonic() + SNAPSHOT_DELETE_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        try:
            daytona.snapshot.get(name)
        except Exception:
            return
        print(f"Waiting for snapshot {name!r} deletion to complete...")
        time.sleep(3)

    raise TimeoutError(f"Timed out waiting for snapshot {name!r} deletion")


def _wait_for_snapshot_active(daytona: Daytona, name: str) -> object:
    deadline = time.monotonic() + SNAPSHOT_READY_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        snapshot = daytona.snapshot.get(name)
        state = _snapshot_state_name(snapshot)
        if state == "active":
            return snapshot
        if state in {"error", "failed"}:
            reason = getattr(snapshot, "error_reason", None) or getattr(snapshot, "errorReason", "")
            raise RuntimeError(f"Snapshot {name!r} failed: {reason}")
        print(f"Waiting for snapshot {name!r} to become active ({state})...")
        time.sleep(3)

    raise TimeoutError(f"Timed out waiting for snapshot {name!r} to become active")


def create_base_snapshot(daytona: Daytona, repo_root: Path, snapshot_name: str) -> None:
    """Create the named base snapshot from the current repo contents."""
    image = build_base_image(repo_root)
    build_snapshot_name = f"{snapshot_name}-build"
    _delete_snapshot_if_present(daytona, build_snapshot_name)
    daytona.snapshot.create(
        CreateSnapshotParams(
            name=build_snapshot_name,
            image=image,
            entrypoint=SANDBOX_ENTRYPOINT,
        ),
        on_logs=lambda chunk: print(chunk, end="\n"),
    )
    built_snapshot = _wait_for_snapshot_active(daytona, build_snapshot_name)

    daytona.snapshot.create(
        CreateSnapshotParams(
            name=snapshot_name,
            image=getattr(built_snapshot, "ref"),
            entrypoint=SANDBOX_ENTRYPOINT,
        )
    )
    _wait_for_snapshot_active(daytona, snapshot_name)

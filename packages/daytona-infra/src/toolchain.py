"""Repo-local Daytona base snapshot builder."""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

from daytona import CreateSnapshotParams, Daytona, Image

# Bump when changing image contents to invalidate the Daytona snapshot.
# daytona-v3: align ttyd and OpenCode dependency staging with Modal/Vercel.
SANDBOX_VERSION = "daytona-v3-opencode-deps-ttyd"


def load_toolchain_contract(repo_root: Path) -> ModuleType:
    """Load the canonical sandbox-runtime toolchain contract from this checkout."""
    toolchain_path = (
        repo_root
        / "packages"
        / "sandbox-runtime"
        / "src"
        / "sandbox_runtime"
        / "toolchain.py"
    )
    spec = importlib.util.spec_from_file_location("sandbox_runtime.toolchain", toolchain_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load sandbox toolchain contract from {toolchain_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build_base_image(repo_root: Path) -> Image:
    """Build the Open-Inspect Daytona base image."""
    toolchain = load_toolchain_contract(repo_root)
    sandbox_runtime_dir = (
        repo_root / "packages" / "sandbox-runtime" / "src" / "sandbox_runtime"
    )

    return (
        Image.base("python:3.12-slim-bookworm")
        .run_commands(
            "apt-get update",
            "apt-get install -y git curl build-essential ca-certificates gnupg "
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
            f"npm install -g opencode-ai@{toolchain.OPENCODE_VERSION}",
            f"npm install -g @opencode-ai/plugin@{toolchain.OPENCODE_VERSION} zod",
            *toolchain.opencode_deps_staging_commands(),
            f"curl -fsSL -o /tmp/code-server.deb "
            f"https://github.com/coder/code-server/releases/download/v{toolchain.CODE_SERVER_VERSION}/"
            f"code-server_{toolchain.CODE_SERVER_VERSION}_amd64.deb",
            "dpkg -i /tmp/code-server.deb",
            "rm /tmp/code-server.deb",
            *toolchain.ttyd_install_commands(),
            f"npm install -g agent-browser@{toolchain.AGENT_BROWSER_VERSION}",
            "agent-browser install",
            "mkdir -p /workspace /app/plugins /tmp/opencode",
            # Install the SCM credential-helper shim and configure git
            # system-wide. The shim delegates to the Python helper module
            # under sandbox_runtime, baked in at build time via add_local_dir
            # below. Mirror packages/modal-infra/src/images/base.py.
            *toolchain.git_credential_helper_commands(),
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


def create_base_snapshot(daytona: Daytona, repo_root: Path, snapshot_name: str) -> None:
    """Create the named base snapshot from the current repo contents."""
    image = build_base_image(repo_root)
    daytona.snapshot.create(
        CreateSnapshotParams(
            name=snapshot_name,
            image=image,
            entrypoint=["python", "-m", "sandbox_runtime.entrypoint"],
        ),
        on_logs=lambda chunk: print(chunk, end="\n"),
    )

"""Build configuration shared by recipe planning and frozen-lock validation."""

import json
from pathlib import Path
from typing import Any

IMAGE_PACKAGE = Path("packages/sandbox-images")
RUNTIME_PACKAGE = Path("packages/sandbox-runtime")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text())


def runtime_environment(target: dict[str, str]) -> dict[str, str]:
    home = target["home"]
    prefix = f"{home}/.npm-global"
    user_bin = f"{home}/.local/bin"
    environment = {
        "HOME": home,
        "XDG_CONFIG_HOME": f"{home}/.config",
        "NODE_ENV": "development",
        "PYTHONPATH": "/app",
        "NODE_PATH": f"/opt/openinspect/tools/node_modules:{prefix}/lib/node_modules:/usr/lib/node_modules:/usr/local/lib/node_modules",
        "PATH": f"/opt/openinspect/python/bin:/opt/openinspect/node/bin:/opt/openinspect/tools/node_modules/.bin:{home}/.venv/bin:{user_bin}:{home}/.local/share/pnpm/bin:{home}/.local/share/pnpm:{home}/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:{prefix}/bin",
        "npm_config_prefix": prefix,
        "npm_config_cache": f"{home}/.npm-cache",
        "PNPM_HOME": f"{home}/.local/share/pnpm",
        "OPENINSPECT_BIN_INSTALL_DIR": user_bin,
        "OI_SCM_CRED_CACHE_DIR": f"{home}/.cache/openinspect/scm",
    }

    if target.get("workload") == "autarc":
        environment.update(
            {
                "COREPACK_HOME": "/opt/corepack",
                "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0",
                "GOPATH": "/opt/go",
                "GOMODCACHE": "/opt/go/pkg/mod",
                "GOTOOLCHAIN": "local",
                "POSTHOG_CLI_HOST": "https://eu.posthog.com",
            }
        )
        environment["PATH"] += ":/opt/go/bin"
    return environment

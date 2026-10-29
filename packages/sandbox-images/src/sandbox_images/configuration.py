"""Build configuration shared by recipe planning and frozen-lock validation."""

import json
from pathlib import Path
from typing import Any

IMAGE_PACKAGE = Path("packages/sandbox-images")
RUNTIME_PACKAGE = Path("packages/sandbox-runtime")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text())


def runtime_environment(target: dict[str, str]) -> dict[str, str]:
    """The launch environment baked into every image.

    The image's own bin directory heads PATH so a substrate's preinstalled
    copy of a pinned tool (Boat refreshes its npm-global coding agents under
    /usr/local/bin at every boot) can never shadow the one the image verified.
    """
    home = target["home"]
    prefix = f"{home}/.npm-global"
    user_bin = f"{home}/.local/bin"
    return {
        "HOME": home,
        "XDG_CONFIG_HOME": f"{home}/.config",
        "NODE_ENV": "development",
        "PYTHONPATH": "/app",
        "NODE_PATH": f"/opt/openinspect/tools/node_modules:{prefix}/lib/node_modules:/usr/lib/node_modules:/usr/local/lib/node_modules",
        "PATH": f"/opt/openinspect/bin:/opt/openinspect/python/bin:/opt/openinspect/node/bin:/opt/openinspect/tools/node_modules/.bin:{home}/.venv/bin:{user_bin}:{home}/.local/share/pnpm:{home}/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:{prefix}/bin",
        "npm_config_prefix": prefix,
        "npm_config_cache": f"{home}/.npm-cache",
        "PNPM_HOME": f"{home}/.local/share/pnpm",
        "OPENINSPECT_BIN_INSTALL_DIR": user_bin,
        "OI_SCM_CRED_CACHE_DIR": f"{home}/.cache/openinspect/scm",
    }

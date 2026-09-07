"""Stage installation files and calculate one conservative build cache key."""

from __future__ import annotations

import hashlib
import json
import re
import shlex
import shutil
import stat
import tempfile
from pathlib import Path
from typing import Any

from .configuration import IMAGE_PACKAGE, RUNTIME_PACKAGE, read_json, runtime_environment
from .locks import update_locks

PROVIDERS = ("modal", "daytona", "e2b", "vercel", "opencomputer")
EXCLUDED = {
    ".terraform",
    ".git",
    ".venv",
    ".env",
    ".env.local",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".ruff_cache",
    ".cache",
    "dist",
    "build",
    ".DS_Store",
}
PAYLOAD_ROOTS = (
    RUNTIME_PACKAGE / "src",
    RUNTIME_PACKAGE / "pyproject.toml",
    RUNTIME_PACKAGE / "uv.lock",
    *(IMAGE_PACKAGE / part for part in ("install", "verify", "locks", "toolchain.json")),
)
INFRA_MODULES = {
    "modal": "modal-app",
    "daytona": "daytona-infra",
    "e2b": "e2b-infra",
    "vercel": "vercel-sandbox-infra",
    "opencomputer": "opencomputer-infra",
}


def validate_toolchain(tools: dict[str, Any]) -> None:
    def version(value: str) -> tuple[int, ...]:
        if not re.fullmatch(r"[0-9]+(?:\.[0-9]+){2,3}", value):
            raise ValueError(f"Image tools must have exact release versions: {value}")
        return tuple(int(part) for part in value.split("."))

    if tools.get("schemaVersion") != 1:
        raise ValueError("Unsupported image toolchain schema")
    if version(tools["opencode"]) < version(tools["opencodeMinimum"]):
        raise ValueError("OpenCode is below the image toolchain minimum")
    for name in ("agentBrowser", "pnpm", "bun", "zod", "python"):
        version(tools[name])
    if not re.fullmatch(r"[a-f0-9]{64}", tools.get("agentBrowserSha256", "")):
        raise ValueError("agent-browser native binary must have a SHA-256 pin")
    archives = [
        tools[name]
        for name in (
            "uv",
            "codeServer",
            "ttyd",
            "chrome",
            "fluxbox",
            "libvncserver",
            "x11vnc",
            "novnc",
        )
    ]
    archives.extend(tools["node"].values())
    for pin in archives:
        version(pin["version"])
        if not re.fullmatch(r"[a-f0-9]{64}", pin["sha256"]):
            raise ValueError("Downloaded image tools must have a SHA-256 pin")


def source_files(root: Path, paths: tuple[Path, ...]) -> list[Path]:
    """Only declared payload/source roots are eligible; reject escaping links."""

    def walk(path: Path) -> list[Path]:
        if path.is_symlink():
            if path.readlink().is_absolute() or not path.resolve().is_relative_to(root):
                raise ValueError(f"Source symlink escapes checkout: {path}")
            return [path]
        if path.is_file():
            return [path]
        if not path.is_dir():
            raise FileNotFoundError(path)
        return [
            file
            for child in sorted(path.iterdir())
            if child.name not in EXCLUDED and child.suffix not in (".pyc", ".pyo")
            for file in walk(child)
        ]

    files = sorted({file for path in paths for file in walk(root / path)})
    for path in files:
        if path.is_symlink() and path.resolve() not in files:
            raise ValueError(f"Source symlink must point to another included file: {path}")
    return files


def plan_image(root: Path, provider: str) -> dict[str, Any]:
    root = root.resolve()
    if provider not in PROVIDERS:
        raise ValueError(f"Unsupported sandbox image provider: {provider}")
    validate_toolchain(read_json(root / IMAGE_PACKAGE / "toolchain.json"))
    target = read_json(root / IMAGE_PACKAGE / "targets.json")[provider]
    # Broad roots intentionally prefer an extra rebuild to missing a transitive input.
    paths = (
        *PAYLOAD_ROOTS,
        IMAGE_PACKAGE / "src",
        IMAGE_PACKAGE / "cli.py",
        IMAGE_PACKAGE / "pyproject.toml",
        IMAGE_PACKAGE / "uv.lock",
        IMAGE_PACKAGE / "targets.json",
        Path(f"packages/{provider}-infra"),
        Path(f"terraform/modules/{INFRA_MODULES[provider]}"),
    )
    if provider in ("vercel", "opencomputer"):
        paths += (Path("package-lock.json"),)
    if provider == "vercel":
        paths += (
            Path("packages/control-plane/src"),
            Path("packages/shared/src"),
            Path("packages/control-plane/scripts/build-vercel-base-snapshot.ts"),
            Path("packages/shared/package.json"),
            Path("packages/shared/tsconfig.json"),
        )
    digest = hashlib.sha256(provider.encode())
    for path in source_files(root, paths):
        # Boundaries, executable bits and link destinations also affect the build.
        content = str(path.readlink()).encode() if path.is_symlink() else path.read_bytes()
        digest.update(path.relative_to(root).as_posix().encode() + b"\0")
        digest.update(str(stat.S_IMODE(path.lstat().st_mode)).encode() + b"\0")
        digest.update(hashlib.sha256(content).digest())
    return {
        "provider": provider,
        "target": target,
        "runtimeVersion": read_json(
            root / RUNTIME_PACKAGE / "src/sandbox_runtime/runtime_manifest.json"
        )["runtimeVersion"],
        "runtimeEnv": runtime_environment(target),
        "buildHash": digest.hexdigest(),
    }


def pack_bundle(root: Path, provider: str, output_root: Path) -> Path:
    """Create a fresh context for each caller; no shared cache to reconcile."""
    root = root.resolve()
    update_locks(root, check=True)
    plan = plan_image(root, provider)
    output_root.mkdir(parents=True, exist_ok=True)
    destination = Path(tempfile.mkdtemp(prefix=f"{provider}-", dir=output_root))
    try:
        for source in source_files(root, PAYLOAD_ROOTS):
            target = destination / source.relative_to(root)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target, follow_symlinks=False)
        (destination / "build-config.json").write_text(json.dumps(plan) + "\n")
        toolchain = read_json(root / IMAGE_PACKAGE / "toolchain.json")
        variables = {
            "OI_BUILD_CACHE_KEY": plan["buildHash"],
            "OI_PROVIDER": provider,
            "OI_OS": plan["target"]["os"],
            "OI_RUNTIME_USER": plan["target"]["user"],
            "OI_RUNTIME_HOME": plan["target"]["home"],
            "PYTHON_VERSION": toolchain["python"],
            "AGENT_BROWSER_VERSION": toolchain["agentBrowser"],
            "AGENT_BROWSER_SHA256": toolchain["agentBrowserSha256"],
        }
        for name, key in (
            ("NODE", "node"),
            ("UV", "uv"),
            ("CODE_SERVER", "codeServer"),
            ("TTYD", "ttyd"),
            ("FLUXBOX", "fluxbox"),
            ("LIBVNCSERVER", "libvncserver"),
            ("X11VNC", "x11vnc"),
            ("NOVNC", "novnc"),
            ("CHROME", "chrome"),
        ):
            pin = toolchain[key][plan["target"]["node"]] if key == "node" else toolchain[key]
            variables[f"{name}_VERSION"] = pin["version"]
            variables[f"{name}_SHA256"] = pin["sha256"]
        (destination / "image-config.sh").write_text(
            "\n".join(f"export {key}={shlex.quote(value)}" for key, value in variables.items())
            + "\n"
        )

        return destination
    except BaseException:
        shutil.rmtree(destination)
        raise

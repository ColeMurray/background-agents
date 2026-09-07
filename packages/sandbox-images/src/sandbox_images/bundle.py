"""One inventory for rebuild planning and the bytes sent to every native builder."""

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

IMAGE_PACKAGE = Path("packages/sandbox-images")
RUNTIME_PACKAGE = Path("packages/sandbox-runtime")
PROVIDERS = ("modal", "daytona", "e2b", "vercel", "opencomputer")
EXCLUDED = {
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
PROVIDER_INPUTS = {
    "modal": (
        "packages/modal-infra/src/images",
        "packages/modal-infra/pyproject.toml",
        "packages/modal-infra/uv.lock",
        "packages/modal-infra/deploy.py",
        "terraform/modules/modal-app/scripts/deploy.sh",
    ),
    "daytona": (
        "packages/daytona-infra/src",
        "packages/daytona-infra/pyproject.toml",
        "packages/daytona-infra/uv.lock",
        "terraform/modules/daytona-infra/scripts/build-snapshot.sh",
    ),
    "e2b": (
        "packages/e2b-infra/build-template.py",
        "packages/e2b-infra/pyproject.toml",
        "packages/e2b-infra/uv.lock",
        "terraform/modules/e2b-infra/scripts/build-template.sh",
    ),
    "vercel": (
        "packages/vercel-infra/src",
        "packages/vercel-infra/package.json",
        "packages/control-plane/scripts/build-vercel-base-snapshot.ts",
        "packages/control-plane/src/sandbox/providers/vercel/client.ts",
        "terraform/modules/vercel-sandbox-infra/scripts/build-base-snapshot.sh",
        "package-lock.json",
    ),
    "opencomputer": (
        "packages/opencomputer-infra/src",
        "packages/opencomputer-infra/package.json",
        "package-lock.json",
        "terraform/modules/opencomputer-infra/scripts/build-base-snapshot.sh",
    ),
}


def read_json(path: Path) -> Any:
    return json.loads(path.read_text())


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


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


def runtime_environment(target: dict[str, str]) -> dict[str, str]:
    home = target["home"]
    prefix = f"{home}/.npm-global"
    user_bin = f"{home}/.local/bin"
    return {
        "HOME": home,
        "XDG_CONFIG_HOME": f"{home}/.config",
        "NODE_ENV": "development",
        "VIRTUAL_ENV": "/opt/openinspect/python",
        "PYTHONPATH": "/app",
        "NODE_PATH": f"/opt/openinspect/tools/node_modules:{prefix}/lib/node_modules:/usr/lib/node_modules:/usr/local/lib/node_modules",
        "PATH": f"/opt/openinspect/python/bin:/opt/openinspect/node/bin:/opt/openinspect/tools/node_modules/.bin:{home}/.venv/bin:{user_bin}:{home}/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:{prefix}/bin",
        "npm_config_prefix": prefix,
        "npm_config_cache": f"{home}/.npm-cache",
        "PNPM_HOME": f"{home}/.local/share/pnpm",
        "OPENINSPECT_BIN_INSTALL_DIR": user_bin,
        "OI_SCM_CRED_CACHE_DIR": f"{home}/.cache/openinspect/scm",
    }


def _walk(path: Path) -> list[Path]:
    if path.is_symlink() or path.is_file():
        return [path]
    if not path.exists():
        return []
    result = []
    for child in sorted(path.iterdir()):
        if child.name not in EXCLUDED and child.suffix not in (".pyc", ".pyo"):
            result.extend(_walk(child))
    return result


def _inventory_entry(root: Path, path: Path) -> dict[str, Any]:
    relative = path.relative_to(root).as_posix()
    if path.is_symlink():
        destination = path.resolve()
        if not destination.is_relative_to(root):
            raise ValueError(f"Image input symlink escapes the checkout: {relative}")
        return {"path": relative, "symlink": str(path.readlink()), "mode": 0o777}
    return {
        "path": relative,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "mode": 0o755 if path.stat().st_mode & stat.S_IXUSR else 0o644,
    }


def plan_image(root: Path, provider: str) -> dict[str, Any]:
    root = root.resolve()
    if provider not in PROVIDERS:
        raise ValueError(f"Unsupported sandbox image provider: {provider}")
    validate_toolchain(read_json(root / IMAGE_PACKAGE / "toolchain.json"))
    targets = read_json(root / IMAGE_PACKAGE / "targets.json")
    target = targets[provider]
    manifest = read_json(root / RUNTIME_PACKAGE / "src/sandbox_runtime/runtime_manifest.json")
    for required in ("pyproject.toml", "uv.lock"):
        if not (root / RUNTIME_PACKAGE / required).is_file():
            raise FileNotFoundError(root / RUNTIME_PACKAGE / required)
    paths = [
        RUNTIME_PACKAGE / "src",
        RUNTIME_PACKAGE / "pyproject.toml",
        RUNTIME_PACKAGE / "uv.lock",
    ]
    paths.extend(
        IMAGE_PACKAGE / part
        for part in (
            "src",
            "install",
            "verify",
            "locks",
            "toolchain.json",
            "targets.json",
            "runtime-environments.json",
            "pyproject.toml",
            "uv.lock",
            "cli.py",
        )
    )
    paths.extend(Path(part) for part in PROVIDER_INPUTS[provider])
    for part in paths:
        if not (root / part).exists():
            raise FileNotFoundError(root / part)
    files = sorted({p for part in paths for p in _walk(root / part)})
    other_os = "amazon-linux.sh" if target["os"] == "debian" else "debian.sh"
    files = [p for p in files if not (p.parent.name == "os" and p.name == other_os)]
    for path in files:
        if path.is_symlink() and (path.readlink().is_absolute() or path.resolve() not in files):
            raise ValueError(
                f"Image symlink must reference another bundled file: {path.relative_to(root)}"
            )
    inventory = [_inventory_entry(root, p) for p in files]
    identity = {"schemaVersion": 1, "provider": provider, "target": target, "inputs": inventory}
    return {
        **identity,
        "recipeDigest": hashlib.sha256(canonical_json(identity).encode()).hexdigest(),
        "runtimeVersion": manifest["runtimeVersion"],
        "runtimeEnv": runtime_environment(target),
    }


def pack_bundle(root: Path, provider: str, output_root: Path) -> Path:
    root = root.resolve()
    plan = plan_image(root, provider)
    output_root.mkdir(parents=True, exist_ok=True)
    destination = output_root / f"{provider}-{plan['recipeDigest']}"
    # Never mutate an existing bundle: native builders may still be reading it.
    staging = Path(tempfile.mkdtemp(prefix=f"{provider}-", dir=output_root))
    try:
        for entry in plan["inputs"]:
            source = root / entry["path"]
            target = staging / entry["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            if "symlink" in entry:
                target.symlink_to(entry["symlink"])
            else:
                shutil.copyfile(source, target)
                target.chmod(entry["mode"])
        (staging / "image-plan.json").write_text(canonical_json(plan) + "\n")
        toolchain = read_json(root / IMAGE_PACKAGE / "toolchain.json")
        variables = {
            "OI_PROVIDER": provider,
            "OI_OS": plan["target"]["os"],
            "OI_RUNTIME_USER": plan["target"]["user"],
            "OI_RUNTIME_HOME": plan["target"]["home"],
            "PYTHON_VERSION": toolchain["python"],
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
        (staging / "image-config.sh").write_text(
            "\n".join(f"export {key}={shlex.quote(value)}" for key, value in variables.items())
            + "\n"
        )
        if plan_image(root, provider) != plan:
            raise RuntimeError("Image inputs changed while staging; retry from a stable checkout")
        if destination.exists():
            _assert_same_bundle(staging, destination)
        else:
            try:
                staging.rename(destination)
            except OSError:
                if not destination.exists():
                    raise
                _assert_same_bundle(staging, destination)
        return destination
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def _assert_same_bundle(expected: Path, existing: Path) -> None:
    left = [_inventory_entry(expected, path) for path in _walk(expected)]
    right = [_inventory_entry(existing, path) for path in _walk(existing)]
    if left != right:
        raise RuntimeError(
            f"Existing image bundle was modified; remove only this bundle and retry: {existing}"
        )

"""Explicit lock updates; ordinary builds never invoke package resolution."""

from __future__ import annotations

import json
import subprocess
from typing import TYPE_CHECKING

from .configuration import IMAGE_PACKAGE, RUNTIME_PACKAGE, read_json

if TYPE_CHECKING:
    from pathlib import Path


def update_locks(root: Path, *, check: bool = False) -> None:
    package = root / IMAGE_PACKAGE
    tools = read_json(package / "toolchain.json")
    manifests = {
        "tools": {
            "opencode-ai": tools["opencode"],
            "@opencode-ai/plugin": tools["opencode"],
            "zod": tools["zod"],
            "agent-browser": tools["agentBrowser"],
            "pnpm": tools["pnpm"],
            "bun": tools["bun"],
        },
        "plugins": {"@opencode-ai/plugin": tools["opencode"]},
    }
    generated = {}
    for name, dependencies in manifests.items():
        generated[package / "locks" / name / "package.json"] = (
            json.dumps(
                {
                    "name": f"openinspect-{name}",
                    "private": True,
                    "type": "module",
                    "dependencies": dependencies,
                },
                indent=2,
            )
            + "\n"
        )
    python_tools = package / "locks/python-tools"
    generated[python_tools / "pyproject.toml"] = (
        '[project]\nname = "openinspect-image-python-tools"\nversion = "0.0.0"\nrequires-python = ">=3.12"\n'
        f'dependencies = ["hatchling=={tools["hatchling"]}", "websockify=={tools["websockify"]}"]\n\n[tool.uv]\npackage = false\n'
    )
    for path, expected in generated.items():
        if check:
            if not path.exists() or path.read_text() != expected:
                raise ValueError(
                    f"Generated image input is stale: {path.relative_to(root)}; run sandbox:images lock"
                )
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(expected)
    for name in manifests:
        directory = package / "locks" / name
        if check:
            lock = read_json(directory / "package-lock.json")
            if lock["packages"][""]["dependencies"] != manifests[name]:
                raise ValueError(f"{name} npm lock is stale; run sandbox:images lock")
        else:
            subprocess.run(
                [
                    "npm",
                    "install",
                    "--package-lock-only",
                    "--ignore-scripts",
                    "--no-audit",
                    "--no-fund",
                    "--workspaces=false",
                ],
                cwd=directory,
                check=True,
            )
    if not check:
        subprocess.run(["uv", "lock", "--project", str(python_tools)], check=True)
    for project, output in (
        (root / RUNTIME_PACKAGE, package / "locks/runtime.txt"),
        (python_tools, package / "locks/python-tools.txt"),
    ):
        exported = subprocess.run(
            [
                "uv",
                "export",
                "--project",
                str(project),
                "--locked",
                "--no-dev",
                "--no-emit-project",
                "--no-header",
                "--no-annotate",
            ],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        if check:
            if not output.exists() or output.read_text() != exported:
                raise ValueError(f"Python image lock is stale: {output.relative_to(root)}")
        else:
            output.write_text(exported)

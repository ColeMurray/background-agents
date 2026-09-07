"""Run a provider builder and return its verified native artifact reference."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from .bundle import PROVIDERS
from .locks import update_locks


def build_image(root: Path, provider: str) -> dict[str, Any]:
    if provider not in PROVIDERS:
        raise ValueError("Unknown image provider")
    update_locks(root, check=True)
    environment = dict(os.environ)
    commands = {
        "modal": (
            root / "packages/modal-infra",
            ["uv", "run", "--frozen", "python", "deploy.py", "--build-sandbox-image"],
        ),
        "daytona": (
            root / "packages/daytona-infra",
            ["uv", "run", "--frozen", "python", "-m", "src.bootstrap"],
        ),
        "e2b": (
            root / "packages/e2b-infra",
            ["uv", "run", "--frozen", "python", "build-template.py"],
        ),
        "vercel": (root, ["node", "packages/vercel-infra/dist/build-base-snapshot.js"]),
        "opencomputer": (root, ["node", "packages/opencomputer-infra/dist/build-template.js"]),
    }
    if provider in ("vercel", "opencomputer"):
        subprocess.run(["npm", "run", "build", "-w", "@open-inspect/shared"], cwd=root, check=True)
        subprocess.run(
            ["npm", "run", "build", "-w", f"@open-inspect/{provider}-infra"], cwd=root, check=True
        )
    with tempfile.TemporaryDirectory(prefix="openinspect-image-") as directory:
        output = Path(directory) / "result.json"
        environment["OPENINSPECT_IMAGE_RESULT"] = str(output)
        environment["OPENINSPECT_REPO_ROOT"] = str(root)
        cwd, command = commands[provider]
        subprocess.run(command, cwd=cwd, env=environment, check=True)
        result = json.loads(output.read_text())
        if not isinstance(result.get("reference"), str) or not result["reference"].strip():
            raise ValueError("Build did not return an artifact reference")
        return result


def write_build_result(reference: str) -> None:
    """Return a verified native reference; deployment owns its selection."""
    result = {"reference": reference}
    output = os.environ.get("OPENINSPECT_IMAGE_RESULT")
    if output:
        path = Path(output)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(result) + "\n")
    else:
        print(json.dumps(result))

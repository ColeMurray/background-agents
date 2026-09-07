"""Invoke thin native adapters; builds and restores share the verification gate."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from .locks import update_locks
from .releases import validate_record


def native_operation(
    root: Path, provider: str, candidate: dict[str, Any] | None = None
) -> dict[str, Any]:
    update_locks(root, check=True)
    environment = dict(os.environ)
    if candidate is not None:
        validate_record(candidate)
        if candidate["artifact"]["provider"] != provider:
            raise ValueError("Candidate provider mismatch")
        environment["OPENINSPECT_VERIFY_REFERENCE"] = candidate["artifact"]["reference"]
        environment["OPENINSPECT_EXPECTED_RECIPE"] = candidate["identity"]["recipeDigest"]
        environment.setdefault("DAYTONA_BASE_SNAPSHOT", candidate["artifact"]["reference"])
        environment.setdefault("E2B_TEMPLATE_ID", candidate["artifact"]["reference"])
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
    with tempfile.TemporaryDirectory(prefix="openinspect-candidate-") as directory:
        output = Path(directory) / "candidate.json"
        environment["OPENINSPECT_IMAGE_RESULT"] = str(output)
        environment["OPENINSPECT_REPO_ROOT"] = str(root)
        cwd, command = commands[provider]
        subprocess.run(command, cwd=cwd, env=environment, check=True)
        record = json.loads(output.read_text())
        validate_record(record)
        if candidate is not None and record["baseReleaseId"] != candidate["baseReleaseId"]:
            raise ValueError("Restored artifact no longer matches its recorded release")
        return record

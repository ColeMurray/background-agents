"""Daytona image transport; installation is owned by sandbox-images."""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING

from daytona import CreateSnapshotParams, Daytona, Image

if TYPE_CHECKING:
    from pathlib import Path


def build_base_image(repo_root: Path) -> Image:
    sys.path.insert(0, str(repo_root / "packages/sandbox-images/src"))
    from sandbox_images.bundle import pack_bundle, plan_image

    plan = plan_image(repo_root, "daytona")
    bundle = pack_bundle(repo_root, "daytona", repo_root / ".cache/sandbox-images")
    return (
        Image.base(plan["target"]["base"])
        .add_local_dir(str(bundle), "/tmp/openinspect-image")
        .run_commands("bash /tmp/openinspect-image/packages/sandbox-images/install/install.sh")
        .env(plan["runtimeEnv"] | {"SANDBOX_VERSION": plan["runtimeVersion"]})
        .workdir("/workspace")
    )


def create_base_snapshot(daytona: Daytona, repo_root: Path, snapshot_name: str) -> None:
    daytona.snapshot.create(
        CreateSnapshotParams(
            name=snapshot_name,
            image=build_base_image(repo_root),
            entrypoint=["python", "-m", "sandbox_runtime.entrypoint"],
        ),
        on_logs=lambda chunk: print(chunk, end="\n"),
    )

"""Daytona image transport; installation is owned by sandbox-images."""

from __future__ import annotations

from typing import TYPE_CHECKING

from daytona import CreateSnapshotParams, Daytona, Image

if TYPE_CHECKING:
    from sandbox_images.bundle import PackedBundle


def build_base_image(bundle: PackedBundle) -> Image:
    plan = bundle.plan
    return (
        Image.base(plan["target"]["base"])
        .add_local_dir(str(bundle.directory), "/tmp/openinspect-image")
        .run_commands("bash /tmp/openinspect-image/packages/sandbox-images/install/install.sh")
        .env(plan["runtimeEnv"] | {"SANDBOX_VERSION": plan["runtimeVersion"]})
        .workdir("/workspace")
    )


def create_base_snapshot(daytona: Daytona, bundle: PackedBundle, snapshot_name: str) -> None:
    daytona.snapshot.create(
        CreateSnapshotParams(
            name=snapshot_name,
            image=build_base_image(bundle),
            entrypoint=["python", "-m", "sandbox_runtime.entrypoint"],
        ),
        on_logs=lambda chunk: print(chunk, end="\n"),
    )

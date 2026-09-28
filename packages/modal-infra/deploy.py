#!/usr/bin/env python3
"""
Deployment entry point for Open-Inspect Modal app.

This file imports all modules to register their functions with the app.
Run the eager image build before deploying:
    python deploy.py --build-sandbox-image
    modal deploy deploy.py
"""

import argparse
import json
import os
import sys
from pathlib import Path

import modal

# Add src to path so imports work
sys.path.insert(0, str(Path(__file__).parent / "src"))

if __name__ == "__main__":
    # The eager builder must run before a verified image reference exists. Import
    # only build modules, without src.__init__ registering deployable functions.
    from app_config import APP_NAME
    from images.base import (
        MODAL_VM_EXPERIMENTAL_OPTIONS,
        base_image,
        base_image_plan,
        docker_image,
        image_reference_path,
    )
    from sandbox.launch_policy import VM_DEFAULT_CPU_CORES, VM_DEFAULT_MEMORY_MIB
else:
    # Modal imports this module to discover the fully registered application.
    from src.app import app
    from src.app_config import APP_NAME
    from src.images.base import (
        MODAL_VM_EXPERIMENTAL_OPTIONS,
        base_image,
        base_image_plan,
        docker_image,
        image_reference_path,
    )
    from src.sandbox.launch_policy import VM_DEFAULT_CPU_CORES, VM_DEFAULT_MEMORY_MIB

# Resources the Docker image is verified with; the same defaults the control
# plane freezes into a Docker session that configures none.
DOCKER_VERIFICATION_CPU_CORES = VM_DEFAULT_CPU_CORES
DOCKER_VERIFICATION_MEMORY_MIB = VM_DEFAULT_MEMORY_MIB


def _verify_image(sandbox: modal.Sandbox, *scripts: tuple[str, ...]) -> None:
    for script in scripts:
        process = sandbox.exec("/opt/openinspect/python/bin/python", *script, timeout=240)
        process.stdout.read()
        process.wait()
        if process.returncode != 0:
            raise RuntimeError(f"Modal image verification failed: {process.stderr.read()}")


def _publish_image_record(record: dict[str, str]) -> None:
    path = image_reference_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record) + "\n")


def _deployed_vm_image() -> str | None:
    """Retain the existing VM capability until the consumer selector has switched."""
    try:
        image_id = modal.Function.from_name(APP_NAME, "deployment_vm_image").remote()
    except modal.exception.NotFoundError:
        # First deployment, or a pre-VM app. Other failures must block deployment.
        return None
    if image_id is not None and (not isinstance(image_id, str) or not image_id.strip()):
        raise RuntimeError("Deployed VM image reference is invalid")
    return image_id


def build_sandbox_image(*, with_docker: bool = False) -> None:
    """Build the image used by dynamic sandboxes before requests can create them.

    The default image is verified and published first, so a failed Docker
    variant never replaces a known-good default reference.
    """
    if base_image_plan is None:
        raise RuntimeError("Modal sandbox image build requires a local packed image plan")
    deployed_app = modal.App.lookup(APP_NAME, create_if_missing=True)
    with modal.enable_output():
        base_image.build(deployed_app)
    from sandbox_images.native import write_build_result

    # Verify the concrete baked artifact, without local source mounts.
    sandbox = modal.Sandbox.create(
        "sleep",
        "infinity",
        app=deployed_app,
        image=modal.Image.from_id(base_image.object_id),
        env=base_image_plan["runtimeEnv"],
        # The desktop check starts Xvfb, fluxbox and x11vnc at once; without a
        # CPU request they run on Modal's small default share.
        cpu=2.0,
        timeout=300,
    )
    try:
        _verify_image(sandbox, ("/app/verify/smoke_test.py", "verify"))
        write_build_result(base_image.object_id)
    finally:
        sandbox.terminate()
    # Publish the function image reference only after fresh-artifact verification.
    record = {
        "imageId": base_image.object_id,
        "buildHash": base_image_plan["buildHash"],
    }
    if not with_docker:
        retained_vm_image = _deployed_vm_image()
        if retained_vm_image:
            record["dockerImageId"] = retained_vm_image
    _publish_image_record(record)
    if not with_docker:
        return

    if docker_image is None:
        raise RuntimeError("Docker sandbox image build requires a local packed image plan")
    with modal.enable_output():
        docker_image.build(deployed_app)
    # Verify on the VM runtime the variant is launched with, running the
    # standard smoke suite plus a real daemon, build, run and Compose check.
    sandbox = modal.Sandbox.create(
        "sleep",
        "infinity",
        app=deployed_app,
        image=modal.Image.from_id(docker_image.object_id),
        env=base_image_plan["runtimeEnv"],
        timeout=600,
        cpu=DOCKER_VERIFICATION_CPU_CORES,
        memory=DOCKER_VERIFICATION_MEMORY_MIB,
        experimental_options=dict(MODAL_VM_EXPERIMENTAL_OPTIONS),
    )
    try:
        _verify_image(
            sandbox,
            ("/app/verify/smoke_test.py", "verify"),
            ("/app/verify/docker_smoke.py",),
        )
    finally:
        sandbox.terminate()
    _publish_image_record({**record, "dockerImageId": docker_image.object_id})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--build-sandbox-image", action="store_true")
    args = parser.parse_args()
    if args.build_sandbox_image:
        # BUILD_MODAL_VM_IMAGE is the same switch Terraform and images/base.py read.
        build_sandbox_image(with_docker=os.environ.get("BUILD_MODAL_VM_IMAGE") == "true")


if __name__ == "__main__":
    main()

# Re-export the app for Modal
__all__ = ["app"]

"""Thin Modal adapter for the shared, baked sandbox installation bundle."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

import modal

from sandbox_runtime.runtime_manifest import RUNTIME_VERSION

CACHE_BUSTER = RUNTIME_VERSION
IMAGE_ID_ENV = "OPENINSPECT_MODAL_BASE_IMAGE_ID"
# The optional Docker-capable variant: the default image plus one install phase.
# Provisioned separately; absent until an operator builds and verifies it.
DOCKER_IMAGE_ID_ENV = "OPENINSPECT_MODAL_DOCKER_IMAGE_ID"
# The Modal option that launches a Docker-capable VM instead of a gVisor sandbox.
MODAL_VM_EXPERIMENTAL_OPTIONS: dict[str, bool] = {"vm_runtime": True}


def local_image_plan() -> tuple[Path, dict[str, Any]]:
    """Build-only imports must never execute inside deployed Modal functions."""
    root = Path(__file__).resolve().parents[4]
    sys.path.insert(0, str(root / "packages/sandbox-images/src"))
    from sandbox_images.bundle import pack_bundle

    bundle = pack_bundle(root, "modal", root / ".cache/sandbox-images")
    return bundle.directory, bundle.plan


def image_reference_path() -> Path:
    return Path(__file__).resolve().parents[2] / ".cache/sandbox-image.json"


def deployed_image_environment() -> dict[str, str]:
    """Bridge the eager image build to function deployment; never upload build tools."""
    if not modal.is_local():
        image_id = os.environ.get(IMAGE_ID_ENV)
        if not image_id:
            raise RuntimeError("Deployed Modal function is missing its verified sandbox image ID")
        environment = {IMAGE_ID_ENV: image_id}
        docker_image_id = os.environ.get(DOCKER_IMAGE_ID_ENV)
        if docker_image_id:
            environment[DOCKER_IMAGE_ID_ENV] = docker_image_id
        return environment
    path = image_reference_path()
    if not path.is_file():
        raise RuntimeError("Build the Modal sandbox image before deploying functions")
    record = json.loads(path.read_text())
    _bundle, plan = local_image_plan()
    if record["buildHash"] != plan["buildHash"]:
        raise RuntimeError("Built Modal image is stale; rebuild before deploying functions")
    image_id = record.get("imageId")
    if not isinstance(image_id, str) or not image_id.strip():
        raise RuntimeError("Built Modal image record is missing its verified sandbox image ID")
    environment = {IMAGE_ID_ENV: image_id}
    docker_image_id = record.get("dockerImageId")
    if docker_image_id is not None:
        if not isinstance(docker_image_id, str) or not docker_image_id.strip():
            raise RuntimeError("Built Modal image record has an invalid Docker image ID")
        environment[DOCKER_IMAGE_ID_ENV] = docker_image_id
    if os.environ.get("BUILD_MODAL_VM_IMAGE") == "true" and DOCKER_IMAGE_ID_ENV not in environment:
        raise RuntimeError("Build and verify the Docker sandbox image before deploying functions")
    return environment


def _define_image() -> tuple[modal.Image, dict[str, Any] | None]:
    if not modal.is_local():
        image_id = os.environ.get(IMAGE_ID_ENV)
        if not image_id:
            raise RuntimeError("Deployed Modal function is missing its verified sandbox image ID")
        return modal.Image.from_id(image_id), None
    bundle, plan = local_image_plan()
    image = (
        modal.Image.from_registry(plan["target"]["base"])
        .add_local_dir(str(bundle), "/tmp/openinspect-image", copy=True)
        .run_commands("bash /tmp/openinspect-image/packages/sandbox-images/install/install.sh")
        .env(plan["runtimeEnv"] | {"SANDBOX_VERSION": plan["runtimeVersion"]})
        .workdir("/workspace")
    )
    return image, plan


base_image, base_image_plan = _define_image()


def _define_docker_image() -> modal.Image | None:
    if not modal.is_local():
        image_id = os.environ.get(DOCKER_IMAGE_ID_ENV)
        return modal.Image.from_id(image_id) if image_id else None
    # Same bundle, one extra phase; the default image layers stay untouched.
    return base_image.run_commands(
        "bash /tmp/openinspect-image/packages/sandbox-images/install/install.sh docker"
    )


docker_image = _define_docker_image()

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


def local_image_plan() -> tuple[Path, dict[str, Any]]:
    """Build-only imports must never execute inside deployed Modal functions."""
    root = Path(__file__).resolve().parents[4]
    sys.path.insert(0, str(root / "packages/sandbox-images/src"))
    from sandbox_images.bundle import pack_bundle

    bundle = pack_bundle(root, "modal", root / ".cache/sandbox-images")
    plan = json.loads((bundle / "build-config.json").read_text())
    return bundle, plan


def image_reference_path() -> Path:
    return Path(__file__).resolve().parents[2] / ".cache/sandbox-image.json"


def deployed_image_environment() -> dict[str, str]:
    """Bridge the eager image build to function deployment; never upload build tools."""
    if not modal.is_local():
        image_id = os.environ.get(IMAGE_ID_ENV)
        if not image_id:
            raise RuntimeError("Deployed Modal function is missing its verified sandbox image ID")
        return {IMAGE_ID_ENV: image_id}
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
    return {IMAGE_ID_ENV: image_id}


def _define_image() -> modal.Image:
    if not modal.is_local():
        image_id = os.environ.get(IMAGE_ID_ENV)
        if not image_id:
            raise RuntimeError("Deployed Modal function is missing its verified sandbox image ID")
        return modal.Image.from_id(image_id)
    bundle, plan = local_image_plan()
    return (
        modal.Image.from_registry(plan["target"]["base"])
        .add_local_dir(str(bundle), "/tmp/openinspect-image", copy=True)
        .run_commands("bash /tmp/openinspect-image/packages/sandbox-images/install/install.sh")
        .env(plan["runtimeEnv"] | {"SANDBOX_VERSION": RUNTIME_VERSION})
        .workdir("/workspace")
    )


base_image = _define_image()

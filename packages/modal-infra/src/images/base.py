"""Thin Modal adapter for the shared, baked sandbox installation bundle."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

import modal

from sandbox_runtime.runtime_manifest import RUNTIME_VERSION

# Get the path to the sandbox runtime code (provider-agnostic)
SANDBOX_RUNTIME_DIR = Path(sandbox_runtime.__file__).parent

# OpenCode version to install.
#
# OpenCode restored `/event` stream context in 1.14.50 and fixed the remaining
# eager-subscription race in 1.15.5. Keep the CLI and plugin on the same pin.
#
# Never pin below 1.18.15: OpenCode's message-ID counter is a 48-bit truncation
# of `Date.now() * 0x1000`, so it wraps roughly every 795 days (most recently
# 2026-08-14) and IDs minted afterwards sort below every older one. Earlier
# releases order the turn loop by comparing those IDs as strings, which makes
# any session carrying pre-wraparound history exit the loop without calling the
# model. 1.18.15 orders by message creation time instead.
OPENCODE_VERSION = "1.18.25"

# code-server version to install (pinned for reproducible images)
CODE_SERVER_VERSION = "4.109.5"

# agent-browser version to install (pinned for reproducible images)
AGENT_BROWSER_VERSION = "0.21.2"

# ttyd version to install (pinned for reproducible images)
TTYD_VERSION = "1.7.7"
TTYD_SHA256 = "8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55"

# Cache buster - change this to force Modal image rebuild.
# The numeric generation is one sequence shared by every image-build provider,
# and MIN_REBUILD_RUNTIME_VERSION gates which prebuilt images get rebuilt onto
# it, so bump every provider's label together.
# v59: OpenCode past the message-ID wraparound (see OPENCODE_VERSION)
# v60: generic provider-account token broker plugin
# v61: account/init helpers and /usr/sbin on PATH
# v65: OpenCode 1.18.25; AppleDouble sidecars kept out of the runtime archive
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

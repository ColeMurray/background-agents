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
import sys
from pathlib import Path

import modal

# Add src to path so imports work
sys.path.insert(0, str(Path(__file__).parent / "src"))

if __name__ == "__main__":
    # The eager builder must run before a verified image reference exists. Import
    # only build modules, without src.__init__ registering deployable functions.
    from app_config import APP_NAME
    from images.base import base_image, image_reference_path, local_image_plan
else:
    # Modal imports this module to discover the fully registered application.
    from src.app import app
    from src.app_config import APP_NAME
    from src.images.base import base_image, image_reference_path, local_image_plan


def build_sandbox_image() -> None:
    """Build the image used by dynamic sandboxes before requests can create them."""
    deployed_app = modal.App.lookup(APP_NAME, create_if_missing=True)
    with modal.enable_output():
        base_image.build(deployed_app)
    _bundle, plan = local_image_plan()
    from sandbox_images.native import write_build_result

    # Verify the concrete baked artifact, without local source mounts.
    sandbox = modal.Sandbox.create(
        "sleep",
        "infinity",
        app=deployed_app,
        image=modal.Image.from_id(base_image.object_id),
        env=plan["runtimeEnv"],
        timeout=300,
    )
    try:
        process = sandbox.exec(
            "/opt/openinspect/python/bin/python",
            "/app/verify/smoke_test.py",
            "verify",
            timeout=240,
        )
        process.stdout.read()
        process.wait()
        if process.returncode != 0:
            raise RuntimeError(f"Modal image verification failed: {process.stderr.read()}")
        write_build_result(base_image.object_id)
    finally:
        sandbox.terminate()
    # Publish the function image reference only after fresh-artifact verification.
    record = {
        "imageId": base_image.object_id,
        "buildHash": plan["buildHash"],
    }
    path = image_reference_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--build-sandbox-image", action="store_true")
    args = parser.parse_args()
    if args.build_sandbox_image:
        build_sandbox_image()


if __name__ == "__main__":
    main()

# Re-export the app for Modal
__all__ = ["app"]

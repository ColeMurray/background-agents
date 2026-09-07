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

# Import the app
# Import modules to register functions with the app
# This makes all web endpoints and functions available
from src.app import app
from src.images.base import base_image, image_reference_path, local_image_plan


def build_sandbox_image() -> None:
    """Build the image used by dynamic sandboxes before requests can create them."""
    deployed_app = modal.App.lookup(app.name, create_if_missing=True)
    existing = os.environ.get("OPENINSPECT_VERIFY_REFERENCE") or os.environ.get(
        "OPENINSPECT_DEPLOY_IMAGE_ID"
    )
    if not existing:
        with modal.enable_output():
            base_image.build(deployed_app)
    _bundle, plan = local_image_plan()
    from sandbox_images.releases import candidate_record, write_candidate

    # Verify the concrete baked artifact, without local source mounts.
    sandbox = modal.Sandbox.create(
        "sleep",
        "infinity",
        app=deployed_app,
        image=modal.Image.from_id(existing or base_image.object_id),
        env=plan["runtimeEnv"],
        timeout=300,
    )
    try:
        process = sandbox.exec(
            "/opt/openinspect/python/bin/python",
            "/app/verify/image.py",
            "verify",
            "--expected-recipe",
            os.environ.get("OPENINSPECT_EXPECTED_RECIPE") or plan["recipeDigest"],
            timeout=240,
        )
        report_text = process.stdout.read()
        process.wait()
        if process.returncode != 0:
            raise RuntimeError(f"Modal image verification failed: {process.stderr.read()}")
        report = json.loads(report_text.strip().splitlines()[-1])
        write_candidate(
            candidate_record("modal", app.name, existing or base_image.object_id, report)
        )
    finally:
        sandbox.terminate()
    # Publish the function image reference only after fresh-artifact verification.
    if os.environ.get("OPENINSPECT_VERIFY_REFERENCE"):
        return
    record = {
        "imageId": existing or base_image.object_id,
        "recipeDigest": os.environ.get("OPENINSPECT_EXPECTED_RECIPE") or plan["recipeDigest"],
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

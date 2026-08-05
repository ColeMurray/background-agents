#!/usr/bin/env python3
"""
Deployment entry point for Open-Inspect Modal app.

This file imports all modules to register their functions with the app.
Run the eager image build before deploying:
    python deploy.py --build-sandbox-image
    modal deploy deploy.py
"""

import argparse
import sys
from pathlib import Path

import modal

# Add src to path so imports work
sys.path.insert(0, str(Path(__file__).parent / "src"))

# Import the app
# Import modules to register functions with the app
# This makes all web endpoints and functions available
from src.app import app
from src.images.base import base_image


def build_sandbox_image() -> None:
    """Build the image used by dynamic sandboxes before requests can create them."""
    deployed_app = modal.App.lookup(app.name, create_if_missing=True)
    with modal.enable_output():
        base_image.build(deployed_app)


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

#!/usr/bin/env python3
"""
Deployment entry point for Open-Inspect Modal app.

This file imports all modules to register their functions with the app.
Run with: modal deploy deploy.py
"""

import sys
from pathlib import Path

# Add src to path so imports work
sys.path.insert(0, str(Path(__file__).parent / "src"))

# Import the app and all modules that register functions with it
from src import functions, web_api  # noqa: F401
from src.app import app
from src.scheduler import image_builder  # noqa: F401

# Re-export the app for Modal
__all__ = ["app"]

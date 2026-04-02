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
# Add sandbox_runtime so app.py can import it (used to locate the runtime bundle)
sys.path.insert(0, str(Path(__file__).parent.parent / "sandbox-runtime" / "src"))

# Import the app
# Import modules to register functions with the app
# This makes all web endpoints and functions available
from src.app import app

# Re-export the app for Modal
__all__ = ["app"]

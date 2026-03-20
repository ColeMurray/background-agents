#!/usr/bin/env python3
"""
Deployment entry point for Open-Inspect Modal app.

This file bootstraps local monorepo package paths so `modal deploy deploy.py`
works from a clean checkout, then imports the full `src` package to register
all app functions.
"""

import sys
from importlib import import_module
from pathlib import Path

MODAL_INFRA_ROOT = Path(__file__).resolve().parent
SANDBOX_RUNTIME_SRC = MODAL_INFRA_ROOT.parent / "sandbox-runtime" / "src"
SANDBOX_RUNTIME_PACKAGE = SANDBOX_RUNTIME_SRC / "sandbox_runtime"


def _prepend_sys_path(path: Path) -> None:
    """Prepend a path to sys.path once."""
    path_str = str(path)
    if path_str not in sys.path:
        sys.path.insert(0, path_str)


def bootstrap_local_deploy_paths() -> Path:
    """
    Bootstrap local monorepo package paths for deployment.

    Modal deploy runs from `packages/modal-infra/`, but the extracted
    `sandbox_runtime` package lives in a sibling package and is not published to
    PyPI. Ensure both local packages are importable before importing `src`.
    """
    _prepend_sys_path(MODAL_INFRA_ROOT)
    _prepend_sys_path(SANDBOX_RUNTIME_SRC)

    expected_files = ("__init__.py", "entrypoint.py", "bridge.py")
    missing_files = [
        name for name in expected_files if not (SANDBOX_RUNTIME_PACKAGE / name).exists()
    ]
    if missing_files:
        raise RuntimeError(
            "sandbox_runtime package is incomplete for deploy. "
            f"Expected files under {SANDBOX_RUNTIME_PACKAGE}: {', '.join(missing_files)}"
        )

    try:
        sandbox_runtime = import_module("sandbox_runtime")
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "Could not import sandbox_runtime during deploy bootstrap. "
            "Ensure the local monorepo checkout includes packages/sandbox-runtime."
        ) from exc

    runtime_file = sandbox_runtime.__file__
    if runtime_file is None:
        raise RuntimeError(
            "sandbox_runtime package is missing a __file__ path. "
            "Ensure packages/sandbox-runtime is a regular package, not a namespace package."
        )

    return Path(runtime_file).resolve().parent


RUNTIME_DIR = bootstrap_local_deploy_paths()

# Import the package root so all Modal functions/endpoints are registered.
app = import_module("src").app

__all__ = ["RUNTIME_DIR", "SANDBOX_RUNTIME_SRC", "app", "bootstrap_local_deploy_paths"]

"""Deployment bootstrap and image path smoke tests."""

import sys
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


def _load_deploy_module():
    """Load deploy.py as a module for smoke testing."""
    sys.modules.pop("sandbox_runtime", None)

    deploy_path = Path(__file__).resolve().parents[1] / "deploy.py"
    spec = spec_from_file_location("modal_infra_deploy_test", deploy_path)
    assert spec is not None
    assert spec.loader is not None

    module = module_from_spec(spec)
    sys.modules["modal_infra_deploy_test"] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop("modal_infra_deploy_test", None)
        raise
    return module


def test_deploy_bootstrap_adds_sandbox_runtime_src() -> None:
    """Deploy bootstrap should expose the sibling sandbox-runtime package."""
    module = _load_deploy_module()

    expected_src = Path(__file__).resolve().parents[2] / "sandbox-runtime" / "src"
    assert expected_src == module.SANDBOX_RUNTIME_SRC
    assert expected_src / "sandbox_runtime" == module.RUNTIME_DIR
    assert (module.RUNTIME_DIR / "__init__.py").exists()
    assert (module.RUNTIME_DIR / "entrypoint.py").exists()


def test_base_image_uses_monorepo_sandbox_runtime_dir() -> None:
    """Base image should bundle sandbox-runtime from the repository checkout."""
    from src.images.base import SANDBOX_RUNTIME_DIR

    expected_dir = (
        Path(__file__).resolve().parents[2] / "sandbox-runtime" / "src" / "sandbox_runtime"
    )

    assert expected_dir == SANDBOX_RUNTIME_DIR
    assert (SANDBOX_RUNTIME_DIR / "__init__.py").exists()
    assert (SANDBOX_RUNTIME_DIR / "bridge.py").exists()

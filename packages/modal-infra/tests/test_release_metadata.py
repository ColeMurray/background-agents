from sandbox_runtime.release import MANAGED_RUNTIME_VERSION
from src.images.base import CACHE_BUSTER, SANDBOX_VERSION


def test_modal_runtime_version_uses_release_compatibility_prefix() -> None:
    assert f"v{MANAGED_RUNTIME_VERSION}-modal-{CACHE_BUSTER}" == SANDBOX_VERSION

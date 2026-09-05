from sandbox_runtime.runtime_manifest import OPENCODE_VERSION, RUNTIME_MANIFEST, RUNTIME_VERSION
from src.images.base import CACHE_BUSTER
from src.images.base import OPENCODE_VERSION as MODAL_OPENCODE_VERSION


def test_runtime_manifest_generation_matches_version() -> None:
    assert RUNTIME_VERSION.startswith(f"v{RUNTIME_MANIFEST['generation']}")
    assert CACHE_BUSTER == RUNTIME_VERSION
    assert MODAL_OPENCODE_VERSION == OPENCODE_VERSION
    assert RUNTIME_MANIFEST["minimumCompatibleGeneration"] <= RUNTIME_MANIFEST["generation"]
    assert RUNTIME_MANIFEST["minimumRebuildGeneration"] <= RUNTIME_MANIFEST["generation"]

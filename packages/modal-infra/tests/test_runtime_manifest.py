from sandbox_runtime.runtime_manifest import RUNTIME_MANIFEST, RUNTIME_VERSION
from src.images.base import CACHE_BUSTER


def test_runtime_manifest_generation_matches_version() -> None:
    assert RUNTIME_VERSION.startswith(f"v{RUNTIME_MANIFEST['generation']}")
    assert CACHE_BUSTER == RUNTIME_VERSION
    assert RUNTIME_MANIFEST["minimumCompatibleGeneration"] <= RUNTIME_MANIFEST["generation"]
    assert RUNTIME_MANIFEST["minimumRebuildGeneration"] <= RUNTIME_MANIFEST["generation"]


def test_plugin_runtime_floor_is_rebuilt_and_supported() -> None:
    assert RUNTIME_MANIFEST["minimumOpencodePluginsGeneration"] <= RUNTIME_MANIFEST["generation"]
    assert (
        RUNTIME_MANIFEST["minimumRebuildGeneration"]
        >= RUNTIME_MANIFEST["minimumOpencodePluginsGeneration"]
    )

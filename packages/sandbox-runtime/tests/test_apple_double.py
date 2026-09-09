"""AppleDouble sidecars must never be installed as OpenCode modules."""

from sandbox_runtime.opencode_server import is_apple_double


def test_recognizes_apple_double_sidecars():
    assert is_apple_double("._inspect-plugin.js")
    assert is_apple_double("._get-child-status.js")
    assert is_apple_double("._runtime_manifest.json")


def test_leaves_real_modules_alone():
    """A sidecar shares its file's extension, so only the prefix distinguishes them."""
    assert not is_apple_double("inspect-plugin.js")
    assert not is_apple_double("get-child-status.js")
    assert not is_apple_double("_private.js")
    assert not is_apple_double("some._thing.js")

from sandbox_runtime.harness.codex.env import CODEX_BINARY


def test_launches_the_pinned_install_not_a_substrate_link():
    assert CODEX_BINARY == "/opt/openinspect/codex/bin/codex"

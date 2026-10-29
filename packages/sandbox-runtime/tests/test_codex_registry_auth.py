from unittest.mock import MagicMock

import pytest

from sandbox_runtime import harness as registry
from sandbox_runtime.codex_stager import CodexHarnessHandoff
from sandbox_runtime.harness.base import HarnessId, PromptLimits


@pytest.mark.parametrize(
    "marker,managed", [("1", True), ("true", True), ("false", False), (None, False)]
)
@pytest.mark.asyncio
async def test_codex_registry_accepts_control_plane_managed_marker(
    tmp_path, monkeypatch, marker, managed
):
    if marker is None:
        monkeypatch.delenv("OPENAI_OAUTH_MANAGED", raising=False)
    else:
        monkeypatch.setenv("OPENAI_OAUTH_MANAGED", marker)
    monkeypatch.setenv("SESSION_CONFIG", '{"model":"gpt-6.1-sol"}')
    monkeypatch.setattr(
        CodexHarnessHandoff, "read", lambda: CodexHarnessHandoff(tmp_path, tmp_path / "state", True)
    )
    h = registry.build_agent_harness(
        HarnessId.CODEX,
        identity=registry.BridgeIdentity(
            "sandbox", "session", "https://cp.invalid", "sandbox-secret", tmp_path / "repos.json"
        ),
        attachment_processor=MagicMock(),
        log=MagicMock(),
        limits=PromptLimits(1, 30, 5),
        opencode_port=4096,
    )
    try:
        assert h.config.oauth_managed is managed
        assert (h._credentials is not None) is managed
    finally:
        await h.close()

"""Tests for AGENT_SLACK_NOTIFY_ENABLED env var passthrough in sandbox creation."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from src.sandbox.manager import SandboxConfig, SandboxManager
from src.sandbox.tunnels import SandboxTunnels, TunnelUrls


def _patch_create(monkeypatch, captured: dict) -> None:
    """Patch modal.Sandbox.create to capture the env passed in."""

    async def fake_create_aio(*args, **kwargs):
        captured["env"] = kwargs.get("env")

        class FakeSandbox:
            object_id = "obj-123"
            stdout = None

        return FakeSandbox()

    fake_create = MagicMock()
    fake_create.aio = fake_create_aio
    monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", fake_create)
    monkeypatch.setattr(
        SandboxTunnels,
        "resolve",
        AsyncMock(return_value=TunnelUrls(None, None, None, None)),
    )


class TestCreateSandboxAgentSlackNotify:
    """create_sandbox sets AGENT_SLACK_NOTIFY_ENABLED only when configured on."""

    @pytest.mark.asyncio
    async def test_env_omitted_when_disabled(self, monkeypatch):
        captured: dict = {}
        _patch_create(monkeypatch, captured)

        manager = SandboxManager()
        config = SandboxConfig(
            clone_host="github.com",
            clone_username="x-access-token",
            repo_owner="acme",
            repo_name="repo",
            control_plane_url="https://cp.example.com",
            sandbox_auth_token="token-123",
            agent_slack_notify_enabled=False,
        )

        await manager.create_sandbox(config)

        assert "AGENT_SLACK_NOTIFY_ENABLED" not in captured["env"]

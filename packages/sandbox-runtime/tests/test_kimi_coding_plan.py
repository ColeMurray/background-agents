"""Kimi Coding Plan uses the coding endpoint only when its plan key is available."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tests.runtime_helpers import make_opencode_server


@pytest.mark.parametrize("plan_key", [None, "test-plan-key"])
async def test_opencode_kimi_coding_plan_provider(tmp_path, monkeypatch, plan_key):
    if plan_key is None:
        monkeypatch.delenv("KIMI_CODE_API_KEY", raising=False)
    else:
        monkeypatch.setenv("KIMI_CODE_API_KEY", plan_key)

    server = make_opencode_server({}, workspace_path=tmp_path)
    with (
        patch.object(server, "_setup_managed_oauth"),
        patch.object(server, "_prepare_opencode_filesystem", return_value=set()),
        patch.object(server, "_wait_for_health", new_callable=AsyncMock),
        patch(
            "sandbox_runtime.opencode_server.asyncio.create_subprocess_exec",
            new_callable=AsyncMock,
            return_value=MagicMock(stdout=None),
        ) as spawn,
        patch(
            "sandbox_runtime.opencode_server.asyncio.create_task",
            side_effect=lambda coro: coro.close(),
        ),
    ):
        await server.start((), tmp_path)

    config = json.loads(spawn.call_args.kwargs["env"]["OPENCODE_CONFIG_CONTENT"])
    provider = config["provider"].get("kimi-coding-plan")
    if plan_key is None:
        assert provider is None
    else:
        assert provider == {
            "npm": "@ai-sdk/openai-compatible",
            "name": "Kimi Coding Plan",
            "options": {
                "baseURL": "https://api.kimi.ai/coding/v1",
                "apiKey": "{env:KIMI_CODE_API_KEY}",
            },
            "models": {
                "k3": {"name": "Kimi K3"},
                "kimi-for-coding": {"name": "Kimi for Coding"},
            },
        }
        assert plan_key not in spawn.call_args.kwargs["env"]["OPENCODE_CONFIG_CONTENT"]

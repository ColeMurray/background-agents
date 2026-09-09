import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tests.runtime_helpers import make_opencode_server


@pytest.fixture
async def reasoning_config(tmp_path):
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
    return json.loads(spawn.call_args.kwargs["env"]["OPENCODE_CONFIG_CONTENT"])


async def test_manual_variants_available_when_switching_from_adaptive_model(reasoning_config):
    assert reasoning_config["model"] == "anthropic/claude-sonnet-4-6"
    models = reasoning_config["provider"]["anthropic"]["models"]
    assert set(models) == {"claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-5"}
    for model in models.values():
        assert model == {
            "variants": {
                "high": {"thinking": {"type": "enabled", "budgetTokens": 16_000}},
                "max": {"thinking": {"type": "enabled", "budgetTokens": 31_999}},
            }
        }

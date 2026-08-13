"""Tests for OpenCode startup health polling."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tests.runtime_helpers import make_opencode_server


async def test_health_check_fails_fast_when_child_exits():
    services = make_opencode_server({})
    services._opencode_process = SimpleNamespace(returncode=23)

    with patch("sandbox_runtime.opencode_server.httpx.AsyncClient") as client_type:
        client_type.return_value.__aenter__.return_value.get = AsyncMock()
        with pytest.raises(RuntimeError, match="status 23"):
            await services._wait_for_health()

        client_type.return_value.__aenter__.return_value.get.assert_not_awaited()


async def test_stop_tolerates_process_exiting_before_terminate():
    server = make_opencode_server({})
    process = MagicMock(returncode=None)
    process.terminate.side_effect = ProcessLookupError
    process.wait = AsyncMock(return_value=0)
    server._opencode_process = process

    await server.stop()

    process.wait.assert_awaited_once()

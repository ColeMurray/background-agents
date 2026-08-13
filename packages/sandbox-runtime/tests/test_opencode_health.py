"""Tests for OpenCode startup health polling."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from tests.runtime_helpers import make_core_services


async def test_health_check_fails_fast_when_child_exits():
    services = make_core_services({})
    services._opencode_process = SimpleNamespace(returncode=23)

    with patch("sandbox_runtime.core_services.httpx.AsyncClient") as client_type:
        client_type.return_value.__aenter__.return_value.get = AsyncMock()
        with pytest.raises(RuntimeError, match="status 23"):
            await services._wait_for_health()

        client_type.return_value.__aenter__.return_value.get.assert_not_awaited()

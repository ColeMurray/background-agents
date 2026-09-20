"""Authenticated compensation and provider artifact reclamation contracts."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import modal
import modal.experimental
import pytest
from fastapi import HTTPException

from src import web_api


@pytest.mark.parametrize("missing", [False, True])
async def test_delete_image_is_real_and_idempotent(monkeypatch, missing):
    auth = Mock()
    monkeypatch.setattr(web_api, "require_auth", auth)
    delete = AsyncMock(side_effect=modal.exception.NotFoundError("gone") if missing else None)
    monkeypatch.setattr(modal.experimental, "image_delete", SimpleNamespace(aio=delete))
    assert await web_api.api_delete_image.get_raw_f()(
        {"image_id": "im-Retired123"}, "Bearer token"
    ) == {"success": True}
    auth.assert_called_once_with("Bearer token")
    delete.assert_awaited_once_with("im-Retired123")


async def test_cannot_delete_deployed_base_image(monkeypatch):
    monkeypatch.setattr(web_api, "require_auth", lambda _: None)
    monkeypatch.setattr("src.images.base.base_image", SimpleNamespace(object_id="im-Deployed"))
    delete = AsyncMock()
    monkeypatch.setattr(modal.experimental, "image_delete", SimpleNamespace(aio=delete))
    with pytest.raises(HTTPException) as error:
        await web_api.api_delete_image.get_raw_f()({"image_id": "im-Deployed"}, "Bearer token")
    assert error.value.status_code == 409
    delete.assert_not_awaited()


@pytest.mark.parametrize("owned", [False, True])
async def test_compensation_requires_exact_session_generation_tags(monkeypatch, owned):
    monkeypatch.setattr(web_api, "require_auth", lambda _: None)
    terminate = AsyncMock()
    tags = {
        "openinspect_kind": "session",
        "openinspect_session_id": "session-1",
        "openinspect_sandbox_id": "generation-1" if owned else "generation-2",
    }
    sandbox = SimpleNamespace(
        get_tags=SimpleNamespace(aio=AsyncMock(return_value=tags)),
        terminate=SimpleNamespace(aio=terminate),
    )
    monkeypatch.setattr(
        modal.Sandbox, "from_id", SimpleNamespace(aio=AsyncMock(return_value=sandbox))
    )
    body = {
        "provider_object_id": "sb-Owned123",
        "session_id": "session-1",
        "sandbox_id": "generation-1",
    }
    if owned:
        assert await web_api.api_terminate_sandbox.get_raw_f()(body, "Bearer token") == {
            "success": True
        }
        terminate.assert_awaited_once()
    else:
        with pytest.raises(HTTPException) as error:
            await web_api.api_terminate_sandbox.get_raw_f()(body, "Bearer token")
        assert error.value.status_code == 409
        terminate.assert_not_awaited()

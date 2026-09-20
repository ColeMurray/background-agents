"""Authenticated compensation and provider artifact reclamation contracts."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import modal
import modal.experimental
import pytest
from fastapi import HTTPException

from src import web_api
from src.allocation_identity import session_allocation_tags


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


@pytest.mark.parametrize("state", ["running", "unknown"])
async def test_reconcile_named_allocation_requires_exact_ownership(monkeypatch, state):
    monkeypatch.setattr(web_api, "require_auth", lambda _: None)
    body = {
        "allocation_name": "session-generation-1",
        "session_id": "session-1",
        "sandbox_id": "generation-1",
    }
    if state == "unknown":
        lookup = AsyncMock(side_effect=modal.exception.NotFoundError("missing"))
    else:
        sandbox = SimpleNamespace(
            object_id="sb-Owned123",
            get_tags=SimpleNamespace(
                aio=AsyncMock(
                    return_value=session_allocation_tags(
                        session_id="session-1",
                        sandbox_id="generation-1",
                        allocation_name="session-generation-1",
                    )
                )
            ),
        )
        lookup = AsyncMock(return_value=sandbox)
    monkeypatch.setattr(modal.Sandbox, "from_name", SimpleNamespace(aio=lookup))

    result = await web_api.api_reconcile_sandbox_allocation.get_raw_f()(body, "Bearer token")

    assert result["data"]["state"] == state
    if state == "running":
        assert result["data"]["provider_object_id"] == "sb-Owned123"


async def test_reconcile_rejects_any_tag_mismatch(monkeypatch):
    monkeypatch.setattr(web_api, "require_auth", lambda _: None)
    sandbox = SimpleNamespace(
        object_id="sb-Foreign123",
        get_tags=SimpleNamespace(
            aio=AsyncMock(
                return_value={
                    "openinspect_kind": "session",
                    "openinspect_session_id": "session-1",
                    "openinspect_sandbox_id": "generation-1",
                    "openinspect_execution_profile": "docker-v1",
                    "openinspect_allocation_name": "different-name",
                }
            )
        ),
    )
    monkeypatch.setattr(
        modal.Sandbox, "from_name", SimpleNamespace(aio=AsyncMock(return_value=sandbox))
    )

    with pytest.raises(HTTPException) as error:
        await web_api.api_reconcile_sandbox_allocation.get_raw_f()(
            {
                "allocation_name": "session-generation-1",
                "session_id": "session-1",
                "sandbox_id": "generation-1",
            },
            "Bearer token",
        )
    assert error.value.status_code == 409

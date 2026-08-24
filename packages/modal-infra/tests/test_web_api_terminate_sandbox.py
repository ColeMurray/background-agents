"""Tests for the by-id sandbox terminate endpoint."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from src import web_api


async def _call_terminate(request: dict) -> dict:
    return await web_api.api_terminate_sandbox.get_raw_f()(
        request,
        authorization="Bearer test",
        x_trace_id=None,
        x_request_id=None,
        x_session_id=None,
        x_sandbox_id=None,
    )


@pytest.mark.asyncio
async def test_terminate_terminates_the_sandbox_by_id(monkeypatch):
    monkeypatch.setattr(web_api, "require_auth", lambda _authorization: None)
    handle = SimpleNamespace(terminate=AsyncMock())
    manager = SimpleNamespace(get_sandbox_by_id=AsyncMock(return_value=handle))
    monkeypatch.setattr("src.sandbox.manager.SandboxManager", lambda: manager)

    result = await _call_terminate(
        {"sandbox_id": "mo-1", "session_id": "session-1", "reason": "connecting_timeout"}
    )

    assert result == {
        "success": True,
        "data": {
            "sandbox_id": "mo-1",
            "session_id": "session-1",
            "reason": "connecting_timeout",
            "terminated": True,
        },
    }
    manager.get_sandbox_by_id.assert_awaited_once_with("mo-1")
    handle.terminate.assert_awaited_once()


@pytest.mark.asyncio
async def test_terminate_treats_missing_sandbox_as_success(monkeypatch):
    monkeypatch.setattr(web_api, "require_auth", lambda _authorization: None)
    manager = SimpleNamespace(get_sandbox_by_id=AsyncMock(return_value=None))
    monkeypatch.setattr("src.sandbox.manager.SandboxManager", lambda: manager)

    result = await _call_terminate({"sandbox_id": "mo-gone", "session_id": "session-1"})

    assert result["success"] is True
    assert result["data"]["terminated"] is True


@pytest.mark.asyncio
async def test_terminate_reports_lookup_errors_as_failure(monkeypatch):
    monkeypatch.setattr(web_api, "require_auth", lambda _authorization: None)
    manager = SimpleNamespace(
        get_sandbox_by_id=AsyncMock(side_effect=RuntimeError("modal unavailable"))
    )
    monkeypatch.setattr("src.sandbox.manager.SandboxManager", lambda: manager)

    result = await _call_terminate({"sandbox_id": "mo-1", "session_id": "session-1"})

    assert result["success"] is False
    assert "modal unavailable" in result["error"]


@pytest.mark.asyncio
async def test_terminate_requires_a_sandbox_id(monkeypatch):
    monkeypatch.setattr(web_api, "require_auth", lambda _authorization: None)

    with pytest.raises(web_api.HTTPException) as exc:
        await _call_terminate({"session_id": "session-1"})

    assert exc.value.status_code == 400
    assert exc.value.detail == "sandbox_id is required"


@pytest.mark.asyncio
async def test_terminate_runs_after_authentication(monkeypatch):
    def reject_auth(_authorization):
        raise web_api.HTTPException(status_code=401, detail="Unauthorized")

    monkeypatch.setattr(web_api, "require_auth", reject_auth)

    with pytest.raises(web_api.HTTPException) as exc:
        await _call_terminate({"sandbox_id": "mo-1"})

    assert exc.value.status_code == 401

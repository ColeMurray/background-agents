import json

import pytest

from src import web_api


def _parse_json_response(response):
    if isinstance(response, dict):
        payload = response
        status_code = payload.get("error", {}).get("status_code", 200)
        return payload, status_code
    payload = json.loads(response.body.decode("utf-8"))
    return payload, response.status_code


@pytest.mark.asyncio
async def test_create_sandbox_forwards_timeout_seconds(monkeypatch):
    captured = {}

    class FakeHandle:
        sandbox_id = "sandbox-123"
        modal_object_id = "modal-123"

        class status:
            value = "warming"

        created_at = 123.0

    async def fake_create(self, config):
        captured["timeout_seconds"] = config.timeout_seconds
        return FakeHandle()

    monkeypatch.setattr("src.web_api.verify_internal_token", lambda _: True)
    monkeypatch.setattr("src.web_api.validate_control_plane_url", lambda _: True)
    monkeypatch.setattr("src.sandbox.manager.SandboxManager.create_sandbox", fake_create)

    response = await web_api.api_create_sandbox.local(
        {
            "session_id": "sess-1",
            "repo_owner": "acme",
            "repo_name": "repo",
            "control_plane_url": "https://control.example",
            "sandbox_auth_token": "sandbox-token",
            "timeout_seconds": 3600,
        },
        authorization="Bearer test",
    )

    body, status_code = _parse_json_response(response)
    assert status_code == 200
    assert body["success"] is True
    assert captured["timeout_seconds"] == 3600


@pytest.mark.asyncio
async def test_create_sandbox_invalid_timeout_returns_structured_400(monkeypatch):
    monkeypatch.setattr("src.web_api.verify_internal_token", lambda _: True)
    monkeypatch.setattr("src.web_api.validate_control_plane_url", lambda _: True)

    response = await web_api.api_create_sandbox.local(
        {
            "session_id": "sess-1",
            "repo_owner": "acme",
            "repo_name": "repo",
            "control_plane_url": "https://control.example",
            "sandbox_auth_token": "sandbox-token",
            "timeout_seconds": "not-an-int",
        },
        authorization="Bearer test",
    )

    body, status_code = _parse_json_response(response)
    assert status_code == 400
    assert body == {
        "success": False,
        "error": {
            "code": "bad_request",
            "message": "timeout_seconds must be an integer",
            "status_code": 400,
        },
    }


@pytest.mark.asyncio
async def test_restore_sandbox_auth_failure_returns_structured_401(monkeypatch):
    monkeypatch.setattr("src.web_api.verify_internal_token", lambda _: False)

    response = await web_api.api_restore_sandbox.local(
        {
            "snapshot_image_id": "img-123",
            "control_plane_url": "https://control.example",
        },
        authorization="Bearer invalid",
    )

    body, status_code = _parse_json_response(response)
    assert status_code == 401
    assert body == {
        "success": False,
        "error": {
            "code": "unauthorized",
            "message": "Unauthorized: Invalid or missing authentication token",
            "status_code": 401,
        },
    }

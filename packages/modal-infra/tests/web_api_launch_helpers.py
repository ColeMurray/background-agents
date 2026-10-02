"""Shared request assembly and inert managers for sandbox-launch API tests."""

from types import SimpleNamespace

import pytest

from sandbox_runtime.types import SandboxStatus
from src import web_api
from src.sandbox import manager as manager_module


def _patch_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(web_api, "require_auth", lambda _authorization: None)
    monkeypatch.setattr(web_api, "require_valid_control_plane_url", lambda _url: None)


def _patch_manager(
    monkeypatch: pytest.MonkeyPatch,
    captured: dict,
    *,
    vnc_url: str | None = None,
    vnc_password: str | None = None,
) -> None:
    class FakeManager:
        async def create_sandbox(self, config):
            captured["config"] = config
            return SimpleNamespace(
                sandbox_id="sandbox-123",
                modal_object_id="obj-123",
                status=SandboxStatus.WARMING,
                created_at=123.0,
                code_server_url=None,
                code_server_password=None,
                vnc_url=vnc_url,
                vnc_password=vnc_password,
                ttyd_url=None,
                tunnel_urls=None,
                sandbox_backend="modal",
            )

    monkeypatch.setattr(manager_module, "SandboxManager", FakeManager)


def _patch_restore_manager(
    monkeypatch: pytest.MonkeyPatch,
    captured: dict,
    *,
    vnc_url: str | None = None,
    vnc_password: str | None = None,
) -> None:
    class FakeManager:
        async def restore_from_snapshot(self, **kwargs):
            captured["restore"] = kwargs
            return SimpleNamespace(
                sandbox_id="sandbox-123",
                modal_object_id="obj-123",
                status=SandboxStatus.WARMING,
                code_server_url=None,
                code_server_password=None,
                vnc_url=vnc_url,
                vnc_password=vnc_password,
                ttyd_url=None,
                tunnel_urls=None,
                sandbox_backend="modal",
            )

    monkeypatch.setattr(manager_module, "SandboxManager", FakeManager)


VCS_IDENTITY = {"clone_host": "github.com", "clone_username": "x-access-token"}


async def _call_create_sandbox(request: dict, *, with_identity: bool = True, **headers) -> dict:
    request_headers = {
        "authorization": "Bearer test",
        "x_trace_id": None,
        "x_request_id": None,
        "x_session_id": None,
        "x_sandbox_id": None,
        **headers,
    }
    return await web_api.api_create_sandbox.get_raw_f()(
        {**VCS_IDENTITY, **request} if with_identity else request,
        **request_headers,
    )


async def _call_restore_sandbox(request: dict, *, with_identity: bool = True, **headers) -> dict:
    request_headers = {
        "authorization": "Bearer test",
        "x_trace_id": None,
        "x_request_id": None,
        "x_session_id": None,
        "x_sandbox_id": None,
        **headers,
    }
    return await web_api.api_restore_sandbox.get_raw_f()(
        {**VCS_IDENTITY, **request} if with_identity else request,
        **request_headers,
    )


CREATE_REQUEST = {
    "session_id": "sess-1",
    "control_plane_url": "https://control-plane.example",
    "sandbox_auth_token": "sandbox-token",
}

RESTORE_REQUEST = {
    "snapshot_image_id": "img-abc",
    "session_config": {"session_id": "sess-1"},
    "control_plane_url": "https://control-plane.example",
    "sandbox_auth_token": "sandbox-token",
}

"""Shared helpers for sandbox launch and VM allocation launch tests."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from modal.exception import NotFoundError

from sandbox_runtime.constants import DOCKER_ENABLED_ENV_VAR
from sandbox_runtime.types import SessionConfig
from src.sandbox.manager import SandboxConfig, SandboxManager
from src.sandbox.tunnels import TunnelUrls


def _fake_create(captured: dict):
    async def create_aio(*args, **kwargs):
        captured["command"] = args
        captured["kwargs"] = kwargs
        return SimpleNamespace(
            object_id="modal-object-1",
            tunnels=Mock(
                return_value={
                    9000: SimpleNamespace(url="https://code.example"),
                    9001: SimpleNamespace(url="https://vnc.example"),
                    9002: SimpleNamespace(url="https://terminal.example"),
                    3000: SimpleNamespace(url="https://app.example"),
                }
            ),
            filesystem=SimpleNamespace(write_text=SimpleNamespace(aio=AsyncMock())),
        )

    create_aio.aio = create_aio
    return create_aio


DOCKER_SETTINGS = {"cpuCores": 2, "memoryMib": 4096}


def _docker_manager(monkeypatch) -> tuple[SandboxManager, dict, object]:
    captured: dict = {}
    docker_image = object()
    monkeypatch.setattr("src.sandbox.launch.base_image", object())
    monkeypatch.setattr("src.images.base.docker_image", docker_image)
    monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", _fake_create(captured))
    monkeypatch.setattr(
        "src.sandbox.tunnels.SandboxTunnels.resolve",
        AsyncMock(return_value=TunnelUrls()),
    )
    return SandboxManager(), captured, docker_image


def _docker_config(**overrides) -> SandboxConfig:
    fields = {
        "repo_owner": "acme",
        "repo_name": "repo",
        "sandbox_id": "sandbox-acme-repo-1700000000000",
        "session_config": SessionConfig(
            session_id="session-1", repo_owner="acme", repo_name="repo"
        ),
        "control_plane_url": "https://control.example",
        "sandbox_auth_token": "token",
        "clone_host": "github.com",
        "clone_username": "x-access-token",
        "user_env_vars": {DOCKER_ENABLED_ENV_VAR: "false", "CUSTOM_ENV": "preserved"},
        "settings": dict(DOCKER_SETTINGS),
        "sandbox_backend": "modal-vm",
    }
    return SandboxConfig(**{**fields, **overrides})


def _not_found(*_args, **_kwargs):
    raise NotFoundError("no sandbox")

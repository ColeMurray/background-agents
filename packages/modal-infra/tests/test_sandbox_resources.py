"""Tests for sandbox CPU/memory resource reservations in SandboxManager."""

from unittest.mock import AsyncMock

import pytest

from src.sandbox.launch import _resource_kwargs
from src.sandbox.manager import SandboxConfig, SandboxManager
from src.sandbox.tunnels import SandboxTunnels, TunnelUrls


class TestResourceKwargs:
    """_resource_kwargs maps sandbox settings to Modal create kwargs."""

    def test_empty_settings(self):
        assert _resource_kwargs({}) == {}

    def test_maps_cpu_and_memory(self):
        assert _resource_kwargs({"cpuCores": 2, "memoryMib": 4096}) == {
            "cpu": 2.0,
            "memory": 4096,
        }

    def test_allows_fractional_cpu(self):
        assert _resource_kwargs({"cpuCores": 0.5}) == {"cpu": 0.5}

    def test_independent_fields(self):
        assert _resource_kwargs({"memoryMib": 2048}) == {"memory": 2048}


def _fake_create(captured: dict):
    async def fake_create_aio(*args, **kwargs):
        captured["kwargs"] = kwargs

        class FakeSandbox:
            object_id = "obj-1"
            stdout = None

        return FakeSandbox()

    fake_create_aio.aio = fake_create_aio
    return fake_create_aio


class TestCreateSandboxResources:
    """create_sandbox / restore_from_snapshot forward resources to Modal."""

    @pytest.mark.asyncio
    async def test_create_sandbox_passes_cpu_and_memory(self, monkeypatch):
        captured: dict = {}
        monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", _fake_create(captured))
        monkeypatch.setattr(
            SandboxTunnels,
            "resolve",
            AsyncMock(return_value=TunnelUrls(None, None, None, None)),
        )

        manager = SandboxManager()
        await manager.create_sandbox(
            SandboxConfig(
                repo_owner="acme",
                repo_name="repo",
                settings={"cpuCores": 2, "memoryMib": 4096},
            )
        )

        assert captured["kwargs"]["cpu"] == 2.0
        assert captured["kwargs"]["memory"] == 4096

    @pytest.mark.asyncio
    async def test_restore_from_snapshot_passes_resources(self, monkeypatch):
        captured: dict = {}

        class FakeImage:
            object_id = "img-1"

        monkeypatch.setattr(
            "src.sandbox.launch.modal.Image.from_id", lambda *_a, **_kw: FakeImage()
        )
        monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", _fake_create(captured))
        monkeypatch.setattr(
            SandboxTunnels,
            "resolve",
            AsyncMock(return_value=TunnelUrls(None, None, None, None)),
        )

        manager = SandboxManager()
        await manager.restore_from_snapshot(
            snapshot_image_id="img-abc",
            session_config={"repo_owner": "acme", "repo_name": "repo"},
            settings={"cpuCores": 1, "memoryMib": 2048},
        )

        assert captured["kwargs"]["cpu"] == 1.0
        assert captured["kwargs"]["memory"] == 2048

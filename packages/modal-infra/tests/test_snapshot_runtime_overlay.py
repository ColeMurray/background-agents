from unittest.mock import AsyncMock

import pytest

from src.images.base import SANDBOX_RUNTIME_DIR, overlay_sandbox_runtime
from src.sandbox.manager import SandboxConfig, SandboxManager


def test_overlay_sandbox_runtime_mounts_current_package() -> None:
    overlaid_image = object()

    class FakeImage:
        def add_local_dir(self, local_path: str, *, remote_path: str):
            assert local_path == str(SANDBOX_RUNTIME_DIR)
            assert remote_path == "/app/sandbox_runtime"
            return overlaid_image

    assert overlay_sandbox_runtime(FakeImage()) is overlaid_image


def _sandbox_create(captured: dict):
    async def create(*args, **kwargs):
        captured["image"] = kwargs["image"]

        class FakeSandbox:
            object_id = "sandbox-1"
            stdout = None

        return FakeSandbox()

    create.aio = create
    return create


@pytest.mark.asyncio
async def test_create_sandbox_overlays_runtime_on_session_snapshot(monkeypatch) -> None:
    captured = {}
    snapshot_image = object()
    overlaid_image = object()

    monkeypatch.setattr(
        "src.sandbox.manager.modal.Image.from_registry", lambda *_args, **_kwargs: snapshot_image
    )
    monkeypatch.setattr(
        "src.sandbox.manager.overlay_sandbox_runtime",
        lambda image: overlaid_image if image is snapshot_image else image,
    )
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _sandbox_create(captured))
    monkeypatch.setattr(
        SandboxManager,
        "_resolve_and_setup_tunnels",
        AsyncMock(return_value=(None, None, None)),
    )

    await SandboxManager().create_sandbox(
        SandboxConfig(repo_owner=None, repo_name=None, snapshot_id="snapshot-1")
    )

    assert captured["image"] is overlaid_image


@pytest.mark.asyncio
async def test_create_sandbox_overlays_runtime_on_repository_image(monkeypatch) -> None:
    captured = {}
    repository_image = object()
    overlaid_image = object()

    monkeypatch.setattr(
        "src.sandbox.manager.modal.Image.from_id", lambda *_args, **_kwargs: repository_image
    )
    monkeypatch.setattr(
        "src.sandbox.manager.overlay_sandbox_runtime",
        lambda image: overlaid_image if image is repository_image else image,
    )
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _sandbox_create(captured))
    monkeypatch.setattr(
        SandboxManager,
        "_resolve_and_setup_tunnels",
        AsyncMock(return_value=(None, None, None)),
    )

    await SandboxManager().create_sandbox(
        SandboxConfig(repo_owner="acme", repo_name="app", repo_image_id="image-1")
    )

    assert captured["image"] is overlaid_image


@pytest.mark.asyncio
async def test_restore_from_snapshot_overlays_runtime(monkeypatch) -> None:
    captured = {}
    snapshot_image = object()
    overlaid_image = object()

    monkeypatch.setattr(
        "src.sandbox.manager.modal.Image.from_id", lambda *_args, **_kwargs: snapshot_image
    )
    monkeypatch.setattr(
        "src.sandbox.manager.overlay_sandbox_runtime",
        lambda image: overlaid_image if image is snapshot_image else image,
    )
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _sandbox_create(captured))
    monkeypatch.setattr(
        SandboxManager,
        "_resolve_and_setup_tunnels",
        AsyncMock(return_value=(None, None, None)),
    )

    await SandboxManager().restore_from_snapshot(
        snapshot_image_id="image-1",
        session_config={"repo_owner": None, "repo_name": None},
    )

    assert captured["image"] is overlaid_image

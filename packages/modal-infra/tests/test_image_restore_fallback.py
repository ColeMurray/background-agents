"""Tests for provider-image restore failure handling in SandboxManager.

Modal filesystem snapshots carry a provider-side TTL (a 30-day default before
we pinned ttl=None), so an image that D1 still considers `ready` can be gone at
spawn time. Repo-image boots must degrade to the base image and flag the
failure so the control plane can mark the row failed; session-snapshot restores
cannot fall back silently (the filesystem state is unrecoverable) and must
raise a structured error instead.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import modal
import pytest

from src.sandbox import manager as manager_module
from src.sandbox.manager import SandboxConfig, SandboxManager, SnapshotRestoreError


def _fake_image(hydrate_error: Exception | None = None) -> SimpleNamespace:
    hydrate = MagicMock()
    hydrate.aio = AsyncMock(side_effect=hydrate_error)
    return SimpleNamespace(hydrate=hydrate)


def _patch_create(monkeypatch, captured: list, side_effects: list | None = None) -> None:
    """Patch modal.Sandbox.create to capture kwargs, optionally failing per call."""

    call_index = {"n": 0}

    async def fake_create_aio(*args, **kwargs):
        captured.append(kwargs)
        if side_effects and call_index["n"] < len(side_effects):
            effect = side_effects[call_index["n"]]
            call_index["n"] += 1
            if isinstance(effect, Exception):
                raise effect

        class FakeSandbox:
            object_id = "obj-123"
            stdout = None

        return FakeSandbox()

    fake_create = MagicMock()
    fake_create.aio = fake_create_aio
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", fake_create)
    monkeypatch.setattr(
        SandboxManager,
        "_resolve_and_setup_tunnels",
        AsyncMock(return_value=(None, None, None)),
    )


def _repo_image_config() -> SandboxConfig:
    return SandboxConfig(
        repo_owner="acme",
        repo_name="repo",
        control_plane_url="https://cp.example.com",
        sandbox_auth_token="token-123",
        repo_image_id="im-ready-1",
        repo_image_sha="abc123",
    )


class TestRepoImageRestoreFallback:
    @pytest.mark.asyncio
    async def test_healthy_repo_image_boots_with_flag_unset(self, monkeypatch):
        captured: list = []
        _patch_create(monkeypatch, captured)
        image = _fake_image()
        monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", lambda *_a, **_k: image)

        handle = await SandboxManager().create_sandbox(_repo_image_config())

        assert handle.image_restore_failed is False
        assert captured[0]["env"]["FROM_REPO_IMAGE"] == "true"
        assert captured[0]["env"]["REPO_IMAGE_SHA"] == "abc123"
        assert captured[0]["image"] is image

    @pytest.mark.asyncio
    async def test_hydrate_failure_falls_back_to_base_image(self, monkeypatch):
        captured: list = []
        _patch_create(monkeypatch, captured)
        monkeypatch.setattr(
            "src.sandbox.manager.modal.Image.from_id",
            lambda *_a, **_k: _fake_image(modal.exception.NotFoundError("image expired")),
        )

        handle = await SandboxManager().create_sandbox(_repo_image_config())

        assert handle.image_restore_failed is True
        assert captured[0]["image"] is manager_module.base_image
        assert "FROM_REPO_IMAGE" not in captured[0]["env"]
        assert "REPO_IMAGE_SHA" not in captured[0]["env"]

    @pytest.mark.asyncio
    async def test_create_failure_on_repo_image_retries_with_base_image(self, monkeypatch):
        """Expiry can also surface at Sandbox.create — retry once on base."""
        captured: list = []
        _patch_create(
            monkeypatch, captured, side_effects=[modal.exception.NotFoundError("image gone")]
        )
        image = _fake_image()
        monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", lambda *_a, **_k: image)

        handle = await SandboxManager().create_sandbox(_repo_image_config())

        assert handle.image_restore_failed is True
        assert len(captured) == 2
        assert captured[0]["image"] is image
        assert captured[1]["image"] is manager_module.base_image
        assert "FROM_REPO_IMAGE" not in captured[1]["env"]
        assert "REPO_IMAGE_SHA" not in captured[1]["env"]

    @pytest.mark.asyncio
    async def test_create_failure_without_repo_image_propagates(self, monkeypatch):
        """The base-image retry is repo-image-only; other failures still raise."""
        captured: list = []
        _patch_create(monkeypatch, captured, side_effects=[RuntimeError("quota exceeded")])

        with pytest.raises(RuntimeError):
            await SandboxManager().create_sandbox(
                SandboxConfig(
                    repo_owner="acme",
                    repo_name="repo",
                    control_plane_url="https://cp.example.com",
                    sandbox_auth_token="token-123",
                )
            )
        assert len(captured) == 1


class TestSnapshotRestoreFailure:
    @pytest.mark.asyncio
    async def test_hydrate_failure_raises_structured_error(self, monkeypatch):
        monkeypatch.setattr(
            "src.sandbox.manager.modal.Image.from_id",
            lambda *_a, **_k: _fake_image(modal.exception.NotFoundError("image expired")),
        )

        with pytest.raises(SnapshotRestoreError) as exc_info:
            await SandboxManager().restore_from_snapshot(
                snapshot_image_id="im-snap-1",
                session_config={"session_id": "s1", "repo_owner": "acme", "repo_name": "repo"},
            )

        assert exc_info.value.snapshot_id == "im-snap-1"

    @pytest.mark.asyncio
    async def test_not_found_at_create_raises_structured_error(self, monkeypatch):
        captured: list = []
        _patch_create(
            monkeypatch, captured, side_effects=[modal.exception.NotFoundError("image gone")]
        )
        monkeypatch.setattr(
            "src.sandbox.manager.modal.Image.from_id", lambda *_a, **_k: _fake_image()
        )

        with pytest.raises(SnapshotRestoreError) as exc_info:
            await SandboxManager().restore_from_snapshot(
                snapshot_image_id="im-snap-1",
                session_config={"session_id": "s1", "repo_owner": "acme", "repo_name": "repo"},
            )

        assert exc_info.value.snapshot_id == "im-snap-1"

    @pytest.mark.asyncio
    async def test_generic_create_failure_propagates_unchanged(self, monkeypatch):
        """Only image-lookup failures classify as snapshot-restore errors."""
        captured: list = []
        _patch_create(monkeypatch, captured, side_effects=[RuntimeError("quota exceeded")])
        monkeypatch.setattr(
            "src.sandbox.manager.modal.Image.from_id", lambda *_a, **_k: _fake_image()
        )

        with pytest.raises(RuntimeError):
            await SandboxManager().restore_from_snapshot(
                snapshot_image_id="im-snap-1",
                session_config={"session_id": "s1", "repo_owner": "acme", "repo_name": "repo"},
            )

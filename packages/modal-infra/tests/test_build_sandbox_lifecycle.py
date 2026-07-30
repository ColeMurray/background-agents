"""Provider-session lifecycle tests for Modal image-build sandboxes."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.sandbox.manager import SandboxManager


def _async_method(return_value=None):
    method = MagicMock()
    method.aio = AsyncMock(return_value=return_value)
    return method


@pytest.mark.asyncio
async def test_create_provider_session_build_is_dormant_tagged_and_scrubs_callbacks(monkeypatch):
    sandbox = SimpleNamespace(object_id="modal-session-1")
    create = _async_method(sandbox)
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", create)

    handle = await SandboxManager().create_provider_session_build_sandbox(
        build_id="build-1",
        scope_kind="repo",
        scope_id="acme/repo",
        repositories=[{"repo_owner": "acme", "repo_name": "repo", "branch": "main"}],
        user_env_vars={"OI_REPO_IMAGE_CALLBACK_TOKEN": "attacker-token"},
    )

    assert handle.modal_object_id == "modal-session-1"
    assert create.aio.await_args.args[:2] == ("python", "-c")
    assert create.aio.await_args.kwargs["tags"]["openinspect_build_id"] == "build-1"
    assert create.aio.await_args.kwargs["env"]["OI_REPO_IMAGE_CALLBACK_TOKEN"] == ""


@pytest.mark.asyncio
async def test_start_build_verifies_tags_and_injects_exact_callback_identity(monkeypatch):
    sandbox = SimpleNamespace(
        get_tags=_async_method(
            {"openinspect_kind": "image-build", "openinspect_build_id": "build-1"}
        ),
        exec=_async_method(),
    )
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.from_id", lambda _id: sandbox)

    await SandboxManager().start_build_sandbox(
        build_id="build-1",
        provider_session_id="modal-session-1",
        callback_url="https://cp.test/image-builds/build-complete",
        failure_callback_url="https://cp.test/image-builds/build-failed",
        callback_token="callback-token",
    )

    assert sandbox.exec.aio.await_args.kwargs["env"] == {
        "OI_REPO_IMAGE_BUILD_ID": "build-1",
        "OI_REPO_IMAGE_CALLBACK_URL": "https://cp.test/image-builds/build-complete",
        "OI_REPO_IMAGE_FAILURE_CALLBACK_URL": "https://cp.test/image-builds/build-failed",
        "OI_REPO_IMAGE_CALLBACK_TOKEN": "callback-token",
        "OI_REPO_IMAGE_PROVIDER_SESSION_ID": "modal-session-1",
    }


@pytest.mark.asyncio
async def test_start_build_refuses_mismatched_tags(monkeypatch):
    sandbox = SimpleNamespace(
        get_tags=_async_method(
            {"openinspect_kind": "interactive", "openinspect_build_id": "other-build"}
        ),
        exec=_async_method(),
    )
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.from_id", lambda _id: sandbox)

    with pytest.raises(ValueError, match="tags do not match"):
        await SandboxManager().start_build_sandbox(
            build_id="build-1",
            provider_session_id="modal-session-1",
            callback_url="https://cp.test/image-builds/build-complete",
            failure_callback_url="https://cp.test/image-builds/build-failed",
            callback_token="callback-token",
        )

    sandbox.exec.aio.assert_not_awaited()


@pytest.mark.asyncio
async def test_terminate_build_treats_not_found_as_success(monkeypatch):
    from modal.exception import NotFoundError

    sandbox = SimpleNamespace(get_tags=_async_method(), terminate=_async_method())
    sandbox.get_tags.aio.side_effect = NotFoundError("sandbox no longer exists")
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.from_id", lambda _id: sandbox)

    await SandboxManager().terminate_build_sandbox(
        build_id="build-1",
        provider_session_id="modal-session-1",
        reason="image_build_complete",
    )

    sandbox.terminate.aio.assert_not_awaited()

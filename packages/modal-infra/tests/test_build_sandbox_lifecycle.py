"""Provider-session lifecycle tests for Modal image-build sandboxes."""

import json
import re
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.sandbox.build_session import (
    DEFAULT_BUILD_TIMEOUT_SECONDS,
    MAX_BUILD_TIMEOUT_SECONDS,
    BuildSessionNotFoundError,
    ModalBuildSessionService,
)
from src.sandbox.manager import SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS


def _async_method(return_value=None):
    method = MagicMock()
    method.aio = AsyncMock(return_value=return_value)
    return method


def _mock_sandbox_lookup(monkeypatch, sandbox):
    from_id = _async_method(sandbox)
    monkeypatch.setattr("src.sandbox.build_session.modal.Sandbox.from_id", from_id)
    return from_id


@pytest.mark.parametrize(
    ("constant_name", "python_value"),
    [
        ("DEFAULT_BUILD_TIMEOUT_SECONDS", DEFAULT_BUILD_TIMEOUT_SECONDS),
        ("MAX_BUILD_TIMEOUT_SECONDS", MAX_BUILD_TIMEOUT_SECONDS),
    ],
)
def test_build_timeout_limits_match_shared_contract(constant_name, python_value):
    """Keep Modal's runtime limits aligned with the shared TypeScript contract."""
    shared_source = (
        Path(__file__).resolve().parents[2] / "shared" / "src" / "types" / "integrations.ts"
    ).read_text()
    match = re.search(rf"export\s+const\s+{constant_name}\s*=\s*(\d+)\s*;", shared_source)

    assert match is not None, f"missing numeric shared constant: {constant_name}"
    assert python_value == int(match.group(1))


@pytest.mark.asyncio
async def test_create_build_sandbox_is_dormant_tagged_and_scrubs_callback_env(monkeypatch):
    sandbox = SimpleNamespace(object_id="modal-session-1")
    create = _async_method(sandbox)
    monkeypatch.setattr("src.sandbox.build_session.modal.Sandbox.create", create)

    provider_session_id = await ModalBuildSessionService().create(
        build_id="build-1",
        scope_kind="repo",
        scope_id="acme/repo",
        repositories=[{"repo_owner": "acme", "repo_name": "repo", "branch": "main"}],
        clone_token="clone-token",
        clone_host="gitlab.com",
        clone_username="oauth2",
        user_env_vars={
            "FOO": "bar",
            "OI_REPO_IMAGE_CALLBACK_TOKEN": "attacker-token",
            "OI_IMAGE_BUILD_EXECUTION_TIMEOUT_SECONDS": "99999",
        },
        build_execution_timeout_seconds=1200,
        timeout_seconds=1800,
    )

    assert provider_session_id == "modal-session-1"
    args = create.aio.await_args.args
    kwargs = create.aio.await_args.kwargs
    assert args[:2] == ("python", "-c")
    assert kwargs["tags"] == {
        "openinspect_kind": "image-build",
        "openinspect_build_id": "build-1",
        "openinspect_scope_kind": "repo",
        "openinspect_scope_id": "acme/repo",
    }
    assert kwargs["env"]["FOO"] == "bar"
    assert kwargs["env"]["OI_REPO_IMAGE_CALLBACK_TOKEN"] == ""
    assert kwargs["env"]["OI_IMAGE_BUILD_EXECUTION_TIMEOUT_SECONDS"] == "1200"
    assert kwargs["env"]["VCS_HOST"] == "gitlab.com"
    assert kwargs["env"]["VCS_CLONE_USERNAME"] == "oauth2"
    assert kwargs["env"]["VCS_CLONE_TOKEN"] == "clone-token"
    assert json.loads(kwargs["env"]["SESSION_CONFIG"]) == {
        "branch": "main",
        "repositories": [{"repo_owner": "acme", "repo_name": "repo", "branch": "main"}],
    }
    assert kwargs["secrets"] == []
    assert kwargs["timeout"] == 1800
    assert kwargs["workdir"] == "/workspace"


@pytest.mark.asyncio
async def test_start_build_sandbox_verifies_tags_and_injects_exact_callback_env(monkeypatch):
    process = SimpleNamespace(object_id="process-1")
    sandbox = SimpleNamespace(
        get_tags=_async_method(
            {
                "openinspect_kind": "image-build",
                "openinspect_build_id": "build-1",
            }
        ),
        exec=_async_method(process),
    )
    from_id = _mock_sandbox_lookup(monkeypatch, sandbox)

    await ModalBuildSessionService().start(
        build_id="build-1",
        provider_session_id="modal-session-1",
        callback_url="https://cp.test/image-builds/build-complete",
        failure_callback_url="https://cp.test/image-builds/build-failed",
        callback_token="callback-token",
    )

    assert sandbox.exec.aio.await_args.args == (
        "python",
        "-m",
        "sandbox_runtime.entrypoint",
    )
    assert sandbox.exec.aio.await_args.kwargs["env"] == {
        "OI_REPO_IMAGE_BUILD_ID": "build-1",
        "OI_REPO_IMAGE_CALLBACK_URL": "https://cp.test/image-builds/build-complete",
        "OI_REPO_IMAGE_FAILURE_CALLBACK_URL": "https://cp.test/image-builds/build-failed",
        "OI_REPO_IMAGE_CALLBACK_TOKEN": "callback-token",
        "OI_REPO_IMAGE_PROVIDER_SESSION_ID": "modal-session-1",
    }
    assert sandbox.exec.aio.await_args.kwargs["workdir"] == "/workspace"
    from_id.assert_not_called()
    from_id.aio.assert_awaited_once_with("modal-session-1")


@pytest.mark.asyncio
async def test_start_build_sandbox_refuses_mismatched_tags(monkeypatch):
    sandbox = SimpleNamespace(
        get_tags=_async_method(
            {
                "openinspect_kind": "interactive",
                "openinspect_build_id": "other-build",
            }
        ),
        exec=_async_method(),
    )
    _mock_sandbox_lookup(monkeypatch, sandbox)

    with pytest.raises(BuildSessionNotFoundError, match="build session not found"):
        await ModalBuildSessionService().start(
            build_id="build-1",
            provider_session_id="modal-session-1",
            callback_url="https://cp.test/image-builds/build-complete",
            failure_callback_url="https://cp.test/image-builds/build-failed",
            callback_token="callback-token",
        )

    sandbox.exec.aio.assert_not_awaited()


@pytest.mark.asyncio
async def test_snapshot_build_awaits_async_snapshot_operation(monkeypatch):
    snapshot_filesystem = _async_method(SimpleNamespace(object_id="im-snapshot-1"))
    sandbox = SimpleNamespace(
        get_tags=_async_method(
            {"openinspect_kind": "image-build", "openinspect_build_id": "build-1"}
        ),
        snapshot_filesystem=snapshot_filesystem,
    )
    _mock_sandbox_lookup(monkeypatch, sandbox)

    image_id = await ModalBuildSessionService().snapshot(
        build_id="build-1",
        provider_session_id="modal-session-1",
    )

    assert image_id == "im-snapshot-1"
    snapshot_filesystem.assert_not_called()
    snapshot_filesystem.aio.assert_awaited_once_with(timeout=SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS)


@pytest.mark.asyncio
async def test_terminate_build_sandbox_verifies_tags(monkeypatch):
    sandbox = SimpleNamespace(
        get_tags=_async_method(
            {
                "openinspect_kind": "image-build",
                "openinspect_build_id": "build-1",
            }
        ),
        terminate=_async_method(),
    )
    _mock_sandbox_lookup(monkeypatch, sandbox)

    await ModalBuildSessionService().terminate(
        build_id="build-1",
        provider_session_id="modal-session-1",
        reason="image_build_complete",
    )

    sandbox.terminate.aio.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_terminate_build_sandbox_treats_provider_not_found_as_success(monkeypatch):
    from modal.exception import NotFoundError

    sandbox = SimpleNamespace(
        get_tags=_async_method(),
        terminate=_async_method(),
    )
    sandbox.get_tags.aio.side_effect = NotFoundError("sandbox no longer exists")
    _mock_sandbox_lookup(monkeypatch, sandbox)

    await ModalBuildSessionService().terminate(
        build_id="build-1",
        provider_session_id="modal-session-1",
        reason="image_build_complete",
    )

    sandbox.terminate.aio.assert_not_awaited()

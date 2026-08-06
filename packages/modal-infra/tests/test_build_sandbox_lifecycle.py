"""Provider-session lifecycle tests for Modal image-build sandboxes."""

import json
import re
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.constants import IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_VAR
from sandbox_runtime.modal_image_build_start import MODAL_SANDBOX_ID_ENV
from sandbox_runtime.repo_image_callback import (
    BUILD_ID_ENV,
    CALLBACK_TOKEN_ENV,
    CALLBACK_URL_ENV,
    FAILURE_CALLBACK_URL_ENV,
    PROVIDER_SESSION_ID_ENV,
)
from src.sandbox.build_session import (
    DEFAULT_BUILD_TIMEOUT_SECONDS,
    MAX_BUILD_TIMEOUT_SECONDS,
    RESERVED_USER_ENV_KEYS,
    BuildSessionNotFoundError,
    ModalBuildSessionService,
)
from src.sandbox.manager import SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS
from src.web_api import IMAGE_BUILD_FINALIZATION_GRACE_SECONDS


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


def test_finalization_grace_matches_control_plane_contract():
    """Pin IMAGE_BUILD_FINALIZATION_GRACE_SECONDS to the control-plane grace window.

    web_api.py mirrors IMAGE_BUILD_FINALIZATION_GRACE_MS from the control
    plane's image-builds/timeouts.ts; both planes must reserve the same
    finalization headroom on top of the build-execution budget.
    """
    ts_source = (
        Path(__file__).resolve().parents[2]
        / "control-plane"
        / "src"
        / "image-builds"
        / "timeouts.ts"
    ).read_text()
    match = re.search(
        r"export\s+const\s+IMAGE_BUILD_FINALIZATION_GRACE_MS\s*=\s*([^;]+);",
        ts_source,
    )
    assert match is not None, "missing TS constant: IMAGE_BUILD_FINALIZATION_GRACE_MS"

    ms_per_second_match = re.search(r"const\s+MS_PER_SECOND\s*=\s*(\d+)\s*;", ts_source)
    assert ms_per_second_match is not None, "missing TS constant: MS_PER_SECOND"
    ms_per_second = int(ms_per_second_match.group(1))

    ts_grace_ms = 1
    for factor in (part.strip() for part in match.group(1).split("*")):
        if factor == "MS_PER_SECOND":
            ts_grace_ms *= ms_per_second
        else:
            assert factor.isdigit(), (
                "could not evaluate IMAGE_BUILD_FINALIZATION_GRACE_MS: expected a "
                f"product of integer literals and MS_PER_SECOND, got factor {factor!r}"
            )
            ts_grace_ms *= int(factor)
    assert ts_grace_ms == IMAGE_BUILD_FINALIZATION_GRACE_SECONDS * ms_per_second


def _load_callback_env_manifest() -> dict:
    """Language-neutral manifest of the cross-plane image-build env-key contract.

    The same file is pinned by value on the TypeScript side
    (packages/control-plane/src/sandbox/sandbox-env.test.ts), so neither plane
    can drift without failing its own test suite. Tests-only consumption: the
    runtime constants stay as code.
    """
    manifest_path = (
        Path(__file__).resolve().parents[2]
        / "sandbox-runtime"
        / "src"
        / "sandbox_runtime"
        / "image_build_callback_env.json"
    )
    return json.loads(manifest_path.read_text())


def test_runtime_callback_env_constants_match_manifest():
    """Pin the runtime callback env-var constants to the shared manifest by value."""
    manifest = _load_callback_env_manifest()

    assert manifest["callback_env"] == {
        "build_id": BUILD_ID_ENV,
        "callback_url": CALLBACK_URL_ENV,
        "failure_callback_url": FAILURE_CALLBACK_URL_ENV,
        "token": CALLBACK_TOKEN_ENV,
        "provider_session_id": PROVIDER_SESSION_ID_ENV,
    }
    assert manifest["execution_timeout_env_var"] == IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_VAR
    # The runtime entrypoint reads the build-mode marker as a literal
    # (os.environ.get("IMAGE_BUILD_MODE") == "true" in entrypoint.py).
    assert manifest["build_mode_env_var"] == "IMAGE_BUILD_MODE"


def test_reserved_user_env_scrub_matches_manifest():
    """Pin the reserved-key scrub — the hijack-prevention half of the contract.

    Modal's RESERVED_USER_ENV_KEYS (ModalBuildSessionService.create) and the
    control plane's RESERVED_REPO_IMAGE_CALLBACK_ENV_KEYS both scrub user env
    vars before a build sandbox launches. They intentionally diverge at the
    edges; each side pins its own half against the manifest so neither can
    silently drop a scrubbed key. Intended divergence:
    - the legacy pre-token secret key and the execution-timeout key are
      scrubbed only in TS (the timeout scrub is safe on Modal only because
      create() unconditionally re-sets the key after the scrub — asserted in
      test_create_build_sandbox_runs_gated_entrypoint_and_scrubs_callback_env);
    - the Modal stdin-launch sandbox-id key is scrubbed only in Python
      (meaningless off-Modal).
    """
    manifest = _load_callback_env_manifest()
    callback_env_values = set(manifest["callback_env"].values())
    python_reserved = set(RESERVED_USER_ENV_KEYS)

    assert python_reserved == callback_env_values | set(manifest["reserved_only_modal"])
    assert set(manifest["reserved_only_modal"]) == {MODAL_SANDBOX_ID_ENV}
    # The TS-only extras never enter the Python scrub set.
    assert set(manifest["reserved_only_control_plane"]) & python_reserved == set()
    assert IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_VAR in manifest["reserved_only_control_plane"]


@pytest.mark.asyncio
async def test_create_build_sandbox_runs_gated_entrypoint_and_scrubs_callback_env(monkeypatch):
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
        callback_url="https://cp.test/image-builds/build-complete",
        failure_callback_url="https://cp.test/image-builds/build-failed",
        user_env_vars={
            "FOO": "bar",
            "OI_REPO_IMAGE_BUILD_ID": "attacker-build",
            "OI_REPO_IMAGE_CALLBACK_URL": "https://attacker.test/complete",
            "OI_REPO_IMAGE_FAILURE_CALLBACK_URL": "https://attacker.test/failed",
            "OI_REPO_IMAGE_CALLBACK_TOKEN": "attacker-token",
            "MODAL_SANDBOX_ID": "attacker-sandbox",
            "OI_IMAGE_BUILD_EXECUTION_TIMEOUT_SECONDS": "99999",
        },
        build_execution_timeout_seconds=1200,
        timeout_seconds=1800,
    )

    assert provider_session_id == "modal-session-1"
    args = create.aio.await_args.args
    kwargs = create.aio.await_args.kwargs
    assert args == (
        "python",
        "-m",
        "sandbox_runtime.entrypoint",
        "--await-modal-image-build-token-stdin-v1",
    )
    assert kwargs["tags"] == {
        "openinspect_kind": "image-build",
        "openinspect_build_id": "build-1",
        "openinspect_scope_kind": "repo",
        "openinspect_scope_id": "acme/repo",
        "openinspect_launch_protocol": "stdin-token-v1",
    }
    assert kwargs["env"]["FOO"] == "bar"
    assert "OI_REPO_IMAGE_CALLBACK_TOKEN" not in kwargs["env"]
    assert "OI_REPO_IMAGE_PROVIDER_SESSION_ID" not in kwargs["env"]
    assert "MODAL_SANDBOX_ID" not in kwargs["env"]
    assert kwargs["env"]["OI_REPO_IMAGE_BUILD_ID"] == "build-1"
    assert (
        kwargs["env"]["OI_REPO_IMAGE_CALLBACK_URL"] == "https://cp.test/image-builds/build-complete"
    )
    assert (
        kwargs["env"]["OI_REPO_IMAGE_FAILURE_CALLBACK_URL"]
        == "https://cp.test/image-builds/build-failed"
    )
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
async def test_start_build_sandbox_writes_only_callback_token_to_gated_entrypoint(monkeypatch):
    stdin = SimpleNamespace(write=MagicMock(), drain=_async_method())
    sandbox = SimpleNamespace(
        get_tags=_async_method(
            {
                "openinspect_kind": "image-build",
                "openinspect_build_id": "build-1",
                "openinspect_launch_protocol": "stdin-token-v1",
            }
        ),
        stdin=stdin,
        exec=_async_method(),
    )
    from_id = _mock_sandbox_lookup(monkeypatch, sandbox)

    await ModalBuildSessionService().start(
        build_id="build-1",
        provider_session_id="modal-session-1",
        callback_token="a" * 64,
    )

    stdin.write.assert_called_once_with("a" * 64 + "\n")
    stdin.drain.aio.assert_awaited_once_with()
    sandbox.exec.aio.assert_not_awaited()
    from_id.assert_not_called()
    from_id.aio.assert_awaited_once_with("modal-session-1")


@pytest.mark.asyncio
@pytest.mark.parametrize("launch_protocol", ["stdin-v2", None])
async def test_start_build_sandbox_rejects_unsupported_launch_protocol_without_delivery(
    monkeypatch, launch_protocol
):
    stdin = SimpleNamespace(write=MagicMock(), drain=_async_method())
    tags = {
        "openinspect_kind": "image-build",
        "openinspect_build_id": "build-1",
    }
    if launch_protocol is not None:
        tags["openinspect_launch_protocol"] = launch_protocol
    sandbox = SimpleNamespace(
        get_tags=_async_method(tags),
        stdin=stdin,
        exec=_async_method(),
    )
    _mock_sandbox_lookup(monkeypatch, sandbox)

    with pytest.raises(ValueError, match="unsupported image-build launch protocol"):
        await ModalBuildSessionService().start(
            build_id="build-1",
            provider_session_id="modal-session-1",
            callback_token="callback-token",
        )

    stdin.write.assert_not_called()
    stdin.drain.aio.assert_not_awaited()
    sandbox.exec.aio.assert_not_awaited()


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

    sandbox.terminate.aio.assert_awaited_once_with(wait=True)


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

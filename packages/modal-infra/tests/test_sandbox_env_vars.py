import json

import pytest

from sandbox_runtime.types import SessionConfig
from src.sandbox.manager import (
    DEFAULT_SANDBOX_TIMEOUT_SECONDS,
    SandboxConfig,
    SandboxManager,
    _has_repository,
)


@pytest.mark.parametrize(
    ("repo_owner", "repo_name", "expected"),
    [
        ("acme", "repo", "single"),
        (None, None, "none"),
    ],
)
def test_has_repository_accepts_complete_or_absent_metadata(repo_owner, repo_name, expected):
    assert _has_repository(repo_owner, repo_name) is (expected == "single")


@pytest.mark.parametrize(
    ("repo_owner", "repo_name"),
    [
        ("acme", None),
        (None, "repo"),
    ],
)
def test_has_repository_rejects_partial_repo_metadata(repo_owner, repo_name):
    with pytest.raises(ValueError, match="repo_owner and repo_name must be provided together"):
        _has_repository(repo_owner, repo_name)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("repo_owner", "repo_name"),
    [
        ("acme", None),
        (None, "repo"),
    ],
)
async def test_create_sandbox_rejects_partial_repo_metadata(repo_owner, repo_name):
    manager = SandboxManager()

    with pytest.raises(ValueError, match="repo_owner and repo_name must be provided together"):
        await manager.create_sandbox(SandboxConfig(repo_owner=repo_owner, repo_name=repo_name))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "session_config",
    [
        {"repo_owner": "acme", "repo_name": None, "session_id": "sess-1"},
        {"repo_owner": None, "repo_name": "repo", "session_id": "sess-1"},
    ],
)
async def test_restore_rejects_partial_repo_metadata(session_config):
    manager = SandboxManager()

    with pytest.raises(ValueError, match="repo_owner and repo_name must be provided together"):
        await manager.restore_from_snapshot(
            snapshot_image_id="img-abc",
            session_config=session_config,
        )


@pytest.mark.asyncio
async def test_user_env_vars_override_order(monkeypatch):
    captured = {}

    async def fake_create_aio(*args, **kwargs):
        captured["env"] = kwargs.get("env")

        class FakeSandbox:
            object_id = "obj-123"
            stdout = None

        return FakeSandbox()

    fake_create_aio.aio = fake_create_aio
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", fake_create_aio)

    manager = SandboxManager()
    config = SandboxConfig(
        repo_owner="acme",
        repo_name="repo",
        control_plane_url="https://control-plane.example",
        sandbox_auth_token="token-123",
        user_env_vars={
            "CONTROL_PLANE_URL": "https://malicious.example",
            "CUSTOM_SECRET": "value",
        },
    )

    await manager.create_sandbox(config)

    env_vars = captured["env"]
    assert env_vars["CONTROL_PLANE_URL"] == "https://control-plane.example"
    assert env_vars["CUSTOM_SECRET"] == "value"


@pytest.mark.asyncio
async def test_restore_user_env_vars_override_order(monkeypatch):
    captured = {}

    class FakeImage:
        object_id = "img-123"

    def fake_from_id(*args, **kwargs):
        return FakeImage()

    async def fake_create_aio(*args, **kwargs):
        captured["env"] = kwargs.get("env")

        class FakeSandbox:
            object_id = "obj-456"
            stdout = None

        return FakeSandbox()

    fake_create_aio.aio = fake_create_aio
    monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", fake_from_id)
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", fake_create_aio)

    manager = SandboxManager()
    await manager.restore_from_snapshot(
        snapshot_image_id="img-abc",
        session_config={
            "repo_owner": "acme",
            "repo_name": "repo",
            "provider": "anthropic",
            "model": "claude-sonnet-4-6",
            "session_id": "sess-1",
        },
        control_plane_url="https://control-plane.example",
        sandbox_auth_token="token-456",
        user_env_vars={
            "CONTROL_PLANE_URL": "https://malicious.example",
            "SANDBOX_AUTH_TOKEN": "evil-token",
            "CUSTOM_SECRET": "value",
        },
    )

    env_vars = captured["env"]
    # System vars must override user-provided values
    assert env_vars["CONTROL_PLANE_URL"] == "https://control-plane.example"
    assert env_vars["SANDBOX_AUTH_TOKEN"] == "token-456"
    # User vars that don't collide are preserved
    assert env_vars["CUSTOM_SECRET"] == "value"


@pytest.mark.asyncio
async def test_restore_uses_default_timeout(monkeypatch):
    """restore_from_snapshot defaults to DEFAULT_SANDBOX_TIMEOUT_SECONDS."""
    captured = {}

    class FakeImage:
        object_id = "img-123"

    def fake_from_id(*args, **kwargs):
        return FakeImage()

    async def fake_create_aio(*args, **kwargs):
        captured["timeout"] = kwargs.get("timeout")

        class FakeSandbox:
            object_id = "obj-789"
            stdout = None

        return FakeSandbox()

    fake_create_aio.aio = fake_create_aio
    monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", fake_from_id)
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", fake_create_aio)

    manager = SandboxManager()
    await manager.restore_from_snapshot(
        snapshot_image_id="img-abc",
        session_config={
            "repo_owner": "acme",
            "repo_name": "repo",
            "provider": "anthropic",
            "model": "claude-sonnet-4-6",
            "session_id": "sess-1",
        },
    )

    assert captured["timeout"] == DEFAULT_SANDBOX_TIMEOUT_SECONDS


@pytest.mark.asyncio
async def test_restore_uses_custom_timeout(monkeypatch):
    """restore_from_snapshot respects a custom timeout_seconds value."""
    captured = {}

    class FakeImage:
        object_id = "img-123"

    def fake_from_id(*args, **kwargs):
        return FakeImage()

    async def fake_create_aio(*args, **kwargs):
        captured["timeout"] = kwargs.get("timeout")

        class FakeSandbox:
            object_id = "obj-789"
            stdout = None

        return FakeSandbox()

    fake_create_aio.aio = fake_create_aio
    monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", fake_from_id)
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", fake_create_aio)

    manager = SandboxManager()
    await manager.restore_from_snapshot(
        snapshot_image_id="img-abc",
        session_config={
            "repo_owner": "acme",
            "repo_name": "repo",
            "provider": "anthropic",
            "model": "claude-sonnet-4-6",
            "session_id": "sess-1",
        },
        timeout_seconds=14400,
    )

    assert captured["timeout"] == 14400


@pytest.mark.asyncio
async def test_create_and_restore_timeout_consistency(monkeypatch):
    """create_sandbox and restore_from_snapshot produce the same timeout for the same config."""
    captured_create = {}
    captured_restore = {}

    class FakeImage:
        object_id = "img-123"

    def fake_from_id(*args, **kwargs):
        return FakeImage()

    async def fake_create_aio(*args, **kwargs):
        return_key = "restore" if captured_create.get("timeout") is not None else "create"
        if return_key == "create":
            captured_create["timeout"] = kwargs.get("timeout")
        else:
            captured_restore["timeout"] = kwargs.get("timeout")

        class FakeSandbox:
            object_id = "obj-789"
            stdout = None

        return FakeSandbox()

    fake_create_aio.aio = fake_create_aio
    monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", fake_from_id)
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", fake_create_aio)

    manager = SandboxManager()

    # Create with custom timeout
    config = SandboxConfig(
        repo_owner="acme",
        repo_name="repo",
        timeout_seconds=5400,
    )
    await manager.create_sandbox(config)

    # Restore with same timeout
    await manager.restore_from_snapshot(
        snapshot_image_id="img-abc",
        session_config={
            "repo_owner": "acme",
            "repo_name": "repo",
            "provider": "anthropic",
            "model": "claude-sonnet-4-6",
            "session_id": "sess-1",
        },
        timeout_seconds=5400,
    )

    assert captured_create["timeout"] == captured_restore["timeout"]
    assert captured_create["timeout"] == 5400


# ---------------------------------------------------------------------------
# restore_from_snapshot branch propagation tests
# ---------------------------------------------------------------------------


def _fake_restore_setup(monkeypatch):
    """Set up fakes for restore_from_snapshot tests, return captured dict."""
    captured = {}

    class FakeImage:
        object_id = "img-123"

    monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", lambda *a, **kw: FakeImage())
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))
    return captured


@pytest.mark.asyncio
async def test_restore_includes_branch_in_session_config(monkeypatch):
    """restore_from_snapshot must include branch in SESSION_CONFIG env var."""
    captured = _fake_restore_setup(monkeypatch)

    manager = SandboxManager()
    await manager.restore_from_snapshot(
        snapshot_image_id="img-abc",
        session_config={
            "repo_owner": "acme",
            "repo_name": "repo",
            "provider": "anthropic",
            "model": "claude-sonnet-4-6",
            "session_id": "sess-1",
            "branch": "feature/xyz",
        },
    )

    session_config = json.loads(captured["env"]["SESSION_CONFIG"])
    assert session_config["branch"] == "feature/xyz"


@pytest.mark.asyncio
async def test_restore_omits_branch_when_none(monkeypatch):
    """restore_from_snapshot should omit branch from SESSION_CONFIG when not provided."""
    captured = _fake_restore_setup(monkeypatch)

    manager = SandboxManager()
    await manager.restore_from_snapshot(
        snapshot_image_id="img-abc",
        session_config={
            "repo_owner": "acme",
            "repo_name": "repo",
            "provider": "anthropic",
            "model": "claude-sonnet-4-6",
            "session_id": "sess-1",
        },
    )

    session_config = json.loads(captured["env"]["SESSION_CONFIG"])
    assert "branch" not in session_config


@pytest.mark.asyncio
async def test_restore_with_session_config_object(monkeypatch):
    """restore_from_snapshot extracts branch from a SessionConfig object."""
    captured = _fake_restore_setup(monkeypatch)

    manager = SandboxManager()
    config = SessionConfig(
        session_id="sess-1",
        repo_owner="acme",
        repo_name="repo",
        branch="develop",
    )
    await manager.restore_from_snapshot(
        snapshot_image_id="img-abc",
        session_config=config,
    )

    session_config = json.loads(captured["env"]["SESSION_CONFIG"])
    assert session_config["branch"] == "develop"


# ---------------------------------------------------------------------------
# VCS env var injection tests
# ---------------------------------------------------------------------------


def _fake_sandbox_create(captured):
    """Return a fake Sandbox.create that supports .aio and captures env vars."""

    async def fake_create_aio(*args, **kwargs):
        captured["env"] = kwargs.get("env")

        class FakeSandbox:
            object_id = "obj-vcs"
            stdout = None

        return FakeSandbox()

    fake_create_aio.aio = fake_create_aio
    return fake_create_aio


# Note: fresh and repo-image sandboxes never receive SCM tokens in the
# environment. Callers only set fallback_clone_token for snapshot paths that
# still need VCS_CLONE_TOKEN for legacy entrypoints.


@pytest.mark.asyncio
async def test_vcs_env_vars_default_github(monkeypatch):
    """SCM_PROVIDER unset → github.com defaults, no token in env."""
    captured = {}
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))
    monkeypatch.delenv("SCM_PROVIDER", raising=False)

    manager = SandboxManager()
    config = SandboxConfig(
        repo_owner="acme",
        repo_name="repo",
    )
    await manager.create_sandbox(config)

    env = captured["env"]
    assert env["VCS_HOST"] == "github.com"
    assert env["VCS_CLONE_USERNAME"] == "x-access-token"
    assert "VCS_CLONE_TOKEN" not in env
    assert "GITHUB_APP_TOKEN" not in env
    assert "GITHUB_TOKEN" not in env


@pytest.mark.asyncio
async def test_vcs_env_vars_gitlab(monkeypatch):
    """SCM_PROVIDER=gitlab → gitlab.com + oauth2, no token in env."""
    captured = {}
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))
    monkeypatch.setenv("SCM_PROVIDER", "gitlab")

    manager = SandboxManager()
    config = SandboxConfig(
        repo_owner="acme",
        repo_name="repo",
    )
    await manager.create_sandbox(config)

    env = captured["env"]
    assert env["VCS_HOST"] == "gitlab.com"
    assert env["VCS_CLONE_USERNAME"] == "oauth2"
    assert "VCS_CLONE_TOKEN" not in env


@pytest.mark.asyncio
async def test_vcs_env_vars_bitbucket(monkeypatch):
    """SCM_PROVIDER=bitbucket → bitbucket.org + x-token-auth, no token in env."""
    captured = {}
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))
    monkeypatch.setenv("SCM_PROVIDER", "bitbucket")

    manager = SandboxManager()
    config = SandboxConfig(
        repo_owner="acme",
        repo_name="repo",
    )
    await manager.create_sandbox(config)

    env = captured["env"]
    assert env["VCS_HOST"] == "bitbucket.org"
    assert env["VCS_CLONE_USERNAME"] == "x-token-auth"
    assert "VCS_CLONE_TOKEN" not in env


@pytest.mark.asyncio
async def test_repo_image_boot_omits_fallback_tokens(monkeypatch):
    """Repo-image boots rely on brokered credentials only."""
    captured = {}

    class FakeImage:
        object_id = "repo-img-1"

    monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", lambda *a, **kw: FakeImage())
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))
    monkeypatch.delenv("SCM_PROVIDER", raising=False)

    manager = SandboxManager()
    config = SandboxConfig(
        repo_owner="acme",
        repo_name="repo",
        repo_image_id="repo-img-1",
    )
    await manager.create_sandbox(config)

    env = captured["env"]
    assert env["FROM_REPO_IMAGE"] == "true"
    assert "VCS_CLONE_TOKEN" not in env
    assert "GITHUB_TOKEN" not in env
    assert "GITHUB_APP_TOKEN" not in env
    assert "OI_GITHUB_TOKEN_IS_FALLBACK" not in env


@pytest.mark.asyncio
@pytest.mark.parametrize("token_key", ["GH_TOKEN", "GITHUB_TOKEN", "GITHUB_APP_TOKEN"])
async def test_repo_image_boot_preserves_user_github_cli_token(monkeypatch, token_key):
    """Repo-image boots do not replace user-provided GitHub CLI tokens."""
    captured = {}

    class FakeImage:
        object_id = "repo-img-1"

    monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", lambda *a, **kw: FakeImage())
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))
    monkeypatch.delenv("SCM_PROVIDER", raising=False)

    manager = SandboxManager()
    await manager.create_sandbox(
        SandboxConfig(
            repo_owner="acme",
            repo_name="repo",
            repo_image_id="repo-img-1",
            user_env_vars={token_key: "user_token"},
        )
    )

    env = captured["env"]
    assert env[token_key] == "user_token"
    assert "VCS_CLONE_TOKEN" not in env
    assert env.get("GITHUB_TOKEN") != "ghs_repo_image_token"
    assert env.get("GITHUB_APP_TOKEN") != "ghs_repo_image_token"
    assert "OI_GITHUB_TOKEN_IS_FALLBACK" not in env


@pytest.mark.asyncio
async def test_session_snapshot_boot_preserves_clone_token(monkeypatch):
    """A session-snapshot boot keeps the legacy fallback token."""
    captured = {}

    monkeypatch.setattr("src.sandbox.manager.modal.Image.from_registry", lambda *a, **kw: object())
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))
    monkeypatch.delenv("SCM_PROVIDER", raising=False)

    manager = SandboxManager()
    config = SandboxConfig(
        repo_owner="acme",
        repo_name="repo",
        fallback_clone_token="ghs_snapshot_token",
        snapshot_id="snap-1",
    )
    await manager.create_sandbox(config)

    env = captured["env"]
    assert env["VCS_CLONE_TOKEN"] == "ghs_snapshot_token"
    assert env["OI_GITHUB_TOKEN_IS_FALLBACK"] == "1"


@pytest.mark.asyncio
async def test_no_repo_session_snapshot_boot_omits_clone_token(monkeypatch):
    """A no-repository snapshot boot does not expose fallback VCS credentials."""
    captured = {}

    monkeypatch.setattr("src.sandbox.manager.modal.Image.from_registry", lambda *a, **kw: object())
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))
    monkeypatch.delenv("SCM_PROVIDER", raising=False)

    manager = SandboxManager()
    config = SandboxConfig(
        repo_owner=None,
        repo_name=None,
        fallback_clone_token="ghs_snapshot_token",
        snapshot_id="snap-1",
    )
    await manager.create_sandbox(config)

    env = captured["env"]
    assert "REPOSITORY_MODE" not in env
    assert env["REPO_OWNER"] == ""
    assert env["REPO_NAME"] == ""
    assert "VCS_HOST" not in env
    assert "VCS_CLONE_USERNAME" not in env
    assert "VCS_CLONE_TOKEN" not in env
    assert "GITHUB_TOKEN" not in env
    assert "GITHUB_APP_TOKEN" not in env
    assert "OI_GITHUB_TOKEN_IS_FALLBACK" not in env


@pytest.mark.asyncio
async def test_restore_preserves_vcs_clone_token_for_legacy_snapshots(monkeypatch):
    """Snapshot restore still injects VCS_CLONE_TOKEN.

    Snapshots taken before the credential-helper migration ship an old
    entrypoint that reads the env var and embeds it in the origin URL.
    Without it those snapshots can't fetch. The new entrypoint ignores it
    and routes through the helper, so the var is harmless on fresh images.
    For a non-GitHub provider, the GitHub CLI aliases stay absent.
    """
    captured = {}

    class FakeImage:
        object_id = "img-123"

    monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", lambda *a, **kw: FakeImage())
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))
    monkeypatch.setenv("SCM_PROVIDER", "bitbucket")

    manager = SandboxManager()
    await manager.restore_from_snapshot(
        snapshot_image_id="img-abc",
        session_config={
            "repo_owner": "acme",
            "repo_name": "repo",
            "provider": "anthropic",
            "model": "claude-sonnet-4-6",
            "session_id": "sess-1",
        },
        clone_token="bb_token_xyz",
    )

    env = captured["env"]
    assert env["VCS_HOST"] == "bitbucket.org"
    assert env["VCS_CLONE_USERNAME"] == "x-token-auth"
    assert env["VCS_CLONE_TOKEN"] == "bb_token_xyz"
    assert "GITHUB_APP_TOKEN" not in env
    assert "GITHUB_TOKEN" not in env


@pytest.mark.asyncio
async def test_restore_github_includes_gh_cli_aliases(monkeypatch):
    """On GitHub, snapshot restore also sets GITHUB_TOKEN/GITHUB_APP_TOKEN.

    Legacy snapshots lack the gh wrapper, so the CLI needs the token in env.
    """
    captured = {}

    class FakeImage:
        object_id = "img-123"

    monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", lambda *a, **kw: FakeImage())
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))
    monkeypatch.delenv("SCM_PROVIDER", raising=False)

    manager = SandboxManager()
    await manager.restore_from_snapshot(
        snapshot_image_id="img-abc",
        session_config={
            "repo_owner": "acme",
            "repo_name": "repo",
            "provider": "anthropic",
            "model": "claude-sonnet-4-6",
            "session_id": "sess-1",
        },
        clone_token="ghs_restore_token",
    )

    env = captured["env"]
    assert env["VCS_HOST"] == "github.com"
    assert env["VCS_CLONE_TOKEN"] == "ghs_restore_token"
    assert env["GITHUB_TOKEN"] == "ghs_restore_token"
    assert env["GITHUB_APP_TOKEN"] == "ghs_restore_token"
    # Marked so the gh wrapper on helper-capable snapshots refreshes past it
    # instead of reusing the soon-expired restore token.
    assert env["OI_GITHUB_TOKEN_IS_FALLBACK"] == "1"


@pytest.mark.asyncio
async def test_no_repo_restore_omits_clone_token(monkeypatch):
    """No-repository snapshot restores must not expose VCS credentials."""
    captured = {}

    class FakeImage:
        object_id = "img-123"

    monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", lambda *a, **kw: FakeImage())
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))
    monkeypatch.delenv("SCM_PROVIDER", raising=False)

    manager = SandboxManager()
    await manager.restore_from_snapshot(
        snapshot_image_id="img-abc",
        session_config={
            "repo_owner": None,
            "repo_name": None,
            "provider": "anthropic",
            "model": "claude-sonnet-4-6",
            "session_id": "sess-1",
        },
        clone_token="ghs_restore_token",
    )

    env = captured["env"]
    assert "REPOSITORY_MODE" not in env
    assert env["REPO_OWNER"] == ""
    assert env["REPO_NAME"] == ""
    assert "VCS_HOST" not in env
    assert "VCS_CLONE_USERNAME" not in env
    assert "VCS_CLONE_TOKEN" not in env
    assert "GITHUB_TOKEN" not in env
    assert "GITHUB_APP_TOKEN" not in env
    assert "OI_GITHUB_TOKEN_IS_FALLBACK" not in env

import json

import pytest

from src.sandbox.manager import DEFAULT_SANDBOX_TIMEOUT_SECONDS, SandboxConfig, SandboxManager


@pytest.mark.asyncio
async def test_user_env_vars_override_order(monkeypatch):
    captured = {}

    def fake_create(*args, **kwargs):
        captured["env"] = kwargs.get("env")

        class FakeSandbox:
            object_id = "obj-123"
            stdout = None

        return FakeSandbox()

    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", fake_create)

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

    def fake_create(*args, **kwargs):
        captured["env"] = kwargs.get("env")

        class FakeSandbox:
            object_id = "obj-456"
            stdout = None

        return FakeSandbox()

    monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", fake_from_id)
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", fake_create)

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

    def fake_create(*args, **kwargs):
        captured["timeout"] = kwargs.get("timeout")

        class FakeSandbox:
            object_id = "obj-789"
            stdout = None

        return FakeSandbox()

    monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", fake_from_id)
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", fake_create)

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

    def fake_create(*args, **kwargs):
        captured["timeout"] = kwargs.get("timeout")

        class FakeSandbox:
            object_id = "obj-789"
            stdout = None

        return FakeSandbox()

    monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", fake_from_id)
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", fake_create)

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

    def fake_create(*args, **kwargs):
        return_key = "restore" if captured_create.get("timeout") is not None else "create"
        if return_key == "create":
            captured_create["timeout"] = kwargs.get("timeout")
        else:
            captured_restore["timeout"] = kwargs.get("timeout")

        class FakeSandbox:
            object_id = "obj-789"
            stdout = None

        return FakeSandbox()

    monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", fake_from_id)
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", fake_create)

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
# VCS env var injection tests
# ---------------------------------------------------------------------------


def _fake_sandbox_create(captured):
    """Return a fake Sandbox.create that captures env vars."""

    def fake_create(*args, **kwargs):
        captured["env"] = kwargs.get("env")

        class FakeSandbox:
            object_id = "obj-vcs"
            stdout = None

        return FakeSandbox()

    return fake_create


@pytest.mark.asyncio
async def test_vcs_env_vars_default_github(monkeypatch):
    """SCM_PROVIDER unset → github.com defaults."""
    captured = {}
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))
    monkeypatch.delenv("SCM_PROVIDER", raising=False)

    manager = SandboxManager()
    config = SandboxConfig(
        repo_owner="acme",
        repo_name="repo",
        clone_token="ghp_test123",
    )
    await manager.create_sandbox(config)

    env = captured["env"]
    assert env["VCS_HOST"] == "github.com"
    assert env["VCS_CLONE_USERNAME"] == "x-access-token"
    assert env["VCS_CLONE_TOKEN"] == "ghp_test123"
    assert env["GITHUB_APP_TOKEN"] == "ghp_test123"
    assert env["GITHUB_TOKEN"] == "ghp_test123"


@pytest.mark.asyncio
async def test_vcs_env_vars_explicit_github(monkeypatch):
    """SCM_PROVIDER=github → same as default."""
    captured = {}
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))
    monkeypatch.setenv("SCM_PROVIDER", "github")

    manager = SandboxManager()
    config = SandboxConfig(
        repo_owner="acme",
        repo_name="repo",
        clone_token="ghp_test123",
    )
    await manager.create_sandbox(config)

    env = captured["env"]
    assert env["VCS_HOST"] == "github.com"
    assert env["VCS_CLONE_USERNAME"] == "x-access-token"
    assert env["VCS_CLONE_TOKEN"] == "ghp_test123"


@pytest.mark.asyncio
async def test_vcs_env_vars_bitbucket(monkeypatch):
    """SCM_PROVIDER=bitbucket → bitbucket.org + x-token-auth."""
    captured = {}
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))
    monkeypatch.setenv("SCM_PROVIDER", "bitbucket")

    manager = SandboxManager()
    config = SandboxConfig(
        repo_owner="acme",
        repo_name="repo",
        clone_token="bb_token_abc",
    )
    await manager.create_sandbox(config)

    env = captured["env"]
    assert env["VCS_HOST"] == "bitbucket.org"
    assert env["VCS_CLONE_USERNAME"] == "x-token-auth"
    assert env["VCS_CLONE_TOKEN"] == "bb_token_abc"
    # GitHub-specific vars not set for Bitbucket
    assert "GITHUB_APP_TOKEN" not in env
    assert "GITHUB_TOKEN" not in env


@pytest.mark.asyncio
async def test_vcs_env_vars_no_token(monkeypatch):
    """No clone token → token vars absent, host/username still set."""
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
async def test_restore_vcs_env_vars(monkeypatch):
    """restore_from_snapshot injects VCS env vars."""
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
    # GitHub-specific vars not set for Bitbucket
    assert "GITHUB_APP_TOKEN" not in env
    assert "GITHUB_TOKEN" not in env


@pytest.mark.asyncio
async def test_restore_preserves_branch_in_session_config(monkeypatch):
    """restore_from_snapshot should include branch in SESSION_CONFIG."""
    captured = {}

    class FakeImage:
        object_id = "img-123"

    monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", lambda *a, **kw: FakeImage())
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))

    manager = SandboxManager()
    await manager.restore_from_snapshot(
        snapshot_image_id="img-branch",
        session_config={
            "repo_owner": "acme",
            "repo_name": "repo",
            "provider": "anthropic",
            "model": "claude-sonnet-4-6",
            "session_id": "sess-branch",
            "branch": "feature/test-branch",
        },
    )

    session_config = json.loads(captured["env"]["SESSION_CONFIG"])
    assert session_config["branch"] == "feature/test-branch"

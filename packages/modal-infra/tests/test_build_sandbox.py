"""Tests for SandboxManager.create_build_sandbox()."""

import json

import pytest

from src.sandbox.manager import SandboxManager


def _fake_sandbox_create(captured):
    """Return a fake Sandbox.create that captures kwargs."""

    def fake_create(*args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs
        captured["env"] = kwargs.get("env")
        captured["timeout"] = kwargs.get("timeout")
        captured["secrets"] = kwargs.get("secrets")
        captured["image"] = kwargs.get("image")

        class FakeSandbox:
            object_id = "obj-build-123"
            stdout = None

        return FakeSandbox()

    return fake_create


@pytest.mark.asyncio
async def test_env_vars_include_image_build_mode(monkeypatch):
    """Should set IMAGE_BUILD_MODE=true in env vars."""
    captured = {}
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))

    manager = SandboxManager()
    await manager.create_build_sandbox(
        repo_owner="acme",
        repo_name="my-repo",
    )

    env = captured["env"]
    assert env["IMAGE_BUILD_MODE"] == "true"


@pytest.mark.asyncio
async def test_env_vars_include_repo_info(monkeypatch):
    """Should include REPO_OWNER, REPO_NAME, and SANDBOX_ID."""
    captured = {}
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))

    manager = SandboxManager()
    await manager.create_build_sandbox(
        repo_owner="acme",
        repo_name="my-repo",
    )

    env = captured["env"]
    assert env["REPO_OWNER"] == "acme"
    assert env["REPO_NAME"] == "my-repo"
    assert env["SANDBOX_ID"].startswith("build-acme-my-repo-")


@pytest.mark.asyncio
async def test_session_config_includes_branch(monkeypatch):
    """SESSION_CONFIG should contain the default branch."""
    captured = {}
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))

    manager = SandboxManager()
    await manager.create_build_sandbox(
        repo_owner="acme",
        repo_name="my-repo",
        default_branch="develop",
    )

    env = captured["env"]
    session_config = json.loads(env["SESSION_CONFIG"])
    assert session_config["branch"] == "develop"


@pytest.mark.asyncio
async def test_no_control_plane_or_auth_vars(monkeypatch):
    """Should NOT include CONTROL_PLANE_URL, SANDBOX_AUTH_TOKEN, or LLM vars."""
    captured = {}
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))

    manager = SandboxManager()
    await manager.create_build_sandbox(
        repo_owner="acme",
        repo_name="my-repo",
    )

    env = captured["env"]
    assert "CONTROL_PLANE_URL" not in env
    assert "SANDBOX_AUTH_TOKEN" not in env
    assert "ANTHROPIC_API_KEY" not in env


@pytest.mark.asyncio
async def test_timeout_is_1800(monkeypatch):
    """Build sandbox should use 30-minute (1800s) timeout."""
    captured = {}
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))

    manager = SandboxManager()
    await manager.create_build_sandbox(
        repo_owner="acme",
        repo_name="my-repo",
    )

    assert captured["timeout"] == 1800


@pytest.mark.asyncio
async def test_no_llm_secrets(monkeypatch):
    """Build sandbox should have empty secrets list (no LLM keys)."""
    captured = {}
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))

    manager = SandboxManager()
    await manager.create_build_sandbox(
        repo_owner="acme",
        repo_name="my-repo",
    )

    assert captured["secrets"] == []


@pytest.mark.asyncio
async def test_sandbox_id_format(monkeypatch):
    """Sandbox ID should match build-{owner}-{repo}-{timestamp} format."""
    captured = {}
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))

    manager = SandboxManager()
    handle = await manager.create_build_sandbox(
        repo_owner="acme",
        repo_name="my-repo",
    )

    assert handle.sandbox_id.startswith("build-acme-my-repo-")
    # Timestamp part (after the last dash) should be numeric
    prefix = "build-acme-my-repo-"
    timestamp_part = handle.sandbox_id[len(prefix) :]
    assert timestamp_part.isdigit(), f"Expected numeric timestamp, got '{timestamp_part}'"


@pytest.mark.asyncio
async def test_injects_vcs_env_vars_with_token(monkeypatch):
    """Should inject VCS env vars when clone_token is provided."""
    captured = {}
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))
    monkeypatch.delenv("SCM_PROVIDER", raising=False)

    manager = SandboxManager()
    await manager.create_build_sandbox(
        repo_owner="acme",
        repo_name="my-repo",
        clone_token="ghp_test_token",
    )

    env = captured["env"]
    assert env["VCS_CLONE_TOKEN"] == "ghp_test_token"
    assert env["VCS_HOST"] == "github.com"


@pytest.mark.asyncio
async def test_no_vcs_token_vars_without_token(monkeypatch):
    """Should not inject VCS_CLONE_TOKEN when clone_token is empty."""
    captured = {}
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))
    monkeypatch.delenv("SCM_PROVIDER", raising=False)

    manager = SandboxManager()
    await manager.create_build_sandbox(
        repo_owner="acme",
        repo_name="my-repo",
        clone_token="",
    )

    env = captured["env"]
    assert "VCS_CLONE_TOKEN" not in env


@pytest.mark.asyncio
async def test_returns_sandbox_handle(monkeypatch):
    """Should return a SandboxHandle with correct fields."""
    captured = {}
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))

    manager = SandboxManager()
    handle = await manager.create_build_sandbox(
        repo_owner="acme",
        repo_name="my-repo",
    )

    assert handle.sandbox_id.startswith("build-acme-my-repo-")
    assert handle.modal_object_id == "obj-build-123"
    assert handle.created_at > 0


@pytest.mark.asyncio
async def test_user_env_vars_injected(monkeypatch):
    """User env vars should appear in sandbox env when provided."""
    captured = {}
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))

    manager = SandboxManager()
    await manager.create_build_sandbox(
        repo_owner="acme",
        repo_name="my-repo",
        user_env_vars={"NPM_TOKEN": "tok_abc", "CUSTOM_VAR": "hello"},
    )

    env = captured["env"]
    assert env["NPM_TOKEN"] == "tok_abc"
    assert env["CUSTOM_VAR"] == "hello"
    # System vars still present
    assert env["IMAGE_BUILD_MODE"] == "true"
    assert env["REPO_OWNER"] == "acme"


@pytest.mark.asyncio
async def test_user_env_vars_none_by_default(monkeypatch):
    """When user_env_vars is None, only system vars should be present."""
    captured = {}
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))

    manager = SandboxManager()
    await manager.create_build_sandbox(
        repo_owner="acme",
        repo_name="my-repo",
    )

    env = captured["env"]
    assert "NPM_TOKEN" not in env
    assert env["IMAGE_BUILD_MODE"] == "true"


@pytest.mark.asyncio
async def test_system_vars_override_user_env_vars(monkeypatch):
    """System vars like IMAGE_BUILD_MODE must not be overridden by user env vars."""
    captured = {}
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", _fake_sandbox_create(captured))

    manager = SandboxManager()
    await manager.create_build_sandbox(
        repo_owner="acme",
        repo_name="my-repo",
        user_env_vars={"IMAGE_BUILD_MODE": "false", "SANDBOX_ID": "evil"},
    )

    env = captured["env"]
    assert env["IMAGE_BUILD_MODE"] == "true"
    assert env["SANDBOX_ID"].startswith("build-acme-my-repo-")

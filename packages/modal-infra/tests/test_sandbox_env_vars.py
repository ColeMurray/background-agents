import json

import pytest

from sandbox_runtime.constants import (
    NOVNC_PORT_ENV_VAR,
    USER_SECRET_KEYS_ENV_VAR,
    VNC_PASSWORD_ENV_VAR,
    VNC_PASSWORD_MAX_BYTES,
)
from sandbox_runtime.types import SessionConfig
from src.sandbox.launch import SandboxLauncher
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
        await manager.create_sandbox(
            SandboxConfig(
                clone_host="github.com",
                clone_username="x-access-token",
                repo_owner=repo_owner,
                repo_name=repo_name,
            )
        )


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
            clone_host="github.com",
            clone_username="x-access-token",
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
    monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", fake_create_aio)

    manager = SandboxManager()
    config = SandboxConfig(
        clone_host="github.com",
        clone_username="x-access-token",
        repo_owner="acme",
        repo_name="repo",
        control_plane_url="https://control-plane.example",
        sandbox_auth_token="token-123",
        user_env_vars={
            "CONTROL_PLANE_URL": "https://malicious.example",
            "CUSTOM_SECRET": "value",
            "FOO": "x",
            "STRIPE_ACCOUNT": "12",
            USER_SECRET_KEYS_ENV_VAR: '["FORGED"]',
            VNC_PASSWORD_ENV_VAR: "user-password",
            NOVNC_PORT_ENV_VAR: "6099",
        },
    )

    await manager.create_sandbox(config)

    env_vars = captured["env"]
    assert env_vars["CONTROL_PLANE_URL"] == "https://control-plane.example"
    assert env_vars["SANDBOX_TIMEOUT_SECONDS"] == str(DEFAULT_SANDBOX_TIMEOUT_SECONDS)
    assert env_vars["CUSTOM_SECRET"] == "value"
    assert env_vars["FOO"] == "x"
    assert env_vars["STRIPE_ACCOUNT"] == "12"
    assert json.loads(env_vars[USER_SECRET_KEYS_ENV_VAR]) == [
        "CUSTOM_SECRET",
        "FOO",
        "STRIPE_ACCOUNT",
    ]
    assert VNC_PASSWORD_ENV_VAR not in env_vars
    assert NOVNC_PORT_ENV_VAR not in env_vars


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
    monkeypatch.setattr("src.sandbox.launch.modal.Image.from_id", fake_from_id)
    monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", fake_create_aio)

    manager = SandboxManager()
    await manager.restore_from_snapshot(
        clone_host="github.com",
        clone_username="x-access-token",
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
            "FOO": "x",
            "STRIPE_ACCOUNT": "12",
            USER_SECRET_KEYS_ENV_VAR: '["FORGED"]',
            VNC_PASSWORD_ENV_VAR: "user-password",
            NOVNC_PORT_ENV_VAR: "6099",
        },
    )

    env_vars = captured["env"]
    # System vars must override user-provided values
    assert env_vars["CONTROL_PLANE_URL"] == "https://control-plane.example"
    assert env_vars["SANDBOX_AUTH_TOKEN"] == "token-456"
    assert env_vars["SANDBOX_TIMEOUT_SECONDS"] == str(DEFAULT_SANDBOX_TIMEOUT_SECONDS)
    # User vars that don't collide are preserved
    assert env_vars["CUSTOM_SECRET"] == "value"
    assert env_vars["FOO"] == "x"
    assert env_vars["STRIPE_ACCOUNT"] == "12"
    assert json.loads(env_vars[USER_SECRET_KEYS_ENV_VAR]) == [
        "CUSTOM_SECRET",
        "FOO",
        "STRIPE_ACCOUNT",
    ]
    assert VNC_PASSWORD_ENV_VAR not in env_vars
    assert NOVNC_PORT_ENV_VAR not in env_vars


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("managed_marker", "suppressed_api_key"),
    [
        ("OPENAI_OAUTH_MANAGED", "OPENAI_API_KEY"),
        ("XAI_OAUTH_MANAGED", "XAI_API_KEY"),
        ("ANTHROPIC_OAUTH_MANAGED", "ANTHROPIC_API_KEY"),
    ],
)
async def test_create_preserves_managed_provider_env_isolation(
    monkeypatch, managed_marker, suppressed_api_key
):
    captured = {}
    monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", _fake_sandbox_create(captured))

    await SandboxManager().create_sandbox(
        SandboxConfig(
            clone_host="github.com",
            clone_username="x-access-token",
            repo_owner="acme",
            repo_name="repo",
            user_env_vars={managed_marker: "1", "CUSTOM_SECRET": "value"},
        )
    )

    assert captured["env"][managed_marker] == "1"
    assert suppressed_api_key not in captured["env"]
    assert json.loads(captured["env"][USER_SECRET_KEYS_ENV_VAR]) == ["CUSTOM_SECRET"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("managed_marker", "suppressed_api_key"),
    [
        ("OPENAI_OAUTH_MANAGED", "OPENAI_API_KEY"),
        ("XAI_OAUTH_MANAGED", "XAI_API_KEY"),
        ("ANTHROPIC_OAUTH_MANAGED", "ANTHROPIC_API_KEY"),
    ],
)
async def test_restore_preserves_managed_provider_env_isolation(
    monkeypatch, managed_marker, suppressed_api_key
):
    captured = _fake_restore_setup(monkeypatch)

    await SandboxManager().restore_from_snapshot(
        clone_host="github.com",
        clone_username="x-access-token",
        snapshot_image_id="img-abc",
        session_config={"session_id": "sess-1"},
        user_env_vars={managed_marker: "1", "CUSTOM_SECRET": "value"},
    )

    assert captured["env"][managed_marker] == "1"
    assert suppressed_api_key not in captured["env"]
    assert json.loads(captured["env"][USER_SECRET_KEYS_ENV_VAR]) == ["CUSTOM_SECRET"]


@pytest.mark.asyncio
@pytest.mark.parametrize("launch_mode", ["create", "repo-image", "restore"])
@pytest.mark.parametrize("user_env_vars", [None, {}, {USER_SECRET_KEYS_ENV_VAR: '["FORGED"]'}])
async def test_empty_user_secret_inventory_overwrites_forged_metadata(
    monkeypatch, launch_mode, user_env_vars
):
    captured = _fake_restore_setup(monkeypatch)
    monkeypatch.setenv(USER_SECRET_KEYS_ENV_VAR, '["INHERITED"]')
    manager = SandboxManager()

    if launch_mode == "restore":
        await manager.restore_from_snapshot(
            clone_host="github.com",
            clone_username="x-access-token",
            snapshot_image_id="img-abc",
            session_config={"session_id": "sess-1"},
            user_env_vars=user_env_vars,
        )
    else:
        await manager.create_sandbox(
            SandboxConfig(
                clone_host="github.com",
                clone_username="x-access-token",
                repo_owner="acme",
                repo_name="repo",
                repo_image_id="repo-img-1" if launch_mode == "repo-image" else None,
                user_env_vars=user_env_vars,
            )
        )

    assert captured["env"][USER_SECRET_KEYS_ENV_VAR] == "[]"


def test_generated_vnc_password_respects_protocol_limit():
    assert len(SandboxLauncher._generate_vnc_password().encode()) == VNC_PASSWORD_MAX_BYTES


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
    monkeypatch.setattr("src.sandbox.launch.modal.Image.from_id", fake_from_id)
    monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", fake_create_aio)

    manager = SandboxManager()
    await manager.restore_from_snapshot(
        clone_host="github.com",
        clone_username="x-access-token",
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
        captured["env"] = kwargs.get("env")

        class FakeSandbox:
            object_id = "obj-789"
            stdout = None

        return FakeSandbox()

    fake_create_aio.aio = fake_create_aio
    monkeypatch.setattr("src.sandbox.launch.modal.Image.from_id", fake_from_id)
    monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", fake_create_aio)

    manager = SandboxManager()
    await manager.restore_from_snapshot(
        clone_host="github.com",
        clone_username="x-access-token",
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
    assert captured["env"]["SANDBOX_TIMEOUT_SECONDS"] == "14400"


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
    monkeypatch.setattr("src.sandbox.launch.modal.Image.from_id", fake_from_id)
    monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", fake_create_aio)

    manager = SandboxManager()

    # Create with custom timeout
    config = SandboxConfig(
        clone_host="github.com",
        clone_username="x-access-token",
        repo_owner="acme",
        repo_name="repo",
        timeout_seconds=5400,
    )
    await manager.create_sandbox(config)

    # Restore with same timeout
    await manager.restore_from_snapshot(
        clone_host="github.com",
        clone_username="x-access-token",
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

    monkeypatch.setattr("src.sandbox.launch.modal.Image.from_id", lambda *a, **kw: FakeImage())
    monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", _fake_sandbox_create(captured))
    return captured


@pytest.mark.asyncio
async def test_restore_includes_branch_in_session_config(monkeypatch):
    """restore_from_snapshot must include branch in SESSION_CONFIG env var."""
    captured = _fake_restore_setup(monkeypatch)

    manager = SandboxManager()
    await manager.restore_from_snapshot(
        clone_host="github.com",
        clone_username="x-access-token",
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
        clone_host="github.com",
        clone_username="x-access-token",
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
async def test_restore_serializes_typed_session_config(monkeypatch):
    captured = _fake_restore_setup(monkeypatch)

    await SandboxManager().restore_from_snapshot(
        clone_host="github.com",
        clone_username="x-access-token",
        snapshot_image_id="img-abc",
        session_config=SessionConfig(
            session_id="sess-1",
            repo_owner="acme",
            repo_name="repo",
            branch="develop",
        ),
    )

    session_config = json.loads(captured["env"]["SESSION_CONFIG"])
    assert session_config["repo_owner"] == "acme"
    assert session_config["repo_name"] == "repo"
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


_SYSTEM_TOKEN_KEYS = ("VCS_CLONE_TOKEN", "GITHUB_TOKEN", "GITHUB_APP_TOKEN", "GH_TOKEN")


def _assert_identity_without_system_tokens(env: dict[str, str]) -> None:
    assert env["VCS_HOST"] == "gitlab.example"
    assert env["VCS_CLONE_USERNAME"] == "oauth2"
    for key in _SYSTEM_TOKEN_KEYS:
        assert key not in env


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "repo_fields",
    [
        {"repo_owner": "acme", "repo_name": "repo"},
        {"repo_owner": "acme", "repo_name": "repo", "repo_image_id": "repo-img-1"},
        {"repo_owner": None, "repo_name": None},
    ],
    ids=["base", "repo-image", "no-repo"],
)
async def test_create_injects_control_plane_identity_without_tokens(monkeypatch, repo_fields):
    """Created sandboxes get the supplied VCS identity and rely on brokered credentials."""
    captured = {}
    monkeypatch.setattr("src.sandbox.launch.modal.Image.from_id", lambda *a, **kw: object())
    monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", _fake_sandbox_create(captured))

    await SandboxManager().create_sandbox(
        SandboxConfig(
            clone_host="gitlab.example",
            clone_username="oauth2",
            user_env_vars={"FOO": "x", "STRIPE_ACCOUNT": "12", "EMPTY": ""},
            **repo_fields,
        )
    )

    _assert_identity_without_system_tokens(captured["env"])
    assert captured["env"]["FOO"] == "x"
    assert captured["env"]["STRIPE_ACCOUNT"] == "12"
    assert captured["env"]["EMPTY"] == ""
    assert json.loads(captured["env"][USER_SECRET_KEYS_ENV_VAR]) == [
        "FOO",
        "STRIPE_ACCOUNT",
        "EMPTY",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("token_key", ["GH_TOKEN", "GITHUB_TOKEN", "GITHUB_APP_TOKEN"])
async def test_repo_image_boot_preserves_user_github_cli_token(monkeypatch, token_key):
    """Repo-image boots do not replace user-provided GitHub CLI tokens."""
    captured = {}
    monkeypatch.setattr("src.sandbox.launch.modal.Image.from_id", lambda *a, **kw: object())
    monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", _fake_sandbox_create(captured))

    await SandboxManager().create_sandbox(
        SandboxConfig(
            clone_host="github.com",
            clone_username="x-access-token",
            repo_owner="acme",
            repo_name="repo",
            repo_image_id="repo-img-1",
            user_env_vars={token_key: "user_token"},
        )
    )

    env = captured["env"]
    assert env[token_key] == "user_token"
    assert "VCS_CLONE_TOKEN" not in env
    assert json.loads(env[USER_SECRET_KEYS_ENV_VAR]) == [token_key]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "repo_fields",
    [{"repo_owner": "acme", "repo_name": "repo"}, {"repo_owner": None, "repo_name": None}],
    ids=["repo", "no-repo"],
)
async def test_restore_injects_control_plane_identity_without_system_tokens(
    monkeypatch, repo_fields
):
    """Restores never forward function-level system credentials into the sandbox."""
    captured = {}
    monkeypatch.setattr("src.sandbox.launch.modal.Image.from_id", lambda *a, **kw: object())
    monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", _fake_sandbox_create(captured))
    monkeypatch.setenv("VCS_CLONE_TOKEN", "system-clone-token")
    monkeypatch.setenv("GITLAB_ACCESS_TOKEN", "system-gitlab-token")
    monkeypatch.setenv("GITHUB_TOKEN", "system-github-token")
    monkeypatch.setenv("GITHUB_APP_PRIVATE_KEY", "system-private-key")

    await SandboxManager().restore_from_snapshot(
        snapshot_image_id="img-abc",
        session_config={"session_id": "sess-1", **repo_fields},
        clone_host="gitlab.example",
        clone_username="oauth2",
    )

    env = captured["env"]
    assert env["RESTORED_FROM_SNAPSHOT"] == "true"
    assert env["REPO_OWNER"] == (repo_fields["repo_owner"] or "")
    _assert_identity_without_system_tokens(env)
    assert "GITLAB_ACCESS_TOKEN" not in env
    assert "GITHUB_APP_PRIVATE_KEY" not in env


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "user_token_key", [None, "GH_TOKEN", "GITHUB_TOKEN", "GITHUB_APP_TOKEN", "VCS_CLONE_TOKEN"]
)
async def test_restore_preserves_user_tokens_without_generating_gh_cli_aliases(
    monkeypatch, user_token_key
):
    """Restore neither strips user tokens nor adds system GitHub CLI aliases."""
    captured = {}
    monkeypatch.setattr("src.sandbox.launch.modal.Image.from_id", lambda *a, **kw: object())
    monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", _fake_sandbox_create(captured))

    await SandboxManager().restore_from_snapshot(
        snapshot_image_id="img-abc",
        session_config={"session_id": "sess-1", "repo_owner": "acme", "repo_name": "repo"},
        clone_host="github.com",
        clone_username="x-access-token",
        user_env_vars={user_token_key: "user-token"} if user_token_key else None,
    )

    env = captured["env"]
    assert json.loads(env[USER_SECRET_KEYS_ENV_VAR]) == ([user_token_key] if user_token_key else [])
    for key in _SYSTEM_TOKEN_KEYS:
        if key == user_token_key:
            assert env[key] == "user-token"
        else:
            assert key not in env

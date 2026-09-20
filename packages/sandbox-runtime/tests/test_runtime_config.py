import json
from types import MappingProxyType

import pytest

from sandbox_runtime.runtime_config import BootMode, RuntimeConfig


@pytest.mark.parametrize(
    ("environment", "expected"),
    [
        ({}, BootMode.FRESH),
        ({"FROM_REPO_IMAGE": "true"}, BootMode.REPO_IMAGE),
        ({"RESTORED_FROM_SNAPSHOT": "true"}, BootMode.SNAPSHOT_RESTORE),
        (
            {"IMAGE_BUILD_MODE": "true", "RESTORED_FROM_SNAPSHOT": "true"},
            BootMode.BUILD,
        ),
    ],
)
def test_boot_mode_precedence(environment, expected):
    assert BootMode.from_env(environment) is expected


def test_runtime_config_parses_frozen_values_without_environment_patching(tmp_path):
    config = RuntimeConfig.from_env(
        {
            "SANDBOX_ID": "sandbox-1",
            "CONTROL_PLANE_URL": "https://control.example",
            "SANDBOX_AUTH_TOKEN": "token",
            "REPO_OWNER": "group/subgroup",
            "REPO_NAME": "repo",
            "VCS_HOST": "gitlab.example",
            "SESSION_CONFIG": json.dumps({"session_id": "session-1", "branch": "develop"}),
        },
        workspace_path=tmp_path,
    )

    assert config.repo_path == tmp_path / "repo"
    assert config.session_id == "session-1"
    assert config.base_branch == "develop"
    assert config.has_repository is True


def test_runtime_config_rejects_non_object_session_config():
    with pytest.raises(ValueError, match="JSON object"):
        RuntimeConfig.from_env({"SESSION_CONFIG": "[]"})


@pytest.mark.parametrize(
    ("sandbox_execution", "expected"),
    [
        (None, False),
        ({"profile": "default"}, False),
        (
            {
                "profile": "docker-v1",
                "provider": "modal",
                "cpuCores": 2.0,
                "memoryMib": 4096,
            },
            True,
        ),
    ],
)
def test_docker_enabled_uses_validated_execution_profile(sandbox_execution, expected):
    session_config = {} if sandbox_execution is None else {"sandbox_execution": sandbox_execution}
    config = RuntimeConfig.from_env({"SESSION_CONFIG": json.dumps(session_config)})

    assert config.docker_enabled is expected
    if expected:
        with pytest.raises(ValueError, match="frozen"):
            config.sandbox_execution.profile = "default"
        assert config.docker_enabled is True


@pytest.mark.parametrize(
    "sandbox_execution",
    [None, {"profile": "unknown"}, {"profile": False}],
)
def test_runtime_config_rejects_malformed_execution_profile(sandbox_execution):
    with pytest.raises(ValueError):
        RuntimeConfig.from_env(
            {"SESSION_CONFIG": json.dumps({"sandbox_execution": sandbox_execution})}
        )


@pytest.mark.parametrize(
    "url", ["http://control.example", "ftp://control.example", "control.example"]
)
def test_runtime_config_rejects_insecure_control_plane_url(url):
    with pytest.raises(ValueError, match="must use HTTPS"):
        RuntimeConfig.from_env({"CONTROL_PLANE_URL": url})


@pytest.mark.parametrize(
    "url",
    ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"],
)
def test_runtime_config_allows_loopback_http_control_plane_url(url):
    assert RuntimeConfig.from_env({"CONTROL_PLANE_URL": url}).control_plane_url == url


def test_session_config_is_recursively_immutable():
    config = RuntimeConfig.from_env(
        {
            "SESSION_CONFIG": json.dumps(
                {"repositories": [{"repo_owner": "acme", "repo_name": "app"}]}
            )
        }
    )

    assert isinstance(config.session_config, MappingProxyType)
    repositories = config.session_config["repositories"]
    assert isinstance(repositories, tuple)
    assert isinstance(repositories[0], MappingProxyType)
    with pytest.raises(TypeError):
        repositories[0]["repo_name"] = "changed"

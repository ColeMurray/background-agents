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
    assert config.base_branch == "develop"
    assert config.has_repository is True


def test_runtime_config_rejects_non_object_session_config():
    with pytest.raises(ValueError, match="JSON object"):
        RuntimeConfig.from_env({"SESSION_CONFIG": "[]"})


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

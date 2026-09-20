import pytest
from pydantic import ValidationError

from src.sandbox.execution import resolve_execution
from src.web_api import (
    CreateSandboxRequest,
    CreateSandboxV2Request,
    RestoreSandboxRequest,
    RestoreSandboxV2Request,
)

DOCKER = {"profile": "docker-v1", "provider": "modal", "cpuCores": 2, "memoryMib": 4096}
BASE = {"session_id": "s1", "control_plane_url": "https://cp.test", "sandbox_auth_token": "token"}


@pytest.mark.parametrize(
    "execution",
    [
        None,
        {},
        {"profile": "docker-v2"},
        {**DOCKER, "cpuCores": True},
        {**DOCKER, "memoryMib": "4096"},
    ],
)
def test_versioned_launch_rejects_malformed_execution(execution):
    with pytest.raises(ValidationError):
        CreateSandboxV2Request.model_validate({**BASE, "sandbox_execution": execution})


def test_versioned_launch_requires_explicit_execution_and_rejects_unknown_keys():
    with pytest.raises(ValidationError):
        CreateSandboxV2Request.model_validate(BASE)
    with pytest.raises(ValidationError):
        CreateSandboxV2Request.model_validate({**BASE, "sandbox_execution": DOCKER, "docker": True})
    assert (
        CreateSandboxV2Request.model_validate(
            {**BASE, "sandbox_execution": DOCKER}
        ).sandbox_execution.profile
        == "docker-v1"
    )
    with pytest.raises(ValidationError):
        CreateSandboxRequest.model_validate({**BASE, "sandbox_execution": DOCKER})


@pytest.mark.parametrize("value", [None, "true", 1, False])
def test_conflicting_or_malformed_settings_never_downgrade_docker(value):
    with pytest.raises(ValueError):
        resolve_execution({"sandbox_execution": DOCKER}, {"dockerEnabled": value})


def test_legacy_restore_must_not_silently_overwrite_nested_docker_intent():
    body = {
        "snapshot_image_id": "im-snapshot",
        "control_plane_url": "https://cp.test",
        "sandbox_auth_token": "token",
        "session_config": {"session_id": "s1", "sandbox_execution": DOCKER},
    }
    with pytest.raises(ValidationError):
        RestoreSandboxRequest.model_validate(body)
    assert (
        RestoreSandboxV2Request.model_validate(
            {**body, "sandbox_execution": DOCKER}
        ).sandbox_execution.profile
        == "docker-v1"
    )

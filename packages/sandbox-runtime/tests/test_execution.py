import pytest
from pydantic import ValidationError

from sandbox_runtime.execution import (
    DefaultSandboxExecution,
    DockerSandboxExecution,
    parse_sandbox_execution,
)


@pytest.mark.parametrize(
    ("value", "expected_type"),
    [
        ({"profile": "default"}, DefaultSandboxExecution),
        (
            {
                "profile": "docker-v1",
                "provider": "modal",
                "cpuCores": 2.0,
                "memoryMib": 4096,
            },
            DockerSandboxExecution,
        ),
    ],
)
def test_parse_sandbox_execution_returns_typed_profile(value, expected_type):
    assert isinstance(parse_sandbox_execution(value), expected_type)


@pytest.mark.parametrize(
    "value",
    [
        {"profile": "unknown"},
        {
            "profile": "docker-v1",
            "provider": "modal",
            "cpuCores": 0,
            "memoryMib": 4096,
        },
        {"profile": "default", "provider": "modal"},
    ],
)
def test_parse_sandbox_execution_rejects_invalid_profiles(value):
    with pytest.raises(ValidationError):
        parse_sandbox_execution(value)

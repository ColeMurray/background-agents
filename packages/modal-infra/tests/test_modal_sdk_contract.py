"""Guard the test helpers against silently accepting invalid protobuf arguments."""

from unittest.mock import Mock

import modal
import pytest

from src.sandbox.launch_policy import (
    MAX_RESOURCE_UINT32,
    InvalidDockerSettingsError,
    launch_kwargs,
    parse_launch,
)
from tests.modal_sdk_contract import (
    sandbox_create_request,
    sandbox_exec_request,
    snapshot_filesystem_request,
)


@pytest.mark.parametrize(
    "build_request, args, kwargs",
    [
        (sandbox_exec_request, ("python",), {"timeout": 165.0}),
        (sandbox_create_request, ("python",), {"timeout": 1800.0}),
        (sandbox_create_request, ("python",), {"timeout": 1800, "idle_timeout": 30.0}),
    ],
    ids=["exec", "create", "create-idle"],
)
def test_integer_timeout_fields_reject_floats(build_request, args, kwargs):
    with pytest.raises(TypeError, match="'float' object cannot be interpreted as an integer"):
        build_request(*args, **kwargs)


@pytest.mark.parametrize(
    "build_request, sdk_method, kwargs, unexpected",
    [
        (sandbox_exec_request, "exec", {"timeuot": 30}, "timeuot"),
        (
            sandbox_create_request,
            "create",
            {"timeout": 30, "encrypted_port": [8080]},
            "encrypted_port",
        ),
    ],
    ids=["exec", "create"],
)
def test_request_rejects_unknown_sdk_keywords(
    monkeypatch, build_request, sdk_method, kwargs, unexpected
):
    monkeypatch.setattr(modal.Sandbox, sdk_method, Mock())
    with pytest.raises(TypeError, match=f"unexpected keyword argument '{unexpected}'"):
        build_request("python", **kwargs)


def test_exec_accepts_unmodeled_sdk_keywords():
    request = sandbox_exec_request("python", timeout=30, text=False)
    assert request.timeout_secs == 30


def test_exec_serializes_recorded_arguments_without_coercion():
    request = sandbox_exec_request("python", "-m", "module", timeout=165)
    assert list(request.command_args) == ["python", "-m", "module"]
    assert request.timeout_secs == 165


@pytest.mark.parametrize(
    "cpu, memory, expected_cpu, expected_cpu_max, expected_memory, expected_memory_max",
    [
        (None, None, 0, 0, 0, 0),
        (0.5, 2048, 500, 0, 2048, 0),
        ((0.5, 1.5), (2048, 4096), 500, 1500, 2048, 4096),
    ],
    ids=["defaults", "scalar", "request-and-limit"],
)
def test_create_uses_sdk_resource_conversion(
    cpu, memory, expected_cpu, expected_cpu_max, expected_memory, expected_memory_max
):
    request = sandbox_create_request(
        "python",
        timeout=1800,
        idle_timeout=30,
        cpu=cpu,
        memory=memory,
        workdir="/workspace",
        encrypted_ports=[8080],
        experimental_options={"vm_runtime": True},
        name="test-allocation",
        tags={"kind": "test"},
    )
    definition = request.definition
    assert list(definition.entrypoint_args) == ["python"]
    assert definition.timeout_secs == 1800
    assert definition.idle_timeout_secs == 30
    assert definition.workdir == "/workspace"
    assert definition.resources.milli_cpu == expected_cpu
    assert definition.resources.milli_cpu_max == expected_cpu_max
    assert definition.resources.memory_mb == expected_memory
    assert definition.resources.memory_mb_max == expected_memory_max
    assert definition.open_ports.ports[0].port == 8080
    assert not definition.open_ports.ports[0].unencrypted
    assert definition.experimental_options == {"vm_runtime": True}
    assert definition.name == "test-allocation"
    assert [(tag.tag_name, tag.tag_value) for tag in request.tags] == [("kind", "test")]


@pytest.mark.parametrize("backend", ["modal", "modal-vm"])
@pytest.mark.parametrize(
    "settings",
    [
        {"cpuCores": 0.0001, "cpuLimitCores": 0.0009},
        {"cpuLimitCores": 1e308},
        {"cpuCores": 10**400},
        {"cpuLimitCores": (MAX_RESOURCE_UINT32 + 1) / 1000},
        {"memoryMib": MAX_RESOURCE_UINT32 + 1},
        {"memoryLimitMib": MAX_RESOURCE_UINT32 + 1},
    ],
)
def test_launch_rejects_resources_outside_sdk_wire_domain(backend, settings):
    with pytest.raises(InvalidDockerSettingsError):
        parse_launch(backend, settings)


@pytest.mark.parametrize("backend", ["modal", "modal-vm"])
@pytest.mark.parametrize(
    "cpu_millicores, memory_mib", [(1, 1), (MAX_RESOURCE_UINT32, MAX_RESOURCE_UINT32)]
)
def test_launch_domain_boundaries_serialize_with_real_sdk(backend, cpu_millicores, memory_mib):
    settings = {
        "cpuCores": cpu_millicores / 1000,
        "cpuLimitCores": cpu_millicores / 1000,
        "memoryMib": memory_mib,
        "memoryLimitMib": memory_mib,
    }
    request = sandbox_create_request(
        "python", timeout=30, **launch_kwargs(parse_launch(backend, settings))
    )
    resources = request.definition.resources
    assert resources.milli_cpu == resources.milli_cpu_max == cpu_millicores
    assert resources.memory_mb == resources.memory_mb_max == memory_mib


@pytest.mark.parametrize("timeout", [55, 55.0, 55.5])
def test_snapshot_accepts_float_timeout_without_truncation(timeout):
    request = snapshot_filesystem_request(timeout=timeout)
    assert request.timeout == timeout


def test_snapshot_checks_router_timeout_conversion():
    with pytest.raises(TypeError, match=r"float\(\) argument must be"):
        snapshot_filesystem_request(timeout=None)

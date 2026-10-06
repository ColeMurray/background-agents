"""Provider-local mapping from backend identity and resources to launch mechanics."""

import re
from pathlib import Path

import pytest

from sandbox_runtime.constants import DOCKER_ENABLED_ENV_VAR
from src.images import base
from src.sandbox.launch_policy import (
    MODAL_DEFAULT_CPU_CORES,
    MODAL_DEFAULT_MEMORY_MIB,
    VM_DEFAULT_CPU_CORES,
    VM_DEFAULT_CPU_LIMIT_CORES,
    VM_DEFAULT_MEMORY_LIMIT_MIB,
    VM_DEFAULT_MEMORY_MIB,
    DockerImageUnavailableError,
    InvalidDockerSettingsError,
    ModalLaunch,
    docker_allocation_name,
    docker_allocation_tags,
    docker_base_image,
    docker_runtime_env,
    launch_kwargs,
    parse_launch,
    parse_pending_vm_reference,
)
from src.sandbox.vm_recovery import VMServiceLaunch, parse_vm_service_launch


def test_resource_defaults_match_shared_provider_validation():
    shared = Path(__file__).parents[2] / "shared/src/types/integrations.ts"
    source = shared.read_text()
    for name, expected in {
        "DEFAULT_MODAL_CPU_CORES": MODAL_DEFAULT_CPU_CORES,
        "DEFAULT_MODAL_MEMORY_MIB": MODAL_DEFAULT_MEMORY_MIB,
        "DEFAULT_MODAL_VM_CPU_CORES": VM_DEFAULT_CPU_CORES,
        "DEFAULT_MODAL_VM_MEMORY_MIB": VM_DEFAULT_MEMORY_MIB,
        "DEFAULT_MODAL_VM_CPU_LIMIT_CORES": VM_DEFAULT_CPU_LIMIT_CORES,
        "DEFAULT_MODAL_VM_MEMORY_LIMIT_MIB": VM_DEFAULT_MEMORY_LIMIT_MIB,
    }.items():
        match = re.search(rf"export const {name} = ([\d.]+);", source)
        assert match is not None, name
        assert float(match[1]) == expected, name


@pytest.mark.parametrize("settings", [None, {}])
def test_standard_defaults_preserve_existing_launch(settings):
    launch = parse_launch("modal", settings)

    assert launch == ModalLaunch(backend="modal")
    assert launch_kwargs(launch) == {}
    assert docker_runtime_env(launch) == {DOCKER_ENABLED_ENV_VAR: "false"}


def test_launch_policy_maps_vm_backend_and_resources():
    launch = parse_launch("modal-vm", {"cpuCores": 2, "memoryMib": 4096})

    assert launch == ModalLaunch(
        backend="modal-vm",
        cpu_cores=2.0,
        memory_mib=4096,
        cpu_limit_cores=2,
        memory_limit_mib=4096,
    )
    assert launch_kwargs(launch) == {
        "experimental_options": {"vm_runtime": True},
        "cpu": (2.0, 2.0),
        "memory": (4096, 4096),
    }
    assert docker_runtime_env(launch) == {DOCKER_ENABLED_ENV_VAR: "true"}


@pytest.mark.parametrize(
    "settings",
    [
        {"dockerEnabled": "true"},
        {"dockerEnabled": 1},
        {"dockerEnabled": None},
        {"dockerEnabled": True},
        {"cpuCores": -1},
        {"cpuCores": 0, "memoryMib": 4096},
        {"cpuCores": True, "memoryMib": 4096},
        {"cpuCores": 2, "memoryMib": "4096"},
        {"cpuCores": 2, "memoryMib": 4096.5},
        {"cpuCores": float("inf"), "memoryMib": 4096},
    ],
)
def test_malformed_resources_or_removed_settings_are_rejected(settings):
    with pytest.raises(InvalidDockerSettingsError):
        parse_launch("modal-vm", settings)


def test_docker_base_image_requires_provisioning(monkeypatch):
    monkeypatch.setattr(base, "docker_image", None)
    with pytest.raises(DockerImageUnavailableError):
        docker_base_image()

    sentinel = object()
    monkeypatch.setattr(base, "docker_image", sentinel)
    assert docker_base_image() is sentinel


def test_allocation_name_is_stable_per_session_and_modal_safe():
    name = docker_allocation_name("session/with:odd chars")
    assert name == docker_allocation_name("session/with:odd chars")
    assert name != docker_allocation_name("other-session")
    assert len(name) <= 64
    assert re.fullmatch(r"[a-zA-Z0-9-_.]+", name)
    assert not re.fullmatch(r"ap-[a-zA-Z0-9]{22}", name)


def test_allocation_tags_bind_session_generation_and_backend():
    tags = docker_allocation_tags("session-1", "sandbox-1")

    assert tags["openinspect_kind"] == "session"
    assert tags["openinspect_backend"] == "modal-vm"
    assert tags != docker_allocation_tags("session-1", "sandbox-2")
    for value in tags.values():
        assert re.fullmatch(r"[a-zA-Z0-9._-]{1,63}", value)


def test_vm_launch_metadata_round_trips_at_max_extra_port_count():
    launch = VMServiceLaunch(True, False, True, 9000, 6080, 7680, list(range(60000, 60010)))
    tags = launch.tags()

    assert parse_vm_service_launch(tags) == launch
    for value in tags.values():
        assert re.fullmatch(r"[a-zA-Z0-9._-]{1,63}", value)


def test_pending_vm_reference_uses_shared_two_part_wire_format():
    reference = 'modal-vm-session:["session-1","sandbox-1"]'
    assert parse_pending_vm_reference(reference) == ("session-1", "sandbox-1")


@pytest.mark.parametrize(
    "reference",
    [
        "sb-1",
        "modal-vm-session:not-json",
        'modal-vm-session:["session-1"]',
        'modal-vm-session:["session-1","sandbox-1","extra"]',
        'modal-vm-session:["", "sandbox-1"]',
        'modal-vm-session:["session-1", 2]',
        'modal-vm-session:{"sessionId":"session-1","sandboxId":"sandbox-1"}',
    ],
)
def test_pending_vm_reference_rejects_malformed_values(reference):
    assert parse_pending_vm_reference(reference) is None


@pytest.mark.parametrize(
    "settings",
    [
        None,
        {},
        {"cpuCores": None, "memoryMib": None},
        {"cpuLimitCores": None, "memoryLimitMib": None},
    ],
)
def test_vm_owns_defaults_for_absent_or_null_resources(settings):
    assert launch_kwargs(parse_launch("modal-vm", settings)) == {
        "cpu": (0.5, 2),
        "memory": (2048, 4096),
        "experimental_options": {"vm_runtime": True},
    }


@pytest.mark.parametrize(
    "settings", [{"memoryMib": True}, {"memoryMib": 0}, {"cpuCores": float("nan")}]
)
def test_both_backends_validate_explicit_resources(settings):
    for backend in ("modal", "modal-vm"):
        with pytest.raises(InvalidDockerSettingsError):
            parse_launch(backend, settings)


@pytest.mark.parametrize("backend", ["modal", "modal-vm"])
def test_explicit_burst_limits(backend):
    kwargs = launch_kwargs(
        parse_launch(
            backend,
            {
                "cpuCores": 0.5,
                "cpuLimitCores": 4,
                "memoryMib": 2048,
                "memoryLimitMib": 8192,
            },
        )
    )
    assert kwargs["cpu"] == (0.5, 4)
    assert kwargs["memory"] == (2048, 8192)


def test_vm_default_limits_do_not_constrain_larger_requests():
    kwargs = launch_kwargs(parse_launch("modal-vm", {"cpuCores": 8, "memoryMib": 16384}))
    assert kwargs["cpu"] == (8, 8)
    assert kwargs["memory"] == (16384, 16384)


def test_standard_limit_only_uses_provider_default_requests():
    kwargs = launch_kwargs(parse_launch("modal", {"cpuLimitCores": 2, "memoryLimitMib": 4096}))
    assert kwargs == {"cpu": (0.125, 2), "memory": (128, 4096)}


@pytest.mark.parametrize("backend", ["modal", "modal-vm"])
@pytest.mark.parametrize(
    "settings",
    [
        {"cpuLimitCores": True},
        {"cpuLimitCores": 0},
        {"cpuLimitCores": float("nan")},
        {"memoryLimitMib": True},
        {"memoryLimitMib": 0},
        {"memoryLimitMib": 1024.5},
        {"cpuCores": 2, "cpuLimitCores": 1},
        {"memoryMib": 4096, "memoryLimitMib": 2048},
    ],
)
def test_invalid_limits_are_rejected(backend, settings):
    with pytest.raises(InvalidDockerSettingsError):
        parse_launch(backend, settings)


@pytest.mark.parametrize("settings", [{"cpuLimitCores": 0.25}, {"memoryLimitMib": 1024}])
def test_vm_limits_cannot_be_below_default_requests(settings):
    with pytest.raises(InvalidDockerSettingsError):
        parse_launch("modal-vm", settings)

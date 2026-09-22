"""Provider-local mapping from backend identity and resources to launch mechanics."""

import re

import pytest

from sandbox_runtime.constants import DOCKER_ENABLED_ENV_VAR
from src.images import base
from src.sandbox.launch_policy import (
    DockerImageUnavailableError,
    InvalidDockerSettingsError,
    ModalLaunch,
    docker_allocation_name,
    docker_allocation_tags,
    docker_base_image,
    docker_runtime_env,
    launch_kwargs,
    parse_launch,
)


@pytest.mark.parametrize("settings", [None, {}])
def test_standard_defaults_preserve_existing_launch(settings):
    launch = parse_launch("modal", settings)

    assert launch == ModalLaunch(backend="modal")
    assert launch_kwargs(launch) == {}
    assert docker_runtime_env(launch) == {DOCKER_ENABLED_ENV_VAR: "false"}


def test_launch_policy_maps_vm_backend_and_resources():
    launch = parse_launch("modal-vm", {"cpuCores": 2, "memoryMib": 4096})

    assert launch == ModalLaunch(backend="modal-vm", cpu_cores=2.0, memory_mib=4096)
    assert launch_kwargs(launch) == {
        "experimental_options": {"vm_runtime": True},
        "cpu": 2.0,
        "memory": 4096,
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


def test_allocation_name_is_deterministic_per_generation_and_modal_safe():
    name = docker_allocation_name("session/with:odd chars", "sandbox-acme-repo-1700000000000")

    assert name == docker_allocation_name(
        "session/with:odd chars", "sandbox-acme-repo-1700000000000"
    )
    assert name != docker_allocation_name(
        "session/with:odd chars", "sandbox-acme-repo-1700000000001"
    )
    assert name != docker_allocation_name("other-session", "sandbox-acme-repo-1700000000000")
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


@pytest.mark.parametrize("settings", [None, {}, {"cpuCores": None, "memoryMib": None}])
def test_vm_owns_defaults_for_absent_or_null_resources(settings):
    assert launch_kwargs(parse_launch("modal-vm", settings)) == {
        "cpu": 2,
        "memory": 4096,
        "experimental_options": {"vm_runtime": True},
    }


@pytest.mark.parametrize(
    "settings", [{"memoryMib": True}, {"memoryMib": 0}, {"cpuCores": float("nan")}]
)
def test_both_backends_validate_explicit_resources(settings):
    for backend in ("modal", "modal-vm"):
        with pytest.raises(InvalidDockerSettingsError):
            parse_launch(backend, settings)

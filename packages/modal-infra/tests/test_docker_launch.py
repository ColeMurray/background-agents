"""The Modal-local mapping from a frozen Docker choice to VM launch mechanics."""

import re

import pytest

from sandbox_runtime.constants import DOCKER_ENABLED_ENV_VAR
from src.sandbox import docker_launch
from src.sandbox.docker_launch import (
    DockerImageUnavailableError,
    DockerLaunch,
    InvalidDockerSettingsError,
    docker_allocation_name,
    docker_allocation_tags,
    docker_base_image,
    docker_launch_kwargs,
    docker_runtime_env,
    parse_docker_launch,
)


@pytest.mark.parametrize("settings", [None, {}, {"dockerEnabled": False}, {"cpuCores": 2}])
def test_absent_or_false_selects_the_default_launch(settings):
    launch = parse_docker_launch(settings)

    assert launch == DockerLaunch(enabled=False)
    assert docker_launch_kwargs(launch) == {}
    assert docker_runtime_env(launch) == {DOCKER_ENABLED_ENV_VAR: "false"}


def test_docker_launch_maps_to_vm_runtime_with_frozen_resources():
    launch = parse_docker_launch({"dockerEnabled": True, "cpuCores": 2, "memoryMib": 4096})

    assert launch == DockerLaunch(enabled=True, cpu_cores=2.0, memory_mib=4096)
    assert docker_launch_kwargs(launch) == {
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
        {"dockerEnabled": True, "cpuCores": 2},
        {"dockerEnabled": True, "cpuCores": 0, "memoryMib": 4096},
        {"dockerEnabled": True, "cpuCores": True, "memoryMib": 4096},
        {"dockerEnabled": True, "cpuCores": 2, "memoryMib": "4096"},
        {"dockerEnabled": True, "cpuCores": 2, "memoryMib": 4096.5},
        {"dockerEnabled": True, "cpuCores": float("inf"), "memoryMib": 4096},
    ],
)
def test_malformed_docker_settings_are_rejected_rather_than_defaulted(settings):
    with pytest.raises(InvalidDockerSettingsError):
        parse_docker_launch(settings)


def test_docker_base_image_requires_a_provisioned_variant(monkeypatch):
    monkeypatch.setattr(docker_launch, "docker_image", None)
    with pytest.raises(DockerImageUnavailableError):
        docker_base_image()

    sentinel = object()
    monkeypatch.setattr(docker_launch, "docker_image", sentinel)
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


def test_allocation_tags_bind_session_generation_and_variant():
    tags = docker_allocation_tags("session-1", "sandbox-1")

    assert tags["openinspect_kind"] == "session"
    assert tags["openinspect_artifact_variant"] == "modal-docker-v1"
    assert tags != docker_allocation_tags("session-1", "sandbox-2")
    for value in tags.values():
        assert re.fullmatch(r"[a-zA-Z0-9._-]{1,63}", value)

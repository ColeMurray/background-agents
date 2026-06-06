"""Unit tests for Docker launch settings and deploy-policy injection.

These exercise the value objects directly — no os.environ monkeypatching —
proving DockerLaunchSettings.from_profile is pure once the deploy policy is
injected.
"""

from src.sandbox.launch_options import RuntimeLaunchOptions
from src.sandbox.settings import (
    DockerDeployPolicy,
    DockerLaunchSettings,
    SandboxRuntimeSettings,
)


def test_from_profile_default_profile_is_disabled():
    settings = DockerLaunchSettings.from_profile("default")
    assert settings.enabled is False
    assert settings.cpu is None
    assert settings.memory_mb is None


def test_from_profile_docker_without_policy_has_no_resource_overrides():
    settings = DockerLaunchSettings.from_profile("docker")
    assert settings.enabled is True
    assert settings.cpu is None
    assert settings.memory_mb is None


def test_from_profile_docker_applies_injected_policy():
    policy = DockerDeployPolicy(cpu=2.5, memory_mb=6144)
    settings = DockerLaunchSettings.from_profile("docker", policy)
    assert settings.enabled is True
    assert settings.cpu == 2.5
    assert settings.memory_mb == 6144


def test_from_profile_default_ignores_policy():
    policy = DockerDeployPolicy(cpu=2.5, memory_mb=6144)
    settings = DockerLaunchSettings.from_profile("default", policy)
    assert settings.enabled is False
    assert settings.cpu is None
    assert settings.memory_mb is None


def test_deploy_policy_from_env_reads_overrides(monkeypatch):
    monkeypatch.setenv("MODAL_DOCKER_SANDBOX_CPU", "1.5")
    monkeypatch.setenv("MODAL_DOCKER_SANDBOX_MEMORY_MB", "4096")
    policy = DockerDeployPolicy.from_env()
    assert policy.cpu == 1.5
    assert policy.memory_mb == 4096


def test_deploy_policy_from_env_defaults_to_none(monkeypatch):
    monkeypatch.delenv("MODAL_DOCKER_SANDBOX_CPU", raising=False)
    monkeypatch.delenv("MODAL_DOCKER_SANDBOX_MEMORY_MB", raising=False)
    policy = DockerDeployPolicy.from_env()
    assert policy.cpu is None
    assert policy.memory_mb is None


def test_runtime_launch_options_threads_policy_into_docker_kwargs():
    policy = DockerDeployPolicy(cpu=3.0, memory_mb=8192)
    options = RuntimeLaunchOptions.for_session(
        SandboxRuntimeSettings.default(),
        code_server_enabled=False,
        image_profile="docker",
        docker_policy=policy,
    )
    kwargs = options.docker.modal_create_kwargs()
    assert kwargs["cpu"] == 3.0
    assert kwargs["memory"] == 8192
    assert kwargs["experimental_options"] == {"enable_docker": True}

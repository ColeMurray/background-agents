"""The only mapping from logical execution profiles to Modal VM mechanics."""

from typing import Any

from sandbox_runtime.execution import (
    DefaultSandboxExecution,
    DockerSandboxExecution,
    parse_sandbox_execution,
)


def resolve_execution(
    session_config: dict[str, Any], settings: dict[str, Any] | None = None
) -> DefaultSandboxExecution | DockerSandboxExecution:
    execution = parse_sandbox_execution(
        session_config.get("sandbox_execution", {"profile": "default"})
    )
    docker_enabled = (settings or {}).get("dockerEnabled")
    if "dockerEnabled" in (settings or {}) and (
        not isinstance(docker_enabled, bool) or docker_enabled != (execution.profile == "docker-v1")
    ):
        raise ValueError("Sandbox execution conflicts with dockerEnabled")
    return execution


def vm_create_kwargs(execution: DefaultSandboxExecution | DockerSandboxExecution) -> dict[str, Any]:
    if isinstance(execution, DockerSandboxExecution):
        return {
            "experimental_options": {"vm_runtime": True},
            "cpu": execution.cpuCores,
            "memory": execution.memoryMib,
        }
    return {}


def select_base_image(
    execution: DefaultSandboxExecution | DockerSandboxExecution, default_image: Any
) -> Any:
    if execution.profile == "default":
        return default_image
    from ..images.base import docker_image

    if docker_image is None:
        raise RuntimeError("Verified Docker sandbox image is unavailable")
    return docker_image

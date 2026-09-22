"""Modal compute offerings: launch resources, runtime options, and allocation identity."""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

from sandbox_runtime.constants import DOCKER_ENABLED_ENV_VAR

if TYPE_CHECKING:
    import modal

ALLOCATION_NAME_PREFIX = "oi-"
ALLOCATION_KIND_TAG = "openinspect_kind"
ALLOCATION_SESSION_TAG = "openinspect_session_id"
ALLOCATION_SANDBOX_TAG = "openinspect_sandbox_id"
ALLOCATION_BACKEND_TAG = "openinspect_backend"
ModalBackend = Literal["modal", "modal-vm"]
VM_DEFAULT_CPU_CORES = 2
VM_DEFAULT_MEMORY_MIB = 4096


class InvalidDockerSettingsError(ValueError):
    """The Docker-sensitive settings are malformed or contradictory."""


class DockerImageUnavailableError(RuntimeError):
    """The deployment has no verified Docker-capable sandbox image."""


@dataclass(frozen=True)
class ModalLaunch:
    backend: ModalBackend
    cpu_cores: float | None = None
    memory_mib: int | None = None

    @property
    def enabled(self) -> bool:
        return self.backend == "modal-vm"


def parse_launch(backend: ModalBackend, settings: dict[str, Any] | None) -> ModalLaunch:
    """Select an offering independently of generic resource settings."""
    if backend not in ("modal", "modal-vm"):
        raise InvalidDockerSettingsError("Unknown Modal sandbox backend")
    settings = settings or {}
    if "dockerEnabled" in settings:
        raise InvalidDockerSettingsError(
            "dockerEnabled was removed; select SANDBOX_PROVIDER=modal-vm"
        )
    cpu_cores = settings.get("cpuCores")
    memory_mib = settings.get("memoryMib")
    if backend == "modal-vm":
        cpu_cores = VM_DEFAULT_CPU_CORES if cpu_cores is None else cpu_cores
        memory_mib = VM_DEFAULT_MEMORY_MIB if memory_mib is None else memory_mib
    if cpu_cores is not None and (
        isinstance(cpu_cores, bool)
        or not isinstance(cpu_cores, int | float)
        or not math.isfinite(cpu_cores)
        or cpu_cores <= 0
    ):
        raise InvalidDockerSettingsError("cpuCores must be positive and finite")
    if memory_mib is not None and (
        isinstance(memory_mib, bool) or not isinstance(memory_mib, int) or memory_mib <= 0
    ):
        raise InvalidDockerSettingsError("memoryMib must be a positive integer")
    return ModalLaunch(backend=backend, cpu_cores=cpu_cores, memory_mib=memory_mib)


def docker_base_image() -> modal.Image:
    """The verified Docker-capable base image; never the default image."""
    from ..images.base import docker_image

    if docker_image is None:
        raise DockerImageUnavailableError("Docker sandbox image is not provisioned")
    return docker_image


def launch_kwargs(launch: ModalLaunch) -> dict[str, Any]:
    """One mapping for outer allocation resources and VM runtime selection."""
    result: dict[str, Any] = {}
    if launch.enabled:
        result["experimental_options"] = {"vm_runtime": True}
    if launch.cpu_cores is not None:
        result["cpu"] = launch.cpu_cores
    if launch.memory_mib is not None:
        result["memory"] = launch.memory_mib
    return result


def docker_runtime_env(launch: ModalLaunch) -> dict[str, str]:
    """The trusted runtime signal, always set explicitly by the provider."""
    return {DOCKER_ENABLED_ENV_VAR: "true" if launch.enabled else "false"}


def _identity_digest(*parts: str) -> str:
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()


def docker_allocation_name(session_id: str) -> str:
    """One provider-enforced running allocation slot per session.

    Generations retain distinct ownership tags, not distinct names. A missing
    lookup cannot authorize overlapping creates: Modal rejects a conflicting
    name until the previous sandbox has completely stopped.
    """
    return ALLOCATION_NAME_PREFIX + _identity_digest("modal-vm", session_id)[:40]


def docker_allocation_tags(session_id: str, sandbox_id: str) -> dict[str, str]:
    """Ownership tags a found allocation must match exactly before adoption or retirement."""
    return {
        ALLOCATION_KIND_TAG: "session",
        ALLOCATION_SESSION_TAG: _identity_digest(session_id)[:48],
        ALLOCATION_SANDBOX_TAG: _identity_digest(sandbox_id)[:48],
        ALLOCATION_BACKEND_TAG: "modal-vm",
    }

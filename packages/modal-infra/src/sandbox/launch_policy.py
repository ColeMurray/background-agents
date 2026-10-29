"""Modal compute offerings: launch resources, runtime options, and allocation identity."""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

from sandbox_runtime.constants import DOCKER_ENABLED_ENV_VAR

if TYPE_CHECKING:
    import modal

ALLOCATION_NAME_PREFIX = "oi-"
PENDING_VM_REFERENCE_PREFIX = "modal-vm-session:"
ALLOCATION_KIND_TAG = "openinspect_kind"
ALLOCATION_SESSION_TAG = "openinspect_session_id"
ALLOCATION_SANDBOX_TAG = "openinspect_sandbox_id"
ALLOCATION_BACKEND_TAG = "openinspect_backend"
ModalBackend = Literal["modal", "modal-vm"]
VM_DEFAULT_CPU_CORES = 0.5
VM_DEFAULT_MEMORY_MIB = 2048
VM_DEFAULT_CPU_LIMIT_CORES = 2
VM_DEFAULT_MEMORY_LIMIT_MIB = 4096
MODAL_DEFAULT_CPU_CORES = 0.125
MODAL_DEFAULT_MEMORY_MIB = 128
MAX_RESOURCE_UINT32 = (1 << 32) - 1


class InvalidDockerSettingsError(ValueError):
    """The Docker-sensitive settings are malformed or contradictory."""


class DockerImageUnavailableError(RuntimeError):
    """The deployment has no verified Docker-capable sandbox image."""


@dataclass(frozen=True)
class ModalLaunch:
    backend: ModalBackend
    cpu_cores: float | None = None
    memory_mib: int | None = None
    cpu_limit_cores: float | None = None
    memory_limit_mib: int | None = None

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
    cpu_limit_cores = settings.get("cpuLimitCores")
    memory_limit_mib = settings.get("memoryLimitMib")
    if backend == "modal-vm":
        cpu_cores = VM_DEFAULT_CPU_CORES if cpu_cores is None else cpu_cores
        memory_mib = VM_DEFAULT_MEMORY_MIB if memory_mib is None else memory_mib
    else:
        if cpu_limit_cores is not None and cpu_cores is None:
            cpu_cores = MODAL_DEFAULT_CPU_CORES
        if memory_limit_mib is not None and memory_mib is None:
            memory_mib = MODAL_DEFAULT_MEMORY_MIB
    for name, value in (("cpuCores", cpu_cores), ("cpuLimitCores", cpu_limit_cores)):
        if value is not None and (
            isinstance(value, bool)
            or not isinstance(value, int | float)
            or not 0 < value <= MAX_RESOURCE_UINT32 / 1000
            or not math.isfinite(value * 1000)
            or int(value * 1000) == 0
        ):
            raise InvalidDockerSettingsError(
                f"{name} must serialize to a positive uint32 millicore value"
            )
    for name, value in (("memoryMib", memory_mib), ("memoryLimitMib", memory_limit_mib)):
        if value is not None and (
            isinstance(value, bool)
            or not isinstance(value, int)
            or not 0 < value <= MAX_RESOURCE_UINT32
        ):
            raise InvalidDockerSettingsError(f"{name} must be a positive uint32 integer")
    if backend == "modal-vm":
        if cpu_limit_cores is None:
            cpu_limit_cores = max(VM_DEFAULT_CPU_LIMIT_CORES, cpu_cores)
        if memory_limit_mib is None:
            memory_limit_mib = max(VM_DEFAULT_MEMORY_LIMIT_MIB, memory_mib)
    for name, request, limit in (
        ("cpuLimitCores", cpu_cores, cpu_limit_cores),
        ("memoryLimitMib", memory_mib, memory_limit_mib),
    ):
        if request is not None and limit is not None and limit < request:
            raise InvalidDockerSettingsError(f"{name} must be at least its resource request")
    return ModalLaunch(
        backend=backend,
        cpu_cores=cpu_cores,
        memory_mib=memory_mib,
        cpu_limit_cores=cpu_limit_cores,
        memory_limit_mib=memory_limit_mib,
    )


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
        result["cpu"] = (
            (launch.cpu_cores, launch.cpu_limit_cores)
            if launch.cpu_limit_cores is not None
            else launch.cpu_cores
        )
    if launch.memory_mib is not None:
        result["memory"] = (
            (launch.memory_mib, launch.memory_limit_mib)
            if launch.memory_limit_mib is not None
            else launch.memory_mib
        )
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


def parse_pending_vm_reference(value: str) -> tuple[str, str] | None:
    """Parse modal-vm-session:["sessionId","sandboxId"] or return None.

    Session id selects the allocation name; both ids select its ownership tags.
    The reference resolves only while that generation's allocation is running.
    Absence is confirmed only after the launch window, endpoint timeout and margin.
    """
    if not value.startswith(PENDING_VM_REFERENCE_PREFIX):
        return None
    try:
        identity = json.loads(value.removeprefix(PENDING_VM_REFERENCE_PREFIX))
    except ValueError:
        return None
    if (
        not isinstance(identity, list)
        or len(identity) != 2
        or any(not isinstance(part, str) or not part for part in identity)
    ):
        return None
    return identity[0], identity[1]

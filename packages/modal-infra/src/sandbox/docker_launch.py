"""Modal-local mapping from a session's frozen Docker choice to VM launch mechanics.

The control plane freezes `dockerEnabled` (plus CPU and memory) into the
sandbox settings it sends. This module is the only place that turns that
boolean into Modal specifics: the Docker-capable image, the VM runtime option,
the trusted runtime signal, and the deterministic allocation name that keeps a
retried VM create from producing two live sandboxes.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from sandbox_runtime.constants import DOCKER_ENABLED_ENV_VAR

from ..images.base import MODAL_VM_EXPERIMENTAL_OPTIONS, docker_image

if TYPE_CHECKING:
    import modal

ALLOCATION_NAME_PREFIX = "oi-"
ALLOCATION_KIND_TAG = "openinspect_kind"
ALLOCATION_SESSION_TAG = "openinspect_session_id"
ALLOCATION_SANDBOX_TAG = "openinspect_sandbox_id"
ALLOCATION_VARIANT_TAG = "openinspect_artifact_variant"
DOCKER_ARTIFACT_VARIANT = "modal-docker-v1"


class InvalidDockerSettingsError(ValueError):
    """The Docker-sensitive settings are malformed or contradictory."""


class DockerImageUnavailableError(RuntimeError):
    """The deployment has no verified Docker-capable sandbox image."""


@dataclass(frozen=True)
class DockerLaunch:
    enabled: bool
    cpu_cores: float | None = None
    memory_mib: int | None = None


def parse_docker_launch(settings: dict[str, Any] | None) -> DockerLaunch:
    """Strictly read the Docker subset of sandbox settings.

    Ordinary settings keep their lenient handling elsewhere; these fields decide
    which runtime the sandbox boots on, so a malformed value is an error rather
    than a fallback to the default sandbox.
    """
    if not settings:
        return DockerLaunch(enabled=False)
    enabled = settings.get("dockerEnabled", False)
    if not isinstance(enabled, bool):
        raise InvalidDockerSettingsError("dockerEnabled must be a boolean")
    if not enabled:
        return DockerLaunch(enabled=False)
    cpu_cores = settings.get("cpuCores")
    memory_mib = settings.get("memoryMib")
    if (
        isinstance(cpu_cores, bool)
        or not isinstance(cpu_cores, int | float)
        or not math.isfinite(cpu_cores)
        or cpu_cores <= 0
    ):
        raise InvalidDockerSettingsError("Docker sandboxes require a positive cpuCores")
    if isinstance(memory_mib, bool) or not isinstance(memory_mib, int) or memory_mib <= 0:
        raise InvalidDockerSettingsError("Docker sandboxes require a positive integer memoryMib")
    return DockerLaunch(enabled=True, cpu_cores=float(cpu_cores), memory_mib=memory_mib)


def docker_base_image() -> modal.Image:
    """The verified Docker-capable base image; never the default image."""
    if docker_image is None:
        raise DockerImageUnavailableError("Docker sandbox image is not provisioned")
    return docker_image


def docker_launch_kwargs(launch: DockerLaunch) -> dict[str, Any]:
    """Extra `modal.Sandbox.create` kwargs for a Docker launch; empty otherwise.

    Modal sizes VM memory at create time, so the frozen resources are part of
    the launch itself (session and build alike), not an optional reservation.
    """
    if not launch.enabled:
        return {}
    return {
        "experimental_options": dict(MODAL_VM_EXPERIMENTAL_OPTIONS),
        "cpu": launch.cpu_cores,
        "memory": launch.memory_mib,
    }


def docker_runtime_env(launch: DockerLaunch) -> dict[str, str]:
    """The trusted runtime signal, always set explicitly by the provider."""
    return {DOCKER_ENABLED_ENV_VAR: "true" if launch.enabled else "false"}


def _identity_digest(*parts: str) -> str:
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()


def docker_allocation_name(session_id: str, sandbox_id: str) -> str:
    """Deterministic, Modal-safe sandbox name for one control-plane generation.

    `sandbox_id` already embeds the generation timestamp, so the pair names
    exactly one launch attempt. Modal names are limited to 64 chars of
    `[A-Za-z0-9._-]`, which control-plane identifiers do not satisfy directly.
    """
    return ALLOCATION_NAME_PREFIX + _identity_digest(session_id, sandbox_id)[:40]


def docker_allocation_tags(session_id: str, sandbox_id: str) -> dict[str, str]:
    """Ownership tags a found allocation must match exactly before adoption or retirement."""
    return {
        ALLOCATION_KIND_TAG: "session",
        ALLOCATION_SESSION_TAG: _identity_digest(session_id)[:48],
        ALLOCATION_SANDBOX_TAG: _identity_digest(sandbox_id)[:48],
        ALLOCATION_VARIANT_TAG: DOCKER_ARTIFACT_VARIANT,
    }

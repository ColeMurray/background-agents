"""Typed sandbox runtime settings parsed from control-plane payloads."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

from sandbox_runtime.constants import CODE_SERVER_PORT, TTYD_PROXY_PORT

MAX_TUNNEL_PORTS = 10
DOCKER_DATA_ROOT = "/opt/docker-data"
DEFAULT_DOCKER_SANDBOX_CPU = 4.0
DEFAULT_DOCKER_SANDBOX_MEMORY_MB = 8192
DEFAULT_IMAGE_PROFILE = "default"
DOCKER_IMAGE_PROFILE = "docker"
SandboxImageProfile = Literal["default", "docker"]
IMAGE_PROFILES = frozenset({DEFAULT_IMAGE_PROFILE, DOCKER_IMAGE_PROFILE})


def _env_float(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name) or default)
        return value if value > 0 else default
    except (TypeError, ValueError):
        return default


def _env_int(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name) or default)
        return value if value > 0 else default
    except (TypeError, ValueError):
        return default


def validate_tunnel_ports(raw: object) -> tuple[int, ...]:
    """Validate and sanitize tunnel ports: int, 1-65535, capped at MAX_TUNNEL_PORTS."""
    if not isinstance(raw, list | tuple):
        return ()

    ports: list[int] = []
    for port in raw:
        if type(port) is int and 1 <= port <= 65535:
            ports.append(port)
        if len(ports) >= MAX_TUNNEL_PORTS:
            break
    return tuple(ports)


def parse_bool_setting(value: object) -> bool:
    """Only real JSON booleans enable runtime features."""
    return value is True


def parse_sandbox_image_profile(value: object) -> SandboxImageProfile:
    if value is None:
        return DEFAULT_IMAGE_PROFILE
    if value in IMAGE_PROFILES:
        return value
    raise ValueError(f"Invalid sandbox image profile: {value!r}")


@dataclass(frozen=True, slots=True)
class RuntimePortSettings:
    """Modal port exposure derived from user sandbox settings."""

    exposed_ports: tuple[int, ...] = ()
    tunnel_ports: tuple[int, ...] = ()

    @classmethod
    def from_settings(
        cls, settings: SandboxRuntimeSettings, code_server_enabled: bool
    ) -> RuntimePortSettings:
        reserved: set[int] = set()
        exposed: list[int] = []
        if code_server_enabled:
            exposed.append(CODE_SERVER_PORT)
            reserved.add(CODE_SERVER_PORT)
        if settings.terminal_enabled:
            exposed.append(TTYD_PROXY_PORT)
            reserved.add(TTYD_PROXY_PORT)

        tunnel_ports = tuple(p for p in settings.tunnel_ports if p not in reserved)
        exposed.extend(tunnel_ports)
        return cls(exposed_ports=tuple(exposed), tunnel_ports=tunnel_ports)


@dataclass(frozen=True, slots=True)
class DockerLaunchSettings:
    """Docker-specific Modal launch settings after deploy policy is applied."""

    enabled: bool = False
    data_root: str = DOCKER_DATA_ROOT
    cpu: float = DEFAULT_DOCKER_SANDBOX_CPU
    memory_mb: int = DEFAULT_DOCKER_SANDBOX_MEMORY_MB

    @classmethod
    def from_profile(cls, image_profile: SandboxImageProfile) -> DockerLaunchSettings:
        if image_profile != DOCKER_IMAGE_PROFILE:
            return cls()
        return cls(
            enabled=True,
            cpu=_env_float("MODAL_DOCKER_SANDBOX_CPU", DEFAULT_DOCKER_SANDBOX_CPU),
            memory_mb=_env_int("MODAL_DOCKER_SANDBOX_MEMORY_MB", DEFAULT_DOCKER_SANDBOX_MEMORY_MB),
        )

    def env_vars(self) -> dict[str, str]:
        if not self.enabled:
            return {}
        return {
            "OPENINSPECT_DOCKER_ENABLED": "true",
            "DOCKER_DATA_ROOT": self.data_root,
        }

    def modal_create_kwargs(self) -> dict[str, Any]:
        if not self.enabled:
            return {}
        return {
            "experimental_options": {"enable_docker": True},
            "cpu": self.cpu,
            "memory": self.memory_mb,
        }


@dataclass(frozen=True, slots=True)
class SandboxRuntimeSettings:
    """Sandbox settings parsed from a control-plane request."""

    tunnel_ports: tuple[int, ...] = ()
    terminal_enabled: bool = False

    @classmethod
    def default(cls) -> SandboxRuntimeSettings:
        return cls()

    @classmethod
    def from_raw(cls, raw: Mapping[str, Any] | None) -> SandboxRuntimeSettings:
        payload: Mapping[str, Any] = raw if isinstance(raw, Mapping) else {}
        return cls(
            tunnel_ports=validate_tunnel_ports(payload.get("tunnelPorts", [])),
            terminal_enabled=parse_bool_setting(payload.get("terminalEnabled")),
        )

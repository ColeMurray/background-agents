"""Modal launch option planning for sandbox runtime settings."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import modal

from sandbox_runtime.constants import EXPECTED_TUNNEL_PORTS_ENV_VAR

from ..app import app
from ..images.base import base_image, docker_image
from .settings import (
    DOCKER_IMAGE_PROFILE,
    DockerLaunchSettings,
    RuntimePortSettings,
    SandboxImageProfile,
    SandboxRuntimeSettings,
)


@dataclass(frozen=True, slots=True)
class RuntimeLaunchOptions:
    """Modal launch options derived from parsed sandbox runtime settings."""

    image_profile: SandboxImageProfile
    docker: DockerLaunchSettings
    terminal_enabled: bool = False
    exposed_ports: tuple[int, ...] = ()
    tunnel_ports: tuple[int, ...] = ()

    @classmethod
    def for_session(
        cls,
        settings: SandboxRuntimeSettings,
        code_server_enabled: bool,
        image_profile: SandboxImageProfile,
    ) -> RuntimeLaunchOptions:
        ports = RuntimePortSettings.from_settings(settings, code_server_enabled)
        return cls(
            image_profile=image_profile,
            docker=DockerLaunchSettings.from_profile(image_profile),
            terminal_enabled=settings.terminal_enabled,
            exposed_ports=ports.exposed_ports,
            tunnel_ports=ports.tunnel_ports,
        )

    @classmethod
    def for_image_build(cls, image_profile: SandboxImageProfile) -> RuntimeLaunchOptions:
        return cls(
            image_profile=image_profile,
            docker=DockerLaunchSettings.from_profile(image_profile),
        )


def select_base_image(image_profile: SandboxImageProfile) -> modal.Image:
    return docker_image if image_profile == DOCKER_IMAGE_PROFILE else base_image


def select_runtime_image(
    image_profile: SandboxImageProfile,
    *,
    snapshot_id: str | None = None,
    repo_image_id: str | None = None,
) -> tuple[modal.Image, str]:
    if snapshot_id:
        return modal.Image.from_id(snapshot_id), "snapshot"
    if repo_image_id:
        return modal.Image.from_id(repo_image_id), "repo"
    return select_base_image(image_profile), "base"


def build_modal_create_kwargs(
    launch_options: RuntimeLaunchOptions,
    *,
    image: modal.Image,
    secrets: list[Any],
    timeout: int,
    env_vars: dict[str, str],
) -> dict[str, Any]:
    launch_env_vars = dict(env_vars)
    launch_env_vars["OPENINSPECT_SANDBOX_IMAGE_PROFILE"] = launch_options.image_profile
    if launch_options.terminal_enabled:
        launch_env_vars["TERMINAL_ENABLED"] = "true"
    if launch_options.tunnel_ports:
        launch_env_vars[EXPECTED_TUNNEL_PORTS_ENV_VAR] = ",".join(
            str(p) for p in launch_options.tunnel_ports
        )
    launch_env_vars.update(launch_options.docker.env_vars())

    create_kwargs: dict[str, Any] = {
        "image": image,
        "app": app,
        "secrets": secrets,
        "timeout": timeout,
        "workdir": "/workspace",
        "env": launch_env_vars,
    }
    if launch_options.exposed_ports:
        create_kwargs["encrypted_ports"] = list(launch_options.exposed_ports)
    create_kwargs.update(launch_options.docker.modal_create_kwargs())
    return create_kwargs

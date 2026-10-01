"""Translate a session launch into Modal image, environment, and resource arguments."""

import json
import re
import secrets
import time
from dataclasses import dataclass
from typing import Any

import modal

from sandbox_runtime.constants import (
    CODE_SERVER_PORT_ENV_VAR,
    DOCKER_ENABLED_ENV_VAR,
    EXPECTED_TUNNEL_PORTS_ENV_VAR,
    NOVNC_PORT_ENV_VAR,
    SANDBOX_TIMEOUT_ENV_VAR,
    TTYD_PROXY_PORT_ENV_VAR,
    VNC_PASSWORD_ENV_VAR,
    VNC_PASSWORD_MAX_BYTES,
)
from sandbox_runtime.log_config import get_logger
from sandbox_runtime.types import SandboxStatus

from ..app import app
from ..app_config import APP_NAME
from ..images.base import base_image
from .launch_policy import (
    ALLOCATION_SANDBOX_TAG,
    docker_allocation_name,
    docker_allocation_tags,
    docker_base_image,
    docker_runtime_env,
    launch_kwargs,
    parse_launch,
)
from .models import SandboxConfig, SandboxHandle
from .termination import terminate_and_wait
from .tunnels import SandboxTunnels
from .vcs_env import inject_vcs_env_vars
from .vm_recovery import VMAllocationOutcome, VMServiceLaunch, owned_vm_tags_match

_RESERVED_LAUNCH_ENV_VARS = {
    "RESTORED_FROM_SNAPSHOT",
    "FROM_REPO_IMAGE",
    "REPO_IMAGE_SHA",
    "IMAGE_BUILD_MODE",
    "TERMINAL_ENABLED",
    "AGENT_SLACK_NOTIFY_ENABLED",
    "SESSION_CONFIG",
    "CODE_SERVER_PASSWORD",
    CODE_SERVER_PORT_ENV_VAR,
    TTYD_PROXY_PORT_ENV_VAR,
    EXPECTED_TUNNEL_PORTS_ENV_VAR,
    VNC_PASSWORD_ENV_VAR,
    NOVNC_PORT_ENV_VAR,
    DOCKER_ENABLED_ENV_VAR,
}

log = get_logger("manager")
ACCESS_PASSWORD_READ_TIMEOUT_SECONDS = 30


class RepositoryImageUnavailableError(RuntimeError):
    """The selected repository image no longer exists in Modal."""


@dataclass(frozen=True)
class BaseImageSource:
    pass


@dataclass(frozen=True)
class RepositoryImageSource:
    image_id: str
    sha: str | None


@dataclass(frozen=True)
class SnapshotImageSource:
    image_id: str


type SandboxImageSource = BaseImageSource | RepositoryImageSource | SnapshotImageSource


async def _create_sandbox(
    create_kwargs: dict[str, Any], *, repository_image: bool
) -> modal.Sandbox:
    """Only a missing repository image at create time is classified as unavailable."""
    try:
        return await modal.Sandbox.create.aio(
            "python", "-m", "sandbox_runtime.entrypoint", **create_kwargs
        )
    except modal.exception.NotFoundError as e:
        if repository_image:
            raise RepositoryImageUnavailableError("repository image is unavailable") from e
        raise


def _session_identity(session_config: Any) -> str:
    if isinstance(session_config, dict):
        session_id = session_config.get("session_id")
    elif session_config is not None:
        session_id = session_config.session_id
    else:
        session_id = None
    return session_id if isinstance(session_id, str) else ""


@dataclass(frozen=True)
class SandboxLaunchSpec:
    """Canonical launch configuration paired with one image source variant."""

    config: SandboxConfig
    source: SandboxImageSource


class SandboxLauncher:
    """Own the common Modal launch path for base, repository, and snapshot images."""

    @staticmethod
    def _generate_code_server_password() -> str:
        """Generate a random code-server password."""
        return secrets.token_urlsafe(16)

    @staticmethod
    def _generate_vnc_password() -> str:
        """Generate a random VNC password."""
        return secrets.token_urlsafe(VNC_PASSWORD_MAX_BYTES)[:VNC_PASSWORD_MAX_BYTES]

    async def launch(self, spec: SandboxLaunchSpec) -> SandboxHandle:
        """Launch a Modal sandbox from a normalized create or restore specification."""
        config = spec.config
        has_repository = bool(config.repo_owner)
        sandbox_id = config.sandbox_id
        if not sandbox_id:
            sandbox_name = (
                f"{config.repo_owner}-{config.repo_name}" if has_repository else "no-repository"
            )
            sandbox_id = f"sandbox-{sandbox_name}-{int(time.time() * 1000)}"

        docker = parse_launch(config.sandbox_backend, config.settings)
        env_vars = {
            key: value
            for key, value in (config.user_env_vars or {}).items()
            if key not in _RESERVED_LAUNCH_ENV_VARS
        }
        env_vars.update(
            {
                "PYTHONUNBUFFERED": "1",
                "SANDBOX_ID": sandbox_id,
                "CONTROL_PLANE_URL": config.control_plane_url,
                "SANDBOX_AUTH_TOKEN": config.sandbox_auth_token,
                SANDBOX_TIMEOUT_ENV_VAR: str(config.timeout_seconds),
                "REPO_OWNER": config.repo_owner or "",
                "REPO_NAME": config.repo_name or "",
                **docker_runtime_env(docker),
            }
        )

        snapshot_id: str | None = None
        if isinstance(spec.source, BaseImageSource):
            image = docker_base_image() if docker.enabled else base_image
        elif isinstance(spec.source, RepositoryImageSource):
            try:
                image = modal.Image.from_id(spec.source.image_id)
            except modal.exception.NotFoundError as e:
                raise RepositoryImageUnavailableError("repository image is unavailable") from e
            env_vars["FROM_REPO_IMAGE"] = "true"
            env_vars["REPO_IMAGE_SHA"] = spec.source.sha or ""
        else:
            image = modal.Image.from_id(spec.source.image_id)
            env_vars["RESTORED_FROM_SNAPSHOT"] = "true"
            snapshot_id = spec.source.image_id

        if config.session_config is not None:
            env_vars["SESSION_CONFIG"] = (
                json.dumps(config.session_config)
                if isinstance(config.session_config, dict)
                else config.session_config.model_dump_json()
            )

        inject_vcs_env_vars(
            env_vars,
            clone_host=config.clone_host,
            clone_username=config.clone_username,
        )

        code_server_password: str | None = None
        if config.code_server_enabled:
            code_server_password = self._generate_code_server_password()
            env_vars["CODE_SERVER_PASSWORD"] = code_server_password

        vnc_password: str | None = None
        if config.vnc_enabled:
            vnc_password = self._generate_vnc_password()
            env_vars[VNC_PASSWORD_ENV_VAR] = vnc_password

        if config.agent_slack_notify_enabled:
            env_vars["AGENT_SLACK_NOTIFY_ENABLED"] = "true"

        tunnels = SandboxTunnels(
            code_server_enabled=config.code_server_enabled,
            vnc_enabled=config.vnc_enabled,
            settings=config.settings,
        )
        env_vars.update(tunnels.environment)

        # A fresh handle avoids Modal caching the ID of a deleted/recreated secret.
        llm_secrets = modal.Secret.from_name("llm-api-keys")
        await llm_secrets.hydrate.aio()
        create_kwargs: dict[str, Any] = {
            "image": image,
            "app": app,
            "secrets": [llm_secrets],
            "timeout": config.timeout_seconds,
            "workdir": "/workspace",
            "env": env_vars,
            **launch_kwargs(docker),
        }
        if tunnels.exposed_ports:
            create_kwargs["encrypted_ports"] = tunnels.exposed_ports

        repository_image = isinstance(spec.source, RepositoryImageSource)
        if docker.enabled:
            sandbox, adopted = await self._launch_docker_sandbox(
                session_id=_session_identity(config.session_config),
                sandbox_id=sandbox_id,
                create_kwargs=create_kwargs,
                repository_image=repository_image,
                launch_deadline_at_ms=config.launch_deadline_at_ms,
                service_launch=VMServiceLaunch.from_tunnels(tunnels),
            )
            if adopted:
                passwords = await self._read_access_passwords(
                    sandbox,
                    code_server_enabled=config.code_server_enabled,
                    vnc_enabled=config.vnc_enabled,
                )
                code_server_password = passwords.get("CODE_SERVER_PASSWORD")
                vnc_password = passwords.get(VNC_PASSWORD_ENV_VAR)
        else:
            sandbox = await _create_sandbox(create_kwargs, repository_image=repository_image)
        modal_object_id = sandbox.object_id
        urls = await tunnels.resolve(sandbox, sandbox_id)

        return SandboxHandle(
            sandbox_id=sandbox_id,
            modal_sandbox=sandbox,
            status=SandboxStatus.WARMING,
            created_at=time.time(),
            snapshot_id=snapshot_id,
            modal_object_id=modal_object_id,
            code_server_url=urls.code_server_url,
            code_server_password=code_server_password,
            vnc_url=urls.vnc_url,
            vnc_password=vnc_password,
            ttyd_url=urls.ttyd_url,
            tunnel_urls=urls.tunnel_urls,
            sandbox_backend=docker.backend,
        )

    async def _launch_docker_sandbox(
        self,
        *,
        session_id: str,
        sandbox_id: str,
        create_kwargs: dict[str, Any],
        repository_image: bool,
        service_launch: VMServiceLaunch,
        launch_deadline_at_ms: int | None = None,
    ) -> tuple[modal.Sandbox, bool]:
        """Retire superseded session VMs, then create or adopt this generation."""
        name = docker_allocation_name(session_id)
        tags = docker_allocation_tags(session_id, sandbox_id)
        existing, _ = await self._find_or_retire_docker_allocation(name, tags)
        if existing is None:
            for attempt in range(2):
                if (
                    launch_deadline_at_ms is not None
                    and time.time() * 1000 >= launch_deadline_at_ms
                ):
                    raise VMAllocationOutcome("window_closed", "VM launch deadline expired")
                try:
                    sandbox = await _create_sandbox(
                        {**create_kwargs, "name": name, "tags": {**tags, **service_launch.tags()}},
                        repository_image=repository_image,
                    )
                    return sandbox, False
                except modal.exception.AlreadyExistsError as e:
                    existing, retired = await self._find_or_retire_docker_allocation(name, tags)
                    if existing is not None:
                        break
                    if not retired or attempt == 1:
                        raise VMAllocationOutcome(
                            "race_pending", "VM allocation is not yet available"
                        ) from e
        assert existing is not None
        log.info(
            "sandbox.docker_allocation_adopted",
            sandbox_id=sandbox_id,
            modal_object_id=existing.object_id,
        )
        return existing, True

    @staticmethod
    async def _read_access_passwords(
        sandbox: modal.Sandbox, *, code_server_enabled: bool, vnc_enabled: bool
    ) -> dict[str, str]:
        """Recover enabled service credentials from the owned VM launch environment."""
        keys = []
        if code_server_enabled:
            keys.append("CODE_SERVER_PASSWORD")
        if vnc_enabled:
            keys.append(VNC_PASSWORD_ENV_VAR)
        if not keys:
            return {}
        process = await sandbox.exec.aio(
            "python",
            "-I",
            "-c",
            "import json, os, sys; print(json.dumps({k: os.environ.get(k) for k in sys.argv[1:]}))",
            *keys,
            timeout=ACCESS_PASSWORD_READ_TIMEOUT_SECONDS,
        )
        output = await process.stdout.read.aio()
        if await process.wait.aio() != 0:
            raise RuntimeError("Could not recover adopted sandbox access credentials")
        try:
            passwords = json.loads(output)
        except ValueError:
            raise RuntimeError("Could not recover adopted sandbox access credentials") from None
        if not isinstance(passwords, dict) or any(
            not isinstance(passwords.get(key), str) or not passwords[key] for key in keys
        ):
            raise RuntimeError("Could not recover adopted sandbox access credentials")
        return {key: passwords[key] for key in keys}

    @staticmethod
    async def _find_or_retire_docker_allocation(
        name: str, tags: dict[str, str]
    ) -> tuple[modal.Sandbox | None, bool]:
        """Return this generation's VM and whether a superseded session VM was retired."""
        try:
            sandbox = await modal.Sandbox.from_name.aio(APP_NAME, name)
        except modal.exception.NotFoundError:
            return None, False
        actual_tags = await sandbox.get_tags.aio()
        generation = actual_tags.get(ALLOCATION_SANDBOX_TAG)
        if (
            not generation
            or not re.fullmatch(r"[0-9a-f]{48}", generation)
            or not owned_vm_tags_match(actual_tags, {**tags, ALLOCATION_SANDBOX_TAG: generation})
        ):
            raise VMAllocationOutcome(
                "other_generation", "Docker sandbox allocation ownership mismatch"
            )
        if generation == tags[ALLOCATION_SANDBOX_TAG]:
            return sandbox, False
        # The control plane rotates credentials before launching a replacement generation.
        await terminate_and_wait(sandbox)
        log.info("sandbox.docker_allocation_retired", modal_object_id=sandbox.object_id)
        return None, True

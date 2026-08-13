import asyncio
import os
from collections.abc import Mapping
from pathlib import Path

from sandbox_runtime.access_services import AccessServices
from sandbox_runtime.constants import VNC_PASSWORD_ENV_VAR
from sandbox_runtime.core_services import CoreAgentServices
from sandbox_runtime.log_config import get_logger
from sandbox_runtime.repository_boot import BootstrapResult, RepositoryBootstrapper
from sandbox_runtime.runtime_config import RuntimeConfig
from sandbox_runtime.supervisor import SandboxSupervisor


def make_runtime_config(
    environment: Mapping[str, str] | None = None,
    *,
    workspace_path: Path = Path("/workspace"),
) -> RuntimeConfig:
    source = environment if environment is not None else os.environ
    return RuntimeConfig.from_env(source, workspace_path=workspace_path)


def make_repository_bootstrapper(
    environment: Mapping[str, str] | None = None,
    *,
    workspace_path: Path = Path("/workspace"),
) -> RepositoryBootstrapper:
    config = make_runtime_config(environment, workspace_path=workspace_path)
    return RepositoryBootstrapper(
        config.repository_config(), asyncio.Event(), get_logger("supervisor")
    )


def make_core_services(
    environment: Mapping[str, str] | None = None,
    *,
    workspace_path: Path = Path("/workspace"),
) -> CoreAgentServices:
    config = make_runtime_config(environment, workspace_path=workspace_path)
    return CoreAgentServices(
        config.core_services_config(),
        asyncio.Event(),
        get_logger("supervisor"),
        lambda **_kwargs: None,
    )


def make_access_services(
    environment: Mapping[str, str] | None = None,
    *,
    workspace_path: Path = Path("/workspace"),
    vnc_password: str | None = None,
) -> AccessServices:
    source = environment if environment is not None else os.environ
    password = vnc_password
    if password is None and source is os.environ:
        password = os.environ.get(VNC_PASSWORD_ENV_VAR) or None
    return AccessServices(
        asyncio.Event(),
        get_logger("supervisor"),
        vnc_password=password,
    )


def make_supervisor(
    environment: Mapping[str, str] | None = None,
    *,
    workspace_path: Path = Path("/workspace"),
) -> SandboxSupervisor:
    config = make_runtime_config(environment, workspace_path=workspace_path)
    shutdown_event = asyncio.Event()
    log = get_logger("supervisor")
    repository = RepositoryBootstrapper(config.repository_config(), shutdown_event, log)
    core = CoreAgentServices(
        config.core_services_config(), shutdown_event, log, repository.record_boot_warning
    )
    access = AccessServices(shutdown_event, log, vnc_password=None)
    supervisor = SandboxSupervisor(config, repository, core, access, shutdown_event, log)
    supervisor._bootstrap_result = BootstrapResult(
        git_sync_success=True,
        repository_shas=[],
        setup_success=True,
        start_success=True,
        repositories=tuple(repository.repositories),
        workdir=repository._opencode_workdir(),
    )
    return supervisor

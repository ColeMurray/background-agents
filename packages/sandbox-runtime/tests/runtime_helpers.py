import asyncio
import os
from collections.abc import Mapping
from pathlib import Path

from sandbox_runtime.access_services import AccessServices
from sandbox_runtime.constants import VNC_PASSWORD_ENV_VAR
from sandbox_runtime.core_services import CoreAgentServices
from sandbox_runtime.log_config import get_logger
from sandbox_runtime.repo_config import parse_repositories
from sandbox_runtime.repository_boot import RepositoryBootstrapper
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
    return RepositoryBootstrapper(config, asyncio.Event(), get_logger("supervisor"))


def make_core_services(
    environment: Mapping[str, str] | None = None,
    *,
    workspace_path: Path = Path("/workspace"),
) -> CoreAgentServices:
    config = make_runtime_config(environment, workspace_path=workspace_path)
    services = CoreAgentServices(
        config,
        asyncio.Event(),
        get_logger("supervisor"),
        lambda **_kwargs: None,
    )
    repositories = parse_repositories(
        config.session_config,
        workspace_path=config.workspace_path,
        scalar_owner=config.repo_owner,
        scalar_name=config.repo_name,
        scalar_branch=config.base_branch,
    )
    workdir = config.repo_path if len(repositories) == 1 else config.workspace_path
    services.configure_workspace(tuple(repositories), workdir)
    return services


def make_access_services(
    environment: Mapping[str, str] | None = None,
    *,
    workspace_path: Path = Path("/workspace"),
    vnc_password: str | None = None,
) -> AccessServices:
    source = environment if environment is not None else os.environ
    config = make_runtime_config(source, workspace_path=workspace_path)
    password = vnc_password
    if password is None and source is os.environ:
        password = os.environ.pop(VNC_PASSWORD_ENV_VAR, None) or None
    return AccessServices(
        config,
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
    repository = RepositoryBootstrapper(config, shutdown_event, log)
    core = CoreAgentServices(config, shutdown_event, log, repository.record_boot_warning)
    access = AccessServices(config, shutdown_event, log, vnc_password=None)
    return SandboxSupervisor(config, repository, core, access, shutdown_event, log)

import asyncio
import os
from collections.abc import Mapping
from pathlib import Path

from sandbox_runtime.agent_bridge_process import AgentBridgeProcess
from sandbox_runtime.boot_warnings import BootWarningSink
from sandbox_runtime.browser_desktop import BrowserDesktop
from sandbox_runtime.code_server import CodeServer
from sandbox_runtime.constants import VNC_PASSWORD_ENV_VAR
from sandbox_runtime.log_config import get_logger
from sandbox_runtime.opencode_server import OpenCodeServer
from sandbox_runtime.repository_boot import RepositoryBoot, RepositoryBootResult
from sandbox_runtime.repository_hooks import RepositoryHooks
from sandbox_runtime.repository_sync import RepositorySynchronizer
from sandbox_runtime.runtime_config import RuntimeConfig
from sandbox_runtime.supervisor import SandboxSupervisor
from sandbox_runtime.tunnel_environment import TunnelEnvironment
from sandbox_runtime.web_terminal import WebTerminal


def make_runtime_config(
    environment: Mapping[str, str] | None = None,
    *,
    workspace_path: Path = Path("/workspace"),
) -> RuntimeConfig:
    source = environment if environment is not None else os.environ
    return RuntimeConfig.from_env(source, workspace_path=workspace_path)


def make_repository_boot(
    environment: Mapping[str, str] | None = None,
    *,
    workspace_path: Path = Path("/workspace"),
) -> RepositoryBoot:
    config = make_runtime_config(environment, workspace_path=workspace_path)
    log = get_logger("supervisor")
    return RepositoryBoot(
        config.repository_config(),
        log,
        BootWarningSink(log),
        TunnelEnvironment(config.sandbox_id, log),
        RepositoryHooks(log),
        RepositorySynchronizer(config.vcs_host, log),
    )


def make_opencode_server(
    environment: Mapping[str, str] | None = None,
    *,
    workspace_path: Path = Path("/workspace"),
) -> OpenCodeServer:
    config = make_runtime_config(environment, workspace_path=workspace_path)
    return OpenCodeServer(
        config.opencode_config(),
        asyncio.Event(),
        get_logger("supervisor"),
        lambda **_kwargs: None,
    )


def make_browser_desktop(password: str | None = None) -> BrowserDesktop:
    if password is None:
        password = os.environ.get(VNC_PASSWORD_ENV_VAR) or None
    return BrowserDesktop(get_logger("supervisor"), password=password)


def make_supervisor(
    environment: Mapping[str, str] | None = None,
    *,
    workspace_path: Path = Path("/workspace"),
) -> SandboxSupervisor:
    config = make_runtime_config(environment, workspace_path=workspace_path)
    shutdown_event = asyncio.Event()
    log = get_logger("supervisor")
    warnings = BootWarningSink(log)
    repository = RepositoryBoot(
        config.repository_config(),
        log,
        warnings,
        TunnelEnvironment(config.sandbox_id, log),
        RepositoryHooks(log),
        RepositorySynchronizer(config.vcs_host, log),
    )
    opencode_server = OpenCodeServer(config.opencode_config(), shutdown_event, log, warnings.record)
    agent_bridge = AgentBridgeProcess(config.bridge_process_config(), log)
    code_server = CodeServer(log)
    web_terminal = WebTerminal(log)
    browser_desktop = BrowserDesktop(log, password=None)
    supervisor = SandboxSupervisor(
        config,
        repository,
        opencode_server,
        agent_bridge,
        code_server,
        web_terminal,
        browser_desktop,
        None,
        shutdown_event,
        log,
    )
    supervisor._repository_boot_result = RepositoryBootResult(
        git_sync_success=True,
        repository_shas=[],
        setup_success=True,
        start_success=True,
        repositories=tuple(repository.repositories),
        workdir=repository._opencode_workdir(),
    )
    return supervisor

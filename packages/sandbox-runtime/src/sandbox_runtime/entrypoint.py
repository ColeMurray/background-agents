#!/usr/bin/env python3
"""CLI and production composition root for the sandbox runtime."""

from __future__ import annotations

import argparse
import asyncio
import os
import signal
from typing import TYPE_CHECKING, Any

from .agent_bridge_process import AgentBridgeProcess
from .boot_warnings import BootWarningSink
from .browser_desktop import BrowserDesktop
from .claude_stager import ClaudeStager, isolated_claude_config_dir, resolve_claude_config_dir
from .code_server import CodeServer
from .constants import VNC_DISPLAY, VNC_PASSWORD_ENV_VAR
from .harness.base import HarnessId, HarnessProcessOwner
from .image_environment import apply_image_environment
from .log_config import configure_logging, get_logger
from .managed_skills import ManagedSkillsClient, ManagedSkillsMaterializer
from .modal_image_build_start import MODAL_IMAGE_BUILD_START_ARGUMENT, run_modal_image_build
from .opencode_server import OpenCodeServer, resolve_opencode_global_config_dir
from .repository_boot import RepositoryBoot
from .repository_hooks import RepositoryHooks
from .repository_sync import RepositorySynchronizer
from .runtime_config import RuntimeConfig
from .supervisor import SandboxSupervisor
from .tunnel_environment import TunnelEnvironment
from .web_terminal import WebTerminal

if TYPE_CHECKING:
    from collections.abc import Sequence
    from pathlib import Path

    from .repo_config import RepoEntry

configure_logging()


def build_harness_process(
    config: RuntimeConfig,
    shutdown_event: asyncio.Event,
    log: Any,
    warnings: BootWarningSink,
    claude_config_dir: Path | None,
) -> HarnessProcessOwner:
    """The supervisor-half registry: pick the process owner for the session's harness."""
    match config.harness:
        case HarnessId.OPENCODE:
            return OpenCodeServer(
                config.opencode_config(),
                shutdown_event,
                log,
                warnings.record,
            )
        case HarnessId.CLAUDE:
            return ClaudeStager(config.claude_stager_config(), log, config_dir=claude_config_dir)
    raise ValueError(f"Unsupported harness: {config.harness}")


def claude_config_dir_for(
    config: RuntimeConfig, repositories: Sequence[RepoEntry], log: Any
) -> Path | None:
    """Where Claude keeps its state, decided once before anything is written there.

    Managed skills are materialized before the stager runs, so both take the
    directory from here rather than deciding separately.
    """
    if config.harness is not HarnessId.CLAUDE:
        return None
    return isolated_claude_config_dir(
        resolve_claude_config_dir(), config.workspace_path, repositories, log
    )


def managed_skills_destination(harness: HarnessId, claude_config_dir: Path | None) -> Path:
    """Where managed skills land: each harness discovers skills from its own tree."""
    match harness:
        case HarnessId.OPENCODE:
            return resolve_opencode_global_config_dir() / "skills"
        case HarnessId.CLAUDE:
            if claude_config_dir is None:
                raise ValueError("Claude sessions need a config dir decided")
            return claude_config_dir / "skills"
    raise ValueError(f"Unsupported harness: {harness}")


def build_supervisor(shutdown_event: asyncio.Event) -> SandboxSupervisor:
    """Consume process secrets and compose the production runtime."""
    apply_image_environment()
    config = RuntimeConfig.from_env(os.environ)
    vnc_password = os.environ.pop(VNC_PASSWORD_ENV_VAR, None) or None
    if vnc_password:
        os.environ["DISPLAY"] = VNC_DISPLAY
    log = get_logger(
        "supervisor",
        service="sandbox",
        sandbox_id=config.sandbox_id,
        session_id=str(config.session_config.get("session_id", "")),
    )
    warnings = BootWarningSink(log)
    repository_boot = RepositoryBoot(
        config.repository_config(),
        log,
        warnings,
        TunnelEnvironment(config.sandbox_id, log),
        RepositoryHooks(log),
        RepositorySynchronizer(config.vcs_host, log),
    )
    claude_config_dir = claude_config_dir_for(config, repository_boot.repositories, log)
    managed_skills_config = config.managed_skills_config()
    managed_skills = None
    if managed_skills_config.control_plane_url and managed_skills_config.session_id:
        managed_skills = ManagedSkillsMaterializer(
            ManagedSkillsClient(
                managed_skills_config.control_plane_url,
                managed_skills_config.session_id,
                managed_skills_config.sandbox_token,
            ),
            managed_skills_destination(config.harness, claude_config_dir),
            log,
        )
    harness_process = build_harness_process(
        config, shutdown_event, log, warnings, claude_config_dir
    )
    agent_bridge = AgentBridgeProcess(config.bridge_process_config(), log)
    code_server = CodeServer(log)
    web_terminal = WebTerminal(log)
    browser_desktop = BrowserDesktop(log, password=vnc_password)
    return SandboxSupervisor(
        config,
        repository_boot,
        harness_process,
        agent_bridge,
        code_server,
        web_terminal,
        browser_desktop,
        managed_skills,
        shutdown_event,
        log,
    )


def install_signal_handlers(supervisor: SandboxSupervisor) -> None:
    """Route process signals to the supervisor-owned shutdown event."""
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, supervisor.request_shutdown, sig)


async def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Open-Inspect sandbox supervisor")
    parser.add_argument(
        MODAL_IMAGE_BUILD_START_ARGUMENT,
        dest="await_modal_image_build_token",
        action="store_true",
    )
    args = parser.parse_args(argv)

    supervisor = build_supervisor(asyncio.Event())
    install_signal_handlers(supervisor)
    if not args.await_modal_image_build_token:
        await supervisor.run()
        return 0
    return await run_modal_image_build(supervisor)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

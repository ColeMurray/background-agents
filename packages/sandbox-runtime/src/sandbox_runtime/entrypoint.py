#!/usr/bin/env python3
"""CLI and production composition root for the sandbox runtime."""

from __future__ import annotations

import argparse
import asyncio
import os
import signal

from .access_services import AccessServices
from .constants import VNC_DISPLAY, VNC_PASSWORD_ENV_VAR
from .core_services import CoreAgentServices
from .log_config import configure_logging, get_logger
from .modal_image_build_start import MODAL_IMAGE_BUILD_START_ARGUMENT, run_modal_image_build
from .repository_boot import RepositoryBootstrapper
from .runtime_config import RuntimeConfig
from .supervisor import SandboxSupervisor

configure_logging()


def build_supervisor(shutdown_event: asyncio.Event) -> SandboxSupervisor:
    """Consume process secrets and compose the production runtime."""
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
    repository_bootstrapper = RepositoryBootstrapper(config, shutdown_event, log)
    core_services = CoreAgentServices(
        config,
        shutdown_event,
        log,
        repository_bootstrapper.record_boot_warning,
    )
    access_services = AccessServices(
        config,
        shutdown_event,
        log,
        vnc_password=vnc_password,
    )
    return SandboxSupervisor(
        config,
        repository_bootstrapper,
        core_services,
        access_services,
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

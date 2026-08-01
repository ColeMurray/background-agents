"""One-shot launch protocol for provider-session image builds."""

from __future__ import annotations

import asyncio
import json
import os
import re
import signal
import sys
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import urlsplit

from .log_config import StructuredLogger, get_logger
from .repo_image_callback import RepoImageBuildCallback

IMAGE_BUILD_ID_ENV = "OI_IMAGE_BUILD_ID"
IMAGE_BUILD_LAUNCH_ARGUMENT = "--await-image-build-start-stdin-v1"
IMAGE_BUILD_LAUNCH_PROTOCOL = "stdin-v1"
LAUNCH_PROTOCOL_VERSION = 1
MAX_LAUNCH_PAYLOAD_BYTES = 16 * 1024
LAUNCH_PAYLOAD_FIELDS = {
    "version",
    "build_id",
    "provider_session_id",
    "callback_url",
    "failure_callback_url",
    "callback_token",
}
PROVIDER_SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$")


class ImageBuildLaunchError(ValueError):
    """The launch payload is absent or invalid."""


class ImageBuildLaunchCancelled(Exception):
    """Shutdown won while the runtime was waiting for its launch payload."""


@dataclass(frozen=True)
class ImageBuildLaunch:
    """Validated launch identity and its in-memory callback reporter."""

    build_id: str
    provider_session_id: str
    callback: RepoImageBuildCallback


class ImageBuildLaunchSupervisor(Protocol):
    """Supervisor surface required by the gated launch runner."""

    shutdown_event: asyncio.Event
    log: StructuredLogger

    def request_shutdown(self, sig: signal.Signals) -> None: ...

    async def run(self, repo_image_callback: RepoImageBuildCallback | None = None) -> None: ...


async def read_image_build_launch(
    reader: asyncio.StreamReader,
    *,
    expected_build_id: str,
    shutdown_event: asyncio.Event,
    logger: StructuredLogger | None = None,
) -> ImageBuildLaunch:
    """Read and validate one newline-delimited launch payload."""
    read_task = asyncio.create_task(reader.readline())
    shutdown_task = asyncio.create_task(shutdown_event.wait())
    tasks = {read_task, shutdown_task}
    try:
        done, _pending = await asyncio.wait(
            tasks,
            return_when=asyncio.FIRST_COMPLETED,
        )
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    if shutdown_task in done and shutdown_event.is_set():
        raise ImageBuildLaunchCancelled

    try:
        raw_payload = read_task.result()
    except ValueError as error:
        raise ImageBuildLaunchError("payload_too_large") from error
    if not raw_payload:
        raise ImageBuildLaunchError("stdin_closed")
    if not raw_payload.endswith(b"\n"):
        raise ImageBuildLaunchError("incomplete_payload")
    if len(raw_payload) > MAX_LAUNCH_PAYLOAD_BYTES:
        raise ImageBuildLaunchError("payload_too_large")
    try:
        payload = json.loads(raw_payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ImageBuildLaunchError("invalid_json") from error

    if not isinstance(payload, dict) or set(payload) != LAUNCH_PAYLOAD_FIELDS:
        raise ImageBuildLaunchError("invalid_fields")
    if type(payload.get("version")) is not int or payload["version"] != LAUNCH_PROTOCOL_VERSION:
        raise ImageBuildLaunchError("unsupported_version")
    for field_name in LAUNCH_PAYLOAD_FIELDS - {"version"}:
        value = payload[field_name]
        if not isinstance(value, str) or not value.strip():
            raise ImageBuildLaunchError(f"invalid_{field_name}")
    for field_name in ("callback_url", "failure_callback_url"):
        url = urlsplit(payload[field_name])
        if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password:
            raise ImageBuildLaunchError(f"invalid_{field_name}")
    if not PROVIDER_SESSION_ID_PATTERN.fullmatch(payload["provider_session_id"]):
        raise ImageBuildLaunchError("invalid_provider_session_id")
    if payload.get("build_id") != expected_build_id:
        raise ImageBuildLaunchError("build_id_mismatch")

    callback = RepoImageBuildCallback(
        build_id=payload["build_id"],
        callback_url=payload["callback_url"],
        failure_callback_url=payload["failure_callback_url"],
        token=payload["callback_token"],
        provider_session_id=payload["provider_session_id"],
        logger=logger or get_logger("image_build_launch"),
    )
    return ImageBuildLaunch(
        build_id=payload["build_id"],
        provider_session_id=payload["provider_session_id"],
        callback=callback,
    )


async def _connect_stdin_reader() -> tuple[asyncio.StreamReader, asyncio.ReadTransport]:
    """Attach an asyncio reader to stdin without using an executor thread."""
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=MAX_LAUNCH_PAYLOAD_BYTES + 1)
    protocol = asyncio.StreamReaderProtocol(reader)
    transport, _ = await loop.connect_read_pipe(lambda: protocol, sys.stdin.buffer)
    return reader, transport


def install_signal_handlers(supervisor: ImageBuildLaunchSupervisor) -> None:
    """Give one supervisor-owned event signal coverage across all phases."""
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, supervisor.request_shutdown, sig)


async def run_gated_image_build(supervisor: ImageBuildLaunchSupervisor) -> int:
    """Wait for a bound start payload, then run the build in the same process."""
    if os.environ.get("IMAGE_BUILD_MODE") != "true":
        supervisor.log.error("image_build.launch_failed", reason="invalid_build_mode")
        return 1

    expected_build_id = os.environ.get(IMAGE_BUILD_ID_ENV, "")
    if not expected_build_id:
        supervisor.log.error("image_build.launch_failed", reason="missing_build_identity")
        return 1

    supervisor.log.info("image_build.awaiting_start", build_id=expected_build_id)
    transport: asyncio.ReadTransport | None = None
    try:
        reader, transport = await _connect_stdin_reader()
        launch = await read_image_build_launch(
            reader,
            expected_build_id=expected_build_id,
            shutdown_event=supervisor.shutdown_event,
            logger=supervisor.log,
        )
        supervisor.log.info(
            "image_build.launch_accepted",
            build_id=launch.build_id,
            provider_session_id=launch.provider_session_id,
        )
        await supervisor.run(launch.callback)
        return 0
    except ImageBuildLaunchCancelled:
        supervisor.log.info("image_build.launch_cancelled", build_id=expected_build_id)
        return 0
    except ImageBuildLaunchError as error:
        supervisor.log.error(
            "image_build.launch_failed",
            build_id=expected_build_id,
            reason=str(error),
        )
        return 1
    finally:
        if transport is not None:
            transport.close()

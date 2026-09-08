"""Modal's token-gated image-build launch protocol."""

from __future__ import annotations

import asyncio
import os
import re
import sys
from typing import Protocol

from .log_config import StructuredLogger, get_logger
from .repo_image_callback import (
    BUILD_ID_ENV,
    CALLBACK_URL_ENV,
    FAILURE_CALLBACK_URL_ENV,
    RepoImageBuildCallback,
)

MODAL_SANDBOX_ID_ENV = "MODAL_SANDBOX_ID"
MODAL_IMAGE_BUILD_START_ARGUMENT = "--await-modal-image-build-token-stdin-v1"
MODAL_IMAGE_BUILD_START_PROTOCOL = "stdin-token-v1"

_CALLBACK_TOKEN_PATTERN = re.compile(r"^[a-f0-9]{64}$")
_MAX_CALLBACK_TOKEN_LINE_BYTES = 65


class ModalImageBuildStartCancelled(Exception):
    """Shutdown won while the Modal build waited for its callback token."""


class ModalImageBuildSupervisor(Protocol):
    """Supervisor surface required by the Modal launch protocol."""

    log: StructuredLogger
    shutdown_event: asyncio.Event

    async def run(self, repo_image_callback: RepoImageBuildCallback | None = None) -> bool: ...


async def read_modal_callback_token(
    reader: asyncio.StreamReader,
    shutdown_event: asyncio.Event,
) -> str:
    """Read and validate the one callback token delivered after provider binding."""
    read_task = asyncio.create_task(reader.readline())
    shutdown_task = asyncio.create_task(shutdown_event.wait())
    tasks = {read_task, shutdown_task}
    try:
        done, _pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    if read_task not in done:
        raise ModalImageBuildStartCancelled

    try:
        raw_token = read_task.result()
    except ValueError as error:
        raise ValueError("callback token too large") from error
    if not raw_token:
        raise ValueError("stdin closed")
    if not raw_token.endswith(b"\n"):
        raise ValueError("incomplete callback token")
    if len(raw_token) > _MAX_CALLBACK_TOKEN_LINE_BYTES:
        raise ValueError("callback token too large")
    try:
        token = raw_token[:-1].decode("ascii")
    except UnicodeDecodeError as error:
        raise ValueError("invalid callback token") from error
    if not _CALLBACK_TOKEN_PATTERN.fullmatch(token):
        raise ValueError("invalid callback token")
    return token


def create_modal_callback(
    token: str,
    logger: StructuredLogger | None = None,
) -> RepoImageBuildCallback:
    """Build the provider-neutral callback reporter from Modal launch context."""
    if not _CALLBACK_TOKEN_PATTERN.fullmatch(token):
        raise ValueError("invalid callback token")
    context = {
        BUILD_ID_ENV: os.environ.get(BUILD_ID_ENV, ""),
        CALLBACK_URL_ENV: os.environ.get(CALLBACK_URL_ENV, ""),
        FAILURE_CALLBACK_URL_ENV: os.environ.get(FAILURE_CALLBACK_URL_ENV, ""),
        MODAL_SANDBOX_ID_ENV: os.environ.get(MODAL_SANDBOX_ID_ENV, ""),
    }
    missing = [name for name, value in context.items() if not value]
    if missing:
        raise ValueError(f"missing Modal callback context: {', '.join(missing)}")
    return RepoImageBuildCallback(
        build_id=context[BUILD_ID_ENV],
        callback_url=context[CALLBACK_URL_ENV],
        failure_callback_url=context[FAILURE_CALLBACK_URL_ENV],
        token=token,
        provider_session_id=context[MODAL_SANDBOX_ID_ENV],
        logger=logger or get_logger("repo_image_callback"),
    )


async def _connect_start_reader() -> tuple[asyncio.StreamReader, asyncio.ReadTransport]:
    """Attach a bounded asyncio reader to Modal sandbox stdin."""
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=_MAX_CALLBACK_TOKEN_LINE_BYTES + 1)
    protocol = asyncio.StreamReaderProtocol(reader)
    transport, _ = await loop.connect_read_pipe(lambda: protocol, sys.stdin.buffer)
    return reader, transport


async def run_modal_image_build(supervisor: ModalImageBuildSupervisor) -> int:
    """Wait for the post-bind callback token, then run the build."""
    if os.environ.get("IMAGE_BUILD_MODE") != "true":
        supervisor.log.error("image_build.launch_failed", reason="invalid_build_mode")
        return 1

    build_id = os.environ.get(BUILD_ID_ENV, "")
    if not build_id:
        supervisor.log.error("image_build.launch_failed", reason="missing_build_identity")
        return 1

    supervisor.log.info("image_build.awaiting_start", build_id=build_id)
    transport: asyncio.ReadTransport | None = None
    try:
        reader, transport = await _connect_start_reader()
        token = await read_modal_callback_token(reader, supervisor.shutdown_event)
        callback = create_modal_callback(token, supervisor.log)
        for name in (BUILD_ID_ENV, CALLBACK_URL_ENV, FAILURE_CALLBACK_URL_ENV):
            os.environ.pop(name, None)
        supervisor.log.info(
            "image_build.launch_accepted",
            build_id=callback.build_id,
            provider_session_id=callback.provider_session_id,
        )
    except ModalImageBuildStartCancelled:
        supervisor.log.info("image_build.launch_cancelled", build_id=build_id)
        return 0
    except ValueError as error:
        supervisor.log.error(
            "image_build.launch_failed",
            build_id=build_id,
            reason=str(error),
        )
        return 1
    finally:
        if transport is not None:
            transport.close()

    build_succeeded = await supervisor.run(callback)
    return 0 if build_succeeded else 1

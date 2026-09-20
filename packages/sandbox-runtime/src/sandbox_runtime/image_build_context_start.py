"""Stdin-context image-build launch protocol, and the deferred start it ends.

A build sandbox whose provider captures container configuration into the
reusable image must not receive build credentials in its create request. Such
a sandbox is created in deferred-start mode instead: the baked entrypoint
composes nothing, holds the container open, and exits on the first shutdown
signal. The control plane binds the sandbox id, then execs the entrypoint once
more with ``IMAGE_BUILD_CONTEXT_START_ARGUMENT`` and writes one JSON line to
that process's stdin.

The context carries the build identity, the repository manifest, the callback
credentials, the execution budget, the clone identity and the scope
environment. Everything secret in it reaches the build through this process's
memory and its children's environment only: never the container's own
configuration, never a file, never a command line. The callback token stays in
the callback object and is never exported to the environment the setup hooks
inherit.

Unknown members of a version-1 context are ignored, so a control plane that
adds a field can deploy before every base image carries a runtime that reads
it; an incompatible contract bumps ``version`` instead.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import signal
import sys
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

from .constants import IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_VAR
from .log_config import StructuredLogger, get_logger
from .repo_image_callback import (
    BUILD_ID_ENV,
    CALLBACK_TOKEN_ENV,
    CALLBACK_URL_ENV,
    FAILURE_CALLBACK_URL_ENV,
    PROVIDER_SESSION_ID_ENV,
    RepoImageBuildCallback,
)

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping, MutableMapping

IMAGE_BUILD_CONTEXT_START_ARGUMENT = "--image-build-context-stdin-v1"
IMAGE_BUILD_CONTEXT_START_PROTOCOL = "stdin-context-v1"
IMAGE_BUILD_CONTEXT_VERSION = 1

#: Set to "true" on a build sandbox created before its launch context exists.
#: Any other value (including absent) boots the sandbox normally, so an image
#: captured from such a sandbox cannot inherit the dormant mode.
DEFERRED_START_ENV_VAR = "OI_DEFERRED_START"

#: Largest accepted context document, newline excluded.
MAX_IMAGE_BUILD_CONTEXT_BYTES = 1024 * 1024

#: One launch per sandbox. The exclusive create is the whole mechanism: a
#: second exec of the launcher finds the file and refuses, so a redelivered
#: launch cannot start a second supervisor over the first one's checkout.
IMAGE_BUILD_LAUNCH_GUARD_PATH = "/tmp/oi-image-build.launched"

_CALLBACK_TOKEN_PATTERN = re.compile(r"^[a-f0-9]{64}$")

#: Credential the git credential helper pairs with ``VCS_HOST``.
VCS_CLONE_TOKEN_ENV = "VCS_CLONE_TOKEN"

#: Keys the launcher owns in the environment the image itself carries.
#: Scrubbed before anything is layered on, so no baked variable can choose the
#: boot mode, redirect a callback, impersonate session auth, or leave a stale
#: clone credential in place. ``OI_DEFERRED_START`` is here so the composed
#: build process — and every setup hook under it — no longer sees the dormant
#: marker.
RESERVED_CONTEXT_ENV_KEYS: frozenset[str] = frozenset(
    {
        # Boot mode (runtime_config.BootMode.from_env).
        "IMAGE_BUILD_MODE",
        "RESTORED_FROM_SNAPSHOT",
        "FROM_REPO_IMAGE",
        "REPO_IMAGE_SHA",
        "OPENINSPECT_BOOT_MODE",
        DEFERRED_START_ENV_VAR,
        # Build callback contract (repo_image_callback).
        BUILD_ID_ENV,
        CALLBACK_URL_ENV,
        FAILURE_CALLBACK_URL_ENV,
        CALLBACK_TOKEN_ENV,
        PROVIDER_SESSION_ID_ENV,
        "OI_REPO_IMAGE_CALLBACK_SECRET",
        IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_VAR,
        # Session identity and clone identity.
        "SANDBOX_ID",
        "SESSION_CONFIG",
        "REPO_OWNER",
        "REPO_NAME",
        "CONTROL_PLANE_URL",
        "SANDBOX_AUTH_TOKEN",
        "VCS_HOST",
        "VCS_CLONE_USERNAME",
        VCS_CLONE_TOKEN_ENV,
    }
)

#: Keys a repository secret may not set, which is every launcher-owned key
#: except the clone token. The control-plane's own build environment
#: (``buildImageBuildEnvVars``/``applyScmCloneEnv`` in the control plane) lets
#: a scope-supplied ``VCS_CLONE_TOKEN`` stand when no token could be brokered,
#: and overwrites it when one could; a deployment whose SCM credential is a
#: repository secret clones the same way here as on every other provider.
RESERVED_SCOPE_ENV_KEYS: frozenset[str] = RESERVED_CONTEXT_ENV_KEYS - {VCS_CLONE_TOKEN_ENV}


class ImageBuildContextStartCancelled(Exception):
    """Shutdown won while the build sandbox waited for its launch context."""


class ImageBuildContextError(ValueError):
    """The launch context is unusable. Its message is a fixed reason code.

    Reason codes never quote the payload: a context carries a callback token,
    a clone token and the scope's secrets, and the launch log is not a place
    any of them may appear.
    """


class ImageBuildContextSupervisor(Protocol):
    """Supervisor surface required by the stdin-context launch protocol."""

    log: StructuredLogger
    shutdown_event: asyncio.Event

    async def run(self, repo_image_callback: RepoImageBuildCallback | None = None) -> bool: ...


@dataclass(frozen=True)
class ImageBuildRepositoryContext:
    """One repository of the build scope, in position order ([0] = primary)."""

    repo_owner: str
    repo_name: str
    branch: str


@dataclass(frozen=True)
class ImageBuildCloneContext:
    """Clone identity for the build's checkouts.

    ``token`` is absent when the control plane could not broker one; the host
    and username still travel so the credential helper targets the right SCM.
    """

    host: str
    username: str
    token: str | None


@dataclass(frozen=True)
class ImageBuildLaunchContext:
    """One validated launch context."""

    build_id: str
    provider_session_id: str
    sandbox_id: str
    callback_url: str
    failure_callback_url: str
    callback_token: str
    execution_timeout_seconds: int
    repositories: tuple[ImageBuildRepositoryContext, ...]
    clone: ImageBuildCloneContext | None
    env: Mapping[str, str]


def deferred_start_requested(environment: Mapping[str, str]) -> bool:
    """Whether this sandbox was created to stay dormant until it is launched."""
    return environment.get(DEFERRED_START_ENV_VAR) == "true"


def parse_image_build_context(raw: bytes) -> ImageBuildLaunchContext:
    """Validate one context document. Raises ImageBuildContextError on anything else."""
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ImageBuildContextError("invalid_encoding") from error
    try:
        payload = json.loads(text)
    except ValueError as error:
        raise ImageBuildContextError("invalid_json") from error
    if not isinstance(payload, dict):
        raise ImageBuildContextError("invalid_context")
    if payload.get("version") != IMAGE_BUILD_CONTEXT_VERSION:
        raise ImageBuildContextError("unsupported_version")

    token = _required_string(payload, "callback_token")
    if not _CALLBACK_TOKEN_PATTERN.fullmatch(token):
        raise ImageBuildContextError("invalid_field:callback_token")

    return ImageBuildLaunchContext(
        build_id=_required_string(payload, "build_id"),
        provider_session_id=_required_string(payload, "provider_session_id"),
        sandbox_id=_required_string(payload, "sandbox_id"),
        callback_url=_required_string(payload, "callback_url"),
        failure_callback_url=_required_string(payload, "failure_callback_url"),
        callback_token=token,
        execution_timeout_seconds=_required_positive_int(payload, "execution_timeout_seconds"),
        repositories=_required_repositories(payload),
        clone=_optional_clone(payload),
        env=_optional_env(payload),
    )


def compose_image_build_environment(
    context: ImageBuildLaunchContext, environment: MutableMapping[str, str]
) -> None:
    """Lay the build's process environment down over the container's own.

    Order is the contract: reserved keys are dropped from whatever the image
    carried, the scope environment is applied, then the system values are
    overlaid so no user value can shadow one. The callback token is absent by
    construction — it lives in the callback object, not here.

    The one key a scope may still supply is the clone token, which the
    brokered one overwrites when there is one. That is the shared build
    environment's rule, not a Daytona exception.
    """
    for key in RESERVED_CONTEXT_ENV_KEYS:
        environment.pop(key, None)
    for key, value in context.env.items():
        if key in RESERVED_SCOPE_ENV_KEYS:
            continue
        environment[key] = value

    primary = context.repositories[0]
    environment.update(
        {
            "PYTHONUNBUFFERED": "1",
            "SANDBOX_ID": context.sandbox_id,
            "REPO_OWNER": primary.repo_owner,
            "REPO_NAME": primary.repo_name,
            "IMAGE_BUILD_MODE": "true",
            "SESSION_CONFIG": json.dumps(
                {
                    "branch": primary.branch,
                    "repositories": [
                        {
                            "repo_owner": repository.repo_owner,
                            "repo_name": repository.repo_name,
                            "branch": repository.branch,
                        }
                        for repository in context.repositories
                    ],
                }
            ),
            IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_VAR: str(context.execution_timeout_seconds),
        }
    )
    if context.clone is not None:
        environment["VCS_HOST"] = context.clone.host
        environment["VCS_CLONE_USERNAME"] = context.clone.username
        if context.clone.token:
            environment[VCS_CLONE_TOKEN_ENV] = context.clone.token


async def run_deferred_start() -> int:
    """Hold a dormant build sandbox open until it is stopped.

    Composes nothing: no configuration is read, no repository is cloned, no
    service is started, and no callback is reachable. The sandbox exists only
    so the control plane can bind its id and then launch the build on it.
    """
    log = get_logger("image_build_context_start")
    shutdown_event = asyncio.Event()
    _install_shutdown_handlers(shutdown_event)
    log.info("entrypoint.deferred_start", protocol=IMAGE_BUILD_CONTEXT_START_PROTOCOL)
    await shutdown_event.wait()
    log.info("entrypoint.deferred_start_stopped")
    return 0


async def run_image_build_context_start(
    build_supervisor: Callable[[asyncio.Event], ImageBuildContextSupervisor],
    install_signal_handlers: Callable[[ImageBuildContextSupervisor], None],
) -> int:
    """Read one launch context, compose the build environment, run the build.

    The supervisor is constructed only after the environment is composed, so
    it reads the launched build's configuration rather than the dormant
    sandbox's. Every rejection is terminal: the launcher never falls through
    to an interactive boot.
    """
    log = get_logger("image_build_context_start")
    shutdown_event = asyncio.Event()
    _install_shutdown_handlers(shutdown_event)

    try:
        guard_fd = _claim_launch_guard()
    except ImageBuildContextError as error:
        log.error("image_build.launch_failed", reason=str(error))
        return 1

    transport: asyncio.ReadTransport | None = None
    try:
        reader, transport = await _connect_context_reader()
        context = parse_image_build_context(await _read_context_line(reader, shutdown_event))
        os.write(guard_fd, context.build_id.encode("utf-8"))
    except ImageBuildContextStartCancelled:
        log.info("image_build.launch_cancelled")
        return 0
    except ImageBuildContextError as error:
        log.error("image_build.launch_failed", reason=str(error))
        return 1
    finally:
        os.close(guard_fd)
        if transport is not None:
            transport.close()

    compose_image_build_environment(context, os.environ)
    callback = RepoImageBuildCallback(
        build_id=context.build_id,
        callback_url=context.callback_url,
        failure_callback_url=context.failure_callback_url,
        token=context.callback_token,
        provider_session_id=context.provider_session_id,
        logger=log,
    )
    log.info(
        "image_build.launch_accepted",
        build_id=context.build_id,
        provider_session_id=context.provider_session_id,
        protocol=IMAGE_BUILD_CONTEXT_START_PROTOCOL,
    )

    supervisor = build_supervisor(shutdown_event)
    install_signal_handlers(supervisor)
    build_succeeded = await supervisor.run(callback)
    return 0 if build_succeeded else 1


def _install_shutdown_handlers(shutdown_event: asyncio.Event) -> None:
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, shutdown_event.set)


def _claim_launch_guard() -> int:
    try:
        return os.open(IMAGE_BUILD_LAUNCH_GUARD_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as error:
        raise ImageBuildContextError("duplicate_launch") from error


async def _connect_context_reader() -> tuple[asyncio.StreamReader, asyncio.ReadTransport]:
    """Attach a bounded asyncio reader to this process's stdin."""
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=MAX_IMAGE_BUILD_CONTEXT_BYTES + 1)
    protocol = asyncio.StreamReaderProtocol(reader)
    transport, _ = await loop.connect_read_pipe(lambda: protocol, sys.stdin.buffer)
    return reader, transport


async def _read_context_line(reader: asyncio.StreamReader, shutdown_event: asyncio.Event) -> bytes:
    """Read the one newline-terminated context line, or give up on shutdown."""
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
        raise ImageBuildContextStartCancelled

    try:
        raw = read_task.result()
    except ValueError as error:
        raise ImageBuildContextError("oversized_context") from error
    if not raw:
        raise ImageBuildContextError("stdin_closed")
    if not raw.endswith(b"\n"):
        raise ImageBuildContextError("incomplete_context")
    if len(raw) > MAX_IMAGE_BUILD_CONTEXT_BYTES + 1:
        raise ImageBuildContextError("oversized_context")
    return raw[:-1]


def _required_string(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if value is None:
        raise ImageBuildContextError(f"missing_field:{key}")
    if not isinstance(value, str) or not value:
        raise ImageBuildContextError(f"invalid_field:{key}")
    return value


def _required_positive_int(payload: dict[str, Any], key: str) -> int:
    value = payload.get(key)
    if value is None:
        raise ImageBuildContextError(f"missing_field:{key}")
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ImageBuildContextError(f"invalid_field:{key}")
    return value


def _required_repositories(payload: dict[str, Any]) -> tuple[ImageBuildRepositoryContext, ...]:
    value = payload.get("repositories")
    if value is None:
        raise ImageBuildContextError("missing_field:repositories")
    if not isinstance(value, list) or not value:
        raise ImageBuildContextError("invalid_field:repositories")
    repositories = []
    for entry in value:
        if not isinstance(entry, dict):
            raise ImageBuildContextError("invalid_field:repositories")
        repositories.append(
            ImageBuildRepositoryContext(
                repo_owner=_required_string(entry, "repo_owner"),
                repo_name=_required_string(entry, "repo_name"),
                branch=_required_string(entry, "branch"),
            )
        )
    return tuple(repositories)


def _optional_clone(payload: dict[str, Any]) -> ImageBuildCloneContext | None:
    value = payload.get("clone")
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ImageBuildContextError("invalid_field:clone")
    token = value.get("token")
    if token is not None and (not isinstance(token, str) or not token):
        raise ImageBuildContextError("invalid_field:token")
    return ImageBuildCloneContext(
        host=_required_string(value, "host"),
        username=_required_string(value, "username"),
        token=token,
    )


def _optional_env(payload: dict[str, Any]) -> Mapping[str, str]:
    value = payload.get("env")
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ImageBuildContextError("invalid_field:env")
    for key, item in value.items():
        if not isinstance(key, str) or not isinstance(item, str):
            raise ImageBuildContextError("invalid_field:env")
    return value

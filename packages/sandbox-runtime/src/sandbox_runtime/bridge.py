"""
Agent bridge - bidirectional communication between sandbox and control plane.

This module handles:
- WebSocket connection to control plane Durable Object
- Heartbeat loop for connection health
- Event forwarding from the agent harness to the control plane
- Command handling from control plane (prompt, stop, snapshot)
- Git identity configuration per prompt author

The agent itself sits behind the ``AgentHarness`` seam (see ``harness/``);
this module never speaks a vendor protocol.

In early-connect mode (``--early-connect``, requested by the control plane
through ``SESSION_CONFIG``) the bridge starts transport-only: it connects
before the repository boots, relays the supervisor's boot phases, holds
prompts, and attaches its harness only when the supervisor reports the
harness phase complete. ``ready`` is sent after that attach, and again on
every reconnect, so the control plane learns readiness from the runtime
rather than from the socket.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

import websockets
from websockets import ClientConnection, State
from websockets.exceptions import InvalidStatus

from .attachment_processor import (
    AttachmentProcessor,
    parse_session_image_attachments,
)
from .boot_event_relay import BootEventRelay
from .constants import (
    BOOT_EVENTS_FILE_PATH,
    BRIDGE_FATAL_ERROR_FILE_PATH,
    REPO_MANIFEST_FILE_PATH,
)
from .diff_capture import ControlPlaneDiffClient, SessionDiffRefreshWorker
from .event_forwarder import BufferedEventForwarder
from .git_signing import GitSigningError, GitSigningRuntime
from .harness import (
    DEFAULT_HARNESS_ID,
    DETERMINISTIC_FAILURE_EXIT_CODE,
    AgentHarness,
    BridgeIdentity,
    HarnessId,
    HarnessPrompt,
    HarnessStartError,
    TurnOutcome,
    build_agent_harness,
    parse_harness_id,
)
from .log_config import configure_logging, get_logger
from .prompt_budgets import resolve_prompt_limits
from .push_operation import PushOperation, PushRejected, PushRequest
from .repo_config import load_repo_manifest
from .types import GitUser

if TYPE_CHECKING:
    from collections.abc import Callable

    from .attachment_processor import HydratedSessionAttachment

configure_logging()


def parse_prompt_git_author(author_data: object) -> GitUser | None:
    """Parse the control plane's explicit Git author mode without inference."""
    if not isinstance(author_data, dict):
        raise GitSigningError("Invalid prompt Git identity")

    identity = author_data.get("gitIdentity")
    if not isinstance(identity, dict):
        raise GitSigningError("Invalid prompt Git identity")

    mode = identity.get("mode")
    if mode == "agent-only":
        return None
    if mode != "attributed-user":
        raise GitSigningError("Invalid prompt Git identity")

    name = identity.get("name")
    email = identity.get("email")
    if not isinstance(name, str) or not name.strip():
        raise GitSigningError("Invalid prompt Git identity")
    if not isinstance(email, str) or not email.strip():
        raise GitSigningError("Invalid prompt Git identity")
    return GitUser(name=name.strip(), email=email.strip())


class SessionTerminatedError(Exception):
    """Raised when the control plane has terminated the session (HTTP 410).

    This is a non-recoverable error - the bridge should exit gracefully
    rather than retry. The session can be restored via user action (sending
    a new prompt), which will trigger snapshot restoration on the control plane.
    """

    pass


class AgentBridge:
    """
    Bridge between the sandbox's agent harness and the control plane.

    Handles:
    - WebSocket connection management with reconnection
    - Heartbeat for connection health
    - Event streaming from the harness to the control plane
    - Command handling (prompt, stop, snapshot, shutdown)
    - Git identity management per prompt author
    """

    HEARTBEAT_INTERVAL = 30.0
    RECONNECT_BACKOFF_BASE = 2.0
    RECONNECT_MAX_DELAY = 60.0
    DIFF_REFRESH_SHUTDOWN_TIMEOUT_SECONDS = 5.0
    # How often the boot-events file is polled while the repository boots.
    BOOT_EVENTS_POLL_SECONDS = 0.25

    def __init__(
        self,
        sandbox_id: str,
        session_id: str,
        control_plane_url: str,
        auth_token: str,
        opencode_port: int = 4096,
        harness_id: HarnessId = DEFAULT_HARNESS_ID,
        harness: AgentHarness | None = None,
        *,
        early_connect: bool = False,
        harness_factory: Callable[[], AgentHarness] | None = None,
    ):
        self.sandbox_id = sandbox_id
        self.early_connect = early_connect
        self.session_id = session_id
        self.control_plane_url = control_plane_url
        self.auth_token = auth_token
        self.opencode_port = opencode_port

        # Logger
        self.log = get_logger(
            "bridge",
            service="sandbox",
            sandbox_id=sandbox_id,
            session_id=session_id,
        )
        self.attachment_processor = AttachmentProcessor(
            control_plane_url=control_plane_url,
            session_id=session_id,
            auth_token=auth_token,
            log=self.log,
            warn_user=self._send_media_warning,
        )

        self.prompt_limits = resolve_prompt_limits(self.log)

        self.ws: ClientConnection | None = None
        self.shutdown_event = asyncio.Event()
        self.git_sync_complete = asyncio.Event()

        # Vendor session id persistence. The legacy file name is still read so
        # snapshots taken before the rename keep their conversation history.
        temp_dir = Path(tempfile.gettempdir())
        self.session_id_file = temp_dir / "agent-session-id"
        self.legacy_session_id_file = temp_dir / "opencode-session-id"
        self.repo_path = Path("/workspace")
        # Supervisor-written canonical repo manifest; push targeting resolves
        # member checkout paths through it rather than joining spec-supplied
        # names into the filesystem.
        self.repo_manifest_path = Path(REPO_MANIFEST_FILE_PATH)
        self.git_signing = GitSigningRuntime(
            control_plane_url=control_plane_url,
            session_id=session_id,
            auth_token=auth_token,
            repo_manifest_path=self.repo_manifest_path,
        )

        # The agent behind the seam. Injected in tests; built from the
        # registry in production. In early-connect mode nothing is built
        # until the supervisor reports the harness phase complete: the
        # Claude harness reads a handoff the supervisor writes during boot,
        # and OpenCode's session probe needs the server up.
        self._harness_id = harness_id
        self._harness_factory: Callable[[], AgentHarness] = (
            harness_factory
            if harness_factory is not None
            else lambda: build_agent_harness(
                harness_id,
                identity=BridgeIdentity(
                    sandbox_id=sandbox_id,
                    session_id=session_id,
                    control_plane_url=control_plane_url,
                    auth_token=auth_token,
                    repo_manifest_path=self.repo_manifest_path,
                ),
                attachment_processor=self.attachment_processor,
                log=self.log,
                limits=self.prompt_limits,
                opencode_port=opencode_port,
            )
        )
        self.harness: AgentHarness | None
        if early_connect:
            self.harness = None
        else:
            self.harness = harness if harness is not None else self._harness_factory()
        # Set once the harness is attached and `ready` has been sent; prompts
        # received before then wait on it, and heartbeats say `booting`. A
        # classic bridge is attached from construction: it only starts after
        # boot, and opens its harness before its first connect.
        self._boot_ready = asyncio.Event()
        if not early_connect:
            self._boot_ready.set()
        self.boot_relay = BootEventRelay(Path(BOOT_EVENTS_FILE_PATH), self.log)
        self._boot_relay_task: asyncio.Task[None] | None = None
        # Boot-event lines read but not yet delivered over an open socket.
        # Retried at the head of the next pass, and they hold the relay
        # cursor where it is until they land.
        self._held_boot_lines: list[dict[str, Any]] = []
        # A harness attach that ended the run; re-raised from run() so the
        # process exits the way a pre-connect open failure always has.
        self._attach_failure: BaseException | None = None
        self._attach_outcome: str | None = None

        # Track the current prompt task so _handle_stop can cancel it
        self._current_prompt_task: asyncio.Task[None] | None = None
        self.diff_refresh = SessionDiffRefreshWorker(
            client=ControlPlaneDiffClient(
                control_plane_url=self.control_plane_url,
                session_id=self.session_id,
                auth_token=self.auth_token,
            ),
            manifest_path=self.repo_manifest_path,
            log=self.log,
        )

        # Reconnect-safe event delivery: buffers while the WS is down and
        # re-sends unacknowledged critical events (see event_forwarder.py).
        self.event_forwarder = BufferedEventForwarder(sandbox_id=sandbox_id, log=self.log)

        self._connected_at_monotonic: float | None = None
        self._connection_count = 0
        self._reconnect_attempt_count = 0
        self._total_connected_duration_seconds = 0.0

    @property
    def agent_session_id(self) -> str | None:
        """The vendor session id, once created or resumed."""
        return self.harness.session_id if self.harness is not None else None

    def _require_harness(self) -> AgentHarness:
        if self.harness is None:
            raise RuntimeError("agent harness is not attached yet")
        return self.harness

    @property
    def ws_url(self) -> str:
        """WebSocket URL for control plane connection."""
        url = self.control_plane_url.replace("https://", "wss://").replace("http://", "ws://")
        return f"{url}/sessions/{self.session_id}/ws?type=sandbox"

    def _build_ready_event(self) -> dict[str, Any]:
        harness = self._require_harness()
        repositories = load_repo_manifest(self.repo_manifest_path)
        # The image bakes SANDBOX_VERSION; reporting it lets the control plane
        # stamp snapshots with the runtime that produced them and retire the
        # ones a later compatibility floor rules out.
        runtime_version = os.environ.get("SANDBOX_VERSION", "")
        return {
            "type": "ready",
            "sandboxId": self.sandbox_id,
            "opencodeSessionId": harness.session_id,
            "harness": harness.id.value,
            **({"runtimeVersion": runtime_version} if runtime_version else {}),
            "repositories": [
                {
                    "position": position,
                    "repoOwner": repository.owner,
                    "repoName": repository.name,
                    "baseSha": repository.base_sha,
                }
                for position, repository in enumerate(repositories)
                if repository.base_sha
            ],
        }

    async def run(self) -> None:
        """Main bridge loop with reconnection handling.

        Handles reconnection for transient errors (network issues, etc.) but
        exits gracefully for terminal errors like HTTP 410 (session terminated).
        """
        self.log.info(
            "bridge.run_start", harness=self._harness_id.value, early_connect=self.early_connect
        )
        reconnect_attempts = 0
        run_outcome = "harness_start_failed"
        signing_initialized = False

        # One lifecycle: whatever the harness acquires in open() is released
        # in the finally below, whether startup, session loading or the run
        # loop is what ends the bridge.
        try:
            if self.early_connect:
                # The relay attaches the harness when the supervisor reports
                # it up; until then the loop below is transport only.
                self._boot_relay_task = asyncio.create_task(self._relay_boot_events())
            else:
                await self._open_harness(self._require_harness())
                await self._load_session_id()
                self._boot_relay_task = asyncio.create_task(self._relay_boot_events())
            run_outcome = "shutdown"
            while not self.shutdown_event.is_set():
                run_outcome = "shutdown"
                try:
                    if not self.early_connect and not signing_initialized:
                        await self.git_signing.initialize(None)
                        signing_initialized = True
                    await self._connect_and_run()
                    if not self.shutdown_event.is_set():
                        run_outcome = "connection_closed"
                    reconnect_attempts = 0
                except SessionTerminatedError:
                    run_outcome = "session_terminated"
                    self.shutdown_event.set()
                    break
                except websockets.ConnectionClosed:
                    run_outcome = "connection_closed"
                except Exception as e:
                    error_str = str(e)
                    # Check for fatal HTTP errors that shouldn't trigger retry
                    if (
                        isinstance(e, GitSigningError) and not e.retryable
                    ) or self._is_fatal_connection_error(error_str):
                        run_outcome = "fatal_error"
                        self.shutdown_event.set()
                        break
                    run_outcome = "connection_error"
                    self.log.warn(
                        "bridge.connect_error",
                        detail=error_str,
                    )

                if self.shutdown_event.is_set():
                    break

                reconnect_attempts += 1
                self._reconnect_attempt_count += 1
                delay = min(
                    self.RECONNECT_BACKOFF_BASE**reconnect_attempts,
                    self.RECONNECT_MAX_DELAY,
                )
                self.log.info(
                    "bridge.reconnect",
                    attempt=reconnect_attempts,
                    reconnect_attempt_count=self._reconnect_attempt_count,
                    delay_s=round(delay, 1),
                )
                await asyncio.sleep(delay)

            if self._attach_outcome is not None:
                run_outcome = self._attach_outcome
            if self._attach_failure is not None:
                raise self._attach_failure

        finally:
            if self._boot_relay_task is not None and not self._boot_relay_task.done():
                self._boot_relay_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await self._boot_relay_task
            # Cancel any in-flight prompt task before closing resources
            if self._current_prompt_task and not self._current_prompt_task.done():
                self._current_prompt_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await self._current_prompt_task
            # Cleanup failures are logged, never raised: an exception here
            # would replace the one that ended the run, and a HarnessStartError
            # has to reach main() as itself so the supervisor sees the
            # deterministic exit code.
            try:
                await self.diff_refresh.close(
                    timeout_seconds=self.DIFF_REFRESH_SHUTDOWN_TIMEOUT_SECONDS
                )
            except Exception as close_error:
                self.log.error("bridge.diff_refresh_close_failed", exc=close_error)
            if self.harness is not None:
                try:
                    await self.harness.close()
                except Exception as close_error:
                    self.log.error("bridge.harness_close_failed", exc=close_error)
            self.log.info(
                "bridge.run_complete",
                outcome=run_outcome,
                connection_count=self._connection_count,
                reconnect_count=max(0, self._connection_count - 1),
                reconnect_attempt_count=self._reconnect_attempt_count,
                total_connected_duration_seconds=round(self._total_connected_duration_seconds, 3),
            )

    def _mark_connected(self, *, now_monotonic: float | None = None) -> None:
        self._connection_count += 1
        self._connected_at_monotonic = time.monotonic() if now_monotonic is None else now_monotonic

    def _finalize_connection(
        self, *, now_monotonic: float | None = None
    ) -> dict[str, float | int] | None:
        if self._connected_at_monotonic is None:
            return None

        ended_at = time.monotonic() if now_monotonic is None else now_monotonic
        connection_duration_seconds = max(0.0, ended_at - self._connected_at_monotonic)
        self._connected_at_monotonic = None
        self._total_connected_duration_seconds += connection_duration_seconds

        return {
            "connection_duration_seconds": round(connection_duration_seconds, 3),
            "total_connected_duration_seconds": round(self._total_connected_duration_seconds, 3),
            "connection_count": self._connection_count,
            "reconnect_count": max(0, self._connection_count - 1),
            "reconnect_attempt_count": self._reconnect_attempt_count,
        }

    def _log_disconnect(
        self,
        *,
        reason: str,
        level: str = "info",
        **fields: Any,
    ) -> None:
        connection_fields = self._finalize_connection()
        if connection_fields is None:
            return
        log_method = getattr(self.log, level)
        log_method("bridge.disconnect", reason=reason, **connection_fields, **fields)

    def _is_fatal_connection_error(self, error_str: str) -> bool:
        """Check if a connection error is fatal and shouldn't trigger retry.

        Fatal errors indicate the session is invalid or terminated, not a
        transient network issue. These include:
        - HTTP 401 (Unauthorized): Auth token invalid or expired
        - HTTP 403 (Forbidden): Access denied
        - HTTP 404 (Not Found): Session doesn't exist
        - HTTP 410 (Gone): Session terminated, sandbox stopped/stale

        For these errors, retrying is futile - the bridge should exit and
        allow the control plane to spawn a new sandbox if needed.
        """
        fatal_patterns = [
            "HTTP 401",  # Unauthorized
            "HTTP 403",  # Forbidden
            "HTTP 404",  # Session not found
            "HTTP 410",  # Session terminated (stopped/stale)
        ]
        return any(pattern in error_str for pattern in fatal_patterns)

    async def _connect_and_run(self) -> None:
        """Connect to control plane and handle messages.

        Raises:
            SessionTerminatedError: If the control plane rejects the connection
                with HTTP 410 (session stopped/stale).
        """
        additional_headers = {
            "Authorization": f"Bearer {self.auth_token}",
            "X-Sandbox-ID": self.sandbox_id,
        }

        try:
            async with websockets.connect(
                self.ws_url,
                additional_headers=additional_headers,
                ping_interval=20,
                ping_timeout=10,
            ) as ws:
                if self.shutdown_event.is_set():
                    # The run ended while this handshake was in flight (a
                    # failed harness attach, for one). The socket was never
                    # ours to hand to the forwarder, and a quiet control
                    # plane would leave the receive loop below waiting for a
                    # message that never comes.
                    self.log.info("bridge.connect_abandoned", reason="shutdown_requested")
                    return
                self.ws = ws
                self._mark_connected()
                heartbeat_task: asyncio.Task[None] | None = None
                background_tasks: set[asyncio.Task[None]] = set()

                try:
                    self.log.info(
                        "bridge.connect",
                        outcome="success",
                        connection_count=self._connection_count,
                        reconnect_count=max(0, self._connection_count - 1),
                        reconnect_attempt_count=self._reconnect_attempt_count,
                    )
                    await self.event_forwarder.bind(ws)
                    if self._boot_ready.is_set():
                        # On every (re)connect: the control plane's ready
                        # transition is idempotent, and a row that lost its
                        # socket mid-boot learns readiness from this resend.
                        await self._send_event(self._build_ready_event())
                    elif self.early_connect:
                        # Still booting: the latest phase (or `starting`), once,
                        # never buffered — a replay of older phases would only
                        # be stale, and the control plane de-duplicates on seq.
                        await self.event_forwarder.send(
                            self.boot_relay.latest_phase_event(), buffered=False
                        )

                    heartbeat_task = asyncio.create_task(self._heartbeat_loop())
                    async for message in ws:
                        if self.shutdown_event.is_set():
                            break

                        try:
                            cmd = json.loads(message)
                            task = await self._handle_command(cmd)
                            if task:
                                background_tasks.add(task)
                                task.add_done_callback(background_tasks.discard)
                        except json.JSONDecodeError as e:
                            self.log.warn("bridge.invalid_message", exc=e)
                        except Exception as e:
                            self.log.error("bridge.command_error", exc=e)

                except websockets.ConnectionClosed as e:
                    self._log_disconnect(
                        reason="connection_closed",
                        level="warn",
                        ws_close_code=e.code,
                    )
                    raise

                finally:
                    if heartbeat_task is not None:
                        heartbeat_task.cancel()
                    for task in background_tasks:
                        task.cancel()
                    self.ws = None
                    self.event_forwarder.unbind()
                    if self._connected_at_monotonic is not None:
                        close_code = getattr(ws, "close_code", None)
                        reason = (
                            "shutdown_requested"
                            if self.shutdown_event.is_set()
                            else "connection_closed"
                        )
                        level = "warn" if close_code not in (None, 1000, 1001) else "info"
                        extra_fields = (
                            {"ws_close_code": close_code} if close_code is not None else {}
                        )
                        self._log_disconnect(reason=reason, level=level, **extra_fields)

        except InvalidStatus as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status in (401, 403, 404, 410):
                raise SessionTerminatedError(
                    f"Session rejected by control plane (HTTP {status})."
                ) from e
            raise

    def _heartbeat_event(self) -> dict[str, Any]:
        return {
            "type": "heartbeat",
            "sandboxId": self.sandbox_id,
            "status": "ready" if self._boot_ready.is_set() else "booting",
            "timestamp": time.time(),
        }

    async def _heartbeat_loop(self) -> None:
        """Send periodic heartbeat events."""
        while not self.shutdown_event.is_set():
            await asyncio.sleep(self.HEARTBEAT_INTERVAL)

            if self.ws and self.ws.state == State.OPEN:
                await self._send_event(self._heartbeat_event())

    async def _relay_boot_events(self) -> None:
        """Tail the supervisor's boot-events file until the harness phase completes.

        Each warning line is forwarded as a `warning` event, over an open
        socket or not at all: an undelivered one is held for the next pass.
        In early-connect mode each phase line is forwarded as `boot_progress`,
        unbuffered, and the `harness completed` line triggers the harness
        attach; in classic mode the bridge only starts after boot, so phases
        are already history and only warnings are relayed.
        """
        try:
            while not self.shutdown_event.is_set():
                await self._relay_boot_events_once()
                if self.boot_relay.harness_completed:
                    await self._buffer_held_boot_events()
                    return
                await asyncio.sleep(self.BOOT_EVENTS_POLL_SECONDS)
        except asyncio.CancelledError:
            raise
        except HarnessStartError as error:
            self._attach_failure = error
            await self._end_run("harness_start_failed")
        except GitSigningError as error:
            # Non-retryable signing configuration: the same graceful exit the
            # pre-connect path takes, so the supervisor does not restart us.
            self.log.error("bridge.signing_init_failed", exc=error)
            await self._end_run("fatal_error")
        except Exception as error:
            self.log.error("bridge.harness_attach_failed", exc=error)
            self._attach_failure = error
            await self._end_run("harness_attach_failed")

    async def _end_run(self, outcome: str) -> None:
        """End the run loop from outside it.

        The receive loop only re-checks ``shutdown_event`` when a message
        arrives, and a quiet control plane sends none, so the open socket is
        closed as well: the loop then ends and ``run()`` exits with this
        outcome, re-raising the recorded attach failure if there is one.
        """
        self._attach_outcome = outcome
        self.shutdown_event.set()
        ws = self.ws
        if ws is not None:
            with contextlib.suppress(Exception):
                await ws.close()

    async def _relay_boot_events_once(self) -> None:
        """One pass over new boot-events lines (see ``_relay_boot_events``).

        Lines held by an earlier pass are retried first, so the file is the
        queue of what this boot still owes the control plane and no warning
        waits on a buffer the cursor cannot see. A warning goes out over an
        open socket or is held again; a line the wire has no shape for, and a
        phase, are done with either way — a phase is never replayed from the
        file, a reconnect resends the latest one instead.

        The cursor advances only while nothing is held, so it never passes a
        warning this bridge has not delivered and its successor picks that
        warning up. Delivery is therefore at least once: a line sent just
        before the process dies is relayed again by the next bridge.
        """
        lines = self._held_boot_lines + self.boot_relay.read_new_lines()
        self._held_boot_lines = []
        relayed_through: int | None = None
        for line in lines:
            event = BootEventRelay.to_event(line)
            if event is not None:
                if event["type"] == "warning":
                    if not await self.event_forwarder.send(event, buffered=False):
                        self._held_boot_lines.append(line)
                elif self.early_connect and not self._boot_ready.is_set():
                    await self.event_forwarder.send(event, buffered=False)
            if not self._held_boot_lines:
                relayed_through = line["seq"]
        if relayed_through is not None:
            self.boot_relay.mark_relayed(relayed_through)
        if self.early_connect and self.boot_relay.harness_completed and self.harness is None:
            await self._attach_harness()

    async def _buffer_held_boot_events(self) -> None:
        """Hand still-undelivered boot events to the event buffer at the end of boot.

        The relay stops polling once the harness attaches, so nothing would
        retry them; the buffer outlives it and flushes on the next connect.
        The cursor stays behind them, as it does for any undelivered line.
        """
        held, self._held_boot_lines = self._held_boot_lines, []
        for line in held:
            event = BootEventRelay.to_event(line)
            if event is not None:
                await self._send_event(event)

    async def _attach_harness(self) -> None:
        """Build, open and resume the harness, then report `ready`.

        Exactly the classic pre-connect sequence, run once the supervisor has
        the vendor up and the repositories on disk: the session probe needs
        OpenCode listening (probing earlier reads as "session gone" and the
        first prompt would start a fresh conversation), and signing needs
        the checkouts.
        """
        harness = self._harness_factory()
        await self._open_harness(harness)
        try:
            await self._load_session_id(harness)
            await self._initialize_signing_for_attach()
        except BaseException:
            # Whatever open() acquired is released here; the harness never
            # became the bridge's, so run()'s cleanup will not see it.
            with contextlib.suppress(Exception):
                await harness.close()
            raise
        self.harness = harness
        await self._send_event(self._build_ready_event())
        self._boot_ready.set()
        self.log.info("bridge.harness_attached", harness=harness.id.value)

    async def _open_harness(self, harness: AgentHarness) -> None:
        try:
            await harness.open()
        except HarnessStartError as error:
            self._record_fatal_error(str(error))
            self.log.error("bridge.harness_open_failed", exc=error, harness=harness.id.value)
            raise

    async def _initialize_signing_for_attach(self) -> None:
        """Signing initialization with the connect loop's retry policy."""
        attempt = 0
        while True:
            try:
                await self.git_signing.initialize(None)
                return
            except GitSigningError as error:
                if not error.retryable:
                    raise
                attempt += 1
                delay = min(self.RECONNECT_BACKOFF_BASE**attempt, self.RECONNECT_MAX_DELAY)
                self.log.warn("bridge.signing_init_retry", attempt=attempt, delay_s=delay)
                await asyncio.sleep(delay)

    async def _send_media_warning(self, message: str) -> None:
        """Surface non-fatal media handling failures to the user timeline."""
        await self._send_event({"type": "warning", "scope": "media", "message": message})

    async def _send_event(self, event: dict[str, Any]) -> bool:
        """Send event to control plane, buffering if WS is unavailable.

        Returns whether it reached an open connection (see the forwarder).
        """
        return await self.event_forwarder.send(event)

    async def _handle_command(self, cmd: dict[str, Any]) -> asyncio.Task[None] | None:
        """Handle command from control plane.

        Long-running commands (like prompt) are run as background tasks to keep
        the WebSocket listener responsive to other commands (like push).

        Returns a Task for long-running commands, None for immediate commands.
        """
        cmd_type = cmd.get("type")
        self.log.debug("bridge.command_received", cmd_type=cmd_type)
        booting = not self._boot_ready.is_set()

        if cmd_type == "prompt":
            message_id = cmd.get("messageId") or cmd.get("message_id", "unknown")
            self.diff_refresh.prompt_started()
            task = asyncio.create_task(self._handle_prompt(cmd))
            self._current_prompt_task = task

            def handle_task_exception(t: asyncio.Task[None], mid: str = message_id) -> None:
                # Release the diff worker's idle gate before any refresh request
                # below so the refresh can start immediately.
                self.diff_refresh.prompt_finished()
                if self._current_prompt_task is t:
                    self._current_prompt_task = None
                if t.cancelled():
                    asyncio.create_task(
                        self._send_terminal_event_and_refresh(
                            {
                                "type": "execution_complete",
                                "messageId": mid,
                                "success": False,
                                "error": "Task was cancelled",
                            }
                        )
                    )
                elif exc := t.exception():
                    asyncio.create_task(
                        self._send_terminal_event_and_refresh(
                            {
                                "type": "execution_complete",
                                "messageId": mid,
                                "success": False,
                                "error": str(exc),
                            }
                        )
                    )
                else:
                    self.diff_refresh.request(mid)

            task.add_done_callback(handle_task_exception)
            # Don't return the task — prompt tasks must survive WS disconnects.
            # Returning it would add it to background_tasks, which gets cancelled
            # in the _connect_and_run finally block on WS close.
            return None
        elif cmd_type == "stop":
            await self._handle_stop()
        elif cmd_type == "snapshot":
            if booting:
                # A half-booted filesystem is not a snapshot; and the reply
                # shape has no failure form, so the command is dropped rather
                # than answered with something the control plane would trust.
                self.log.warn("bridge.command_refused_while_booting", cmd_type=cmd_type)
            else:
                await self._handle_snapshot()
        elif cmd_type == "shutdown":
            await self._handle_shutdown()
        elif cmd_type == "git_sync_complete":
            self.git_sync_complete.set()
        elif cmd_type == "push":
            if booting:
                await self._refuse_push_while_booting(cmd)
            else:
                await self._handle_push(cmd)
        elif cmd_type == "refresh_diff":
            if booting:
                self.log.warn("bridge.command_refused_while_booting", cmd_type=cmd_type)
            else:
                self.diff_refresh.request(None)
        elif cmd_type == "ack":
            ack_id = cmd.get("ackId")
            if ack_id and self.event_forwarder.acknowledge(ack_id):
                self.log.debug("bridge.ack_received", ack_id=ack_id)
        else:
            self.log.debug("bridge.unknown_command", cmd_type=cmd_type)
        return None

    async def _send_terminal_event_and_refresh(self, event: dict[str, Any]) -> None:
        await self._send_event(event)
        self.diff_refresh.request(str(event.get("messageId") or "") or None)

    async def _handle_prompt(self, cmd: dict[str, Any]) -> None:
        """Handle prompt command - run the turn through the harness and terminalise it."""
        message_id = cmd.get("messageId") or cmd.get("message_id", "unknown")
        content = cmd.get("content", "")
        model = cmd.get("model")
        reasoning_effort = cmd.get("reasoningEffort")
        raw_attachments = cmd.get("attachments")
        author_data = cmd.get("author", {})
        start_time = time.time()
        outcome = "success"
        message_cost_usd: float | None = None
        had_error = False
        error_message = None

        self.log.info(
            "prompt.start",
            message_id=message_id,
            model=model,
            reasoning_effort=reasoning_effort,
        )

        # One deadline for the whole prompt, set at receipt: the wait for a
        # booting sandbox, the preflight and the turn itself all spend it,
        # so no prompt can outlive the configured maximum and eat the
        # snapshot reserve.
        turn_deadline = asyncio.get_running_loop().time() + (
            self.prompt_limits.prompt_max_duration_seconds
        )

        try:
            harness, attachments = await self._prepare_turn(
                message_id, author_data, raw_attachments, turn_deadline
            )

            emitted_output = False

            async def emit(event: dict[str, Any]) -> None:
                nonlocal emitted_output, message_cost_usd
                if event.get("type") == "execution_complete":
                    raise RuntimeError("harness must not emit execution_complete")
                if event.get("type") in ("token", "tool_call", "step_finish"):
                    emitted_output = True
                # A cancelled turn never returns an outcome, so the last cost
                # report is the only figure execution_complete can carry then.
                # When an outcome does arrive it is authoritative (below).
                if event.get("type") == "step_finish" and "messageCostUsd" in event:
                    message_cost_usd = event["messageCostUsd"]
                await self._send_event(event)

            turn: TurnOutcome = await harness.run_prompt(
                HarnessPrompt(
                    message_id=message_id,
                    text=content,
                    model=model,
                    reasoning_effort=reasoning_effort,
                    attachments=tuple(attachments or ()),
                    author=author_data if isinstance(author_data, dict) else {},
                    max_duration_seconds=max(
                        turn_deadline - asyncio.get_running_loop().time(), 0.0
                    ),
                ),
                emit,
            )
            await self._persist_rotated_session_id(harness)
            # The outcome is authoritative for cost and success once it
            # exists; the bridge adds only the no-output guard below.
            if turn.message_cost_usd is not None:
                message_cost_usd = turn.message_cost_usd
            if not turn.success:
                had_error = True
                error_message = turn.error or "Unknown error"
            if turn.cancelled:
                raise asyncio.CancelledError

            if not had_error and not emitted_output:
                had_error = True
                error_message = "The agent completed without emitting assistant output."
                self.log.error(
                    "prompt.no_output",
                    message_id=message_id,
                    model=model,
                    reasoning_effort=reasoning_effort,
                )

            if had_error:
                outcome = "error"

        except asyncio.CancelledError:
            # This top-level command boundary settles cancellation just like
            # other prompt failures, while the turn's cost is still available.
            # The done callback remains a fallback for cancellation before start.
            outcome = "cancelled"
            had_error = True
            error_message = "Task was cancelled"
        except Exception as e:
            outcome = "error"
            had_error = True
            error_message = str(e)
            self.log.error("prompt.error", exc=e, message_id=message_id)
        finally:
            duration_ms = int((time.time() - start_time) * 1000)
            self.log.info(
                "prompt.run",
                message_id=message_id,
                model=model,
                reasoning_effort=reasoning_effort,
                outcome=outcome,
                duration_ms=duration_ms,
            )

        await self._send_event(
            {
                "type": "execution_complete",
                "messageId": message_id,
                "success": not had_error,
                **({"error": error_message} if error_message else {}),
                **({"messageCostUsd": message_cost_usd} if message_cost_usd is not None else {}),
            }
        )

    async def _prepare_turn(
        self,
        message_id: str,
        author_data: Any,
        raw_attachments: Any,
        deadline: float,
    ) -> tuple[AgentHarness, list[HydratedSessionAttachment] | None]:
        """The harness and hydrated attachments a turn needs, within the prompt's deadline.

        Everything before the turn spends the prompt's own budget: the wait
        for a booting sandbox, the git identity, the vendor session and the
        attachment downloads. A prompt whose deadline passes here fails the
        way a turn that never finishes would, and `stop` cancels it like any
        running turn.
        """
        try:
            async with asyncio.timeout_at(deadline):
                if not self._boot_ready.is_set():
                    self.log.info(
                        "prompt.held_until_ready",
                        message_id=message_id,
                        timeout_s=max(deadline - asyncio.get_running_loop().time(), 0.0),
                    )
                    await self._boot_ready.wait()
                harness = self._require_harness()
                await self._configure_git_identity(parse_prompt_git_author(author_data))
                await self._ensure_agent_session(harness)
                session_attachments, rejected_attachments = parse_session_image_attachments(
                    raw_attachments
                )
                if rejected_attachments:
                    self.log.warn(
                        "prompt.invalid_attachments",
                        message_id=message_id,
                        rejected_count=rejected_attachments,
                    )
                    await self._send_media_warning(
                        f"{rejected_attachments} invalid attachment(s) were skipped."
                    )
                attachments = await self.attachment_processor.process(session_attachments)
        except TimeoutError:
            budget = int(self.prompt_limits.prompt_max_duration_seconds)
            if not self._boot_ready.is_set():
                raise RuntimeError(f"sandbox did not become ready within {budget} s") from None
            raise RuntimeError(f"prompt could not start within {budget} s") from None
        return harness, attachments

    async def _ensure_agent_session(self, harness: AgentHarness | None = None) -> None:
        """Create the vendor session on first use and persist its id."""
        harness = harness if harness is not None else self._require_harness()
        if harness.session_id:
            return
        await harness.create_session()
        await self._save_session_id(harness)

    async def _handle_stop(self) -> None:
        """Handle stop command - cancel prompt task and ask the harness to abort."""
        self.log.info("bridge.stop")
        task = self._current_prompt_task
        if task and not task.done():
            task.cancel()
        # Best-effort: also tell the agent to stop (saves LLM compute cost)
        if self.harness is not None:
            await self.harness.abort()

    async def _handle_snapshot(self) -> None:
        """Handle snapshot command - prepare for snapshot."""
        self.log.info("bridge.snapshot_prepare")
        await self._send_event(
            {
                "type": "snapshot_ready",
                "opencodeSessionId": self.agent_session_id,
            }
        )

    async def _handle_shutdown(self) -> None:
        """Handle shutdown command - graceful shutdown."""
        self.log.info("bridge.shutdown_requested")
        if self._current_prompt_task and not self._current_prompt_task.done():
            self._current_prompt_task.cancel()
        self.shutdown_event.set()

    async def _refuse_push_while_booting(self, cmd: dict[str, Any]) -> None:
        """Answer a push that arrived before the repositories exist.

        A reply keeps the control plane's pending push from waiting out its
        timeout; the spec is parsed only for the correlation fields.
        """
        try:
            request: PushRequest | None = PushRequest.from_push_spec(cmd.get("pushSpec"))
        except PushRejected as rejected:
            request = rejected.request
        self.log.warn("bridge.command_refused_while_booting", cmd_type="push")
        await self._send_event(
            {
                "type": "push_error",
                "error": "Push failed - the sandbox is still booting",
                "branchName": request.branch_name if request is not None else "",
                **(request.repo_fields() if request is not None else {}),
                "timestamp": time.time(),
            }
        )

    async def _handle_push(self, cmd: dict[str, Any]) -> None:
        """Execute locally, then emit exactly one timestamped result event."""
        result = await PushOperation(
            repo_path=self.repo_path,
            manifest_path=self.repo_manifest_path,
            logger=self.log,
        ).execute(cmd.get("pushSpec"))
        await self._send_event(
            {
                "type": "push_error" if result.error is not None else "push_complete",
                **({"error": result.error} if result.error is not None else {}),
                # Even an empty branch resolves the control plane's pending push.
                "branchName": result.request.branch_name,
                **result.request.repo_fields(),
                "timestamp": time.time(),
            }
        )

    async def _configure_git_identity(self, user: GitUser | None) -> None:
        """Refresh signing state and configure prompt-scoped author identity."""
        await self.git_signing.refresh(user)

    def _read_persisted_session_id(self) -> str | None:
        for path in (self.session_id_file, self.legacy_session_id_file):
            if not path.exists():
                continue
            persisted = path.read_text().strip()
            if persisted:
                return persisted
        return None

    async def _load_session_id(self, harness: AgentHarness | None = None) -> None:
        """Resume the persisted vendor session, if any, through the harness.

        Startup only resumes. A missing or invalid id leaves the harness
        without a session and the first prompt creates one, as it always has;
        startup never replaces a conversation as a side effect of loading it.
        """
        harness = harness if harness is not None else self._require_harness()
        try:
            persisted = self._read_persisted_session_id()
        except Exception as e:
            self.log.error("agent.session.load_error", exc=e)
            return
        if not persisted:
            return
        try:
            resumed = await harness.resume_session(persisted)
        except Exception as e:
            self.log.error("agent.session.load_error", exc=e)
            return
        if resumed:
            await self._save_session_id(harness)

    async def _persist_rotated_session_id(self, harness: AgentHarness) -> None:
        """A conversation reset rotates the vendor id mid-connection; keep the file current."""
        try:
            persisted = self._read_persisted_session_id()
        except Exception as e:
            self.log.error("agent.session.load_error", exc=e)
            return
        if harness.session_id and harness.session_id != persisted:
            await self._save_session_id(harness)

    async def _save_session_id(self, harness: AgentHarness | None = None) -> None:
        """Persist the vendor session id so a snapshot restore can resume it."""
        harness = harness if harness is not None else self._require_harness()
        session_id = harness.session_id
        if session_id:
            try:
                self.session_id_file.write_text(session_id)
            except Exception as e:
                self.log.error("agent.session.save_error", exc=e)

    @staticmethod
    def _record_fatal_error(message: str) -> None:
        """Leave the deterministic-failure cause where the supervisor reports it from."""
        with contextlib.suppress(Exception):
            Path(BRIDGE_FATAL_ERROR_FILE_PATH).write_text(message)


async def main() -> None:
    """Entry point for bridge process."""
    parser = argparse.ArgumentParser(description="Open-Inspect Agent Bridge")
    parser.add_argument("--sandbox-id", required=True, help="Sandbox ID")
    parser.add_argument("--session-id", required=True, help="Session ID for WebSocket connection")
    parser.add_argument("--control-plane", required=True, help="Control plane URL")
    parser.add_argument("--token", required=True, help="Auth token")
    parser.add_argument("--opencode-port", type=int, default=4096, help="OpenCode port")
    parser.add_argument(
        "--harness",
        default=DEFAULT_HARNESS_ID.value,
        help="Agent harness id",
    )
    parser.add_argument(
        "--early-connect",
        action="store_true",
        help="Connect before the repository boots; attach the harness when the supervisor reports it up",
    )

    args = parser.parse_args()

    bridge = AgentBridge(
        sandbox_id=args.sandbox_id,
        session_id=args.session_id,
        control_plane_url=args.control_plane,
        auth_token=args.token,
        opencode_port=args.opencode_port,
        harness_id=parse_harness_id(args.harness),
        early_connect=args.early_connect,
    )

    try:
        await bridge.run()
    except HarnessStartError:
        # The cause is already recorded for the supervisor; this exit code
        # tells it not to spend its restart budget.
        sys.exit(DETERMINISTIC_FAILURE_EXIT_CODE)


if __name__ == "__main__":
    asyncio.run(main())

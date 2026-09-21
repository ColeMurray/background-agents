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
import math
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

import websockets
from websockets import ClientConnection, State
from websockets.exceptions import InvalidStatus

from .activity_supervisor import ActivitySupervisor
from .attachment_processor import (
    AttachmentProcessor,
    parse_session_image_attachments,
)
from .boot_attach import RECONNECT_BACKOFF_BASE, RECONNECT_MAX_DELAY_SECONDS, BootAttach
from .constants import (
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
from .shutdown_preparation import ShutdownPreparationCoordinator
from .types import GitUser

if TYPE_CHECKING:
    from collections.abc import Callable

    from .attachment_processor import HydratedSessionAttachment

configure_logging()

MAX_SAFE_GENERATION_CREATED_AT = 9_007_199_254_740_991


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
    RECONNECT_BACKOFF_BASE = RECONNECT_BACKOFF_BASE
    RECONNECT_MAX_DELAY_SECONDS = RECONNECT_MAX_DELAY_SECONDS
    DIFF_REFRESH_SHUTDOWN_TIMEOUT_SECONDS = 5.0

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

        self.prompt_limits = resolve_prompt_limits(self.log, harness_id)

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

        # BootAttach decides when this factory can safely read handoffs and
        # probe the vendor server. Transport can start without either.
        self._harness_id = harness_id
        build_harness: Callable[[], AgentHarness] = (
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
        self.shutdown_preparation = ShutdownPreparationCoordinator()
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
        self.boot_attach = BootAttach(
            early_connect=early_connect,
            harness=harness,
            harness_factory=build_harness,
            git_signing=self.git_signing,
            event_forwarder=self.event_forwarder,
            shutdown_event=self.shutdown_event,
            log=self.log,
            load_session_id=lambda harness: self._load_session_id(harness),
            build_ready_event=self._build_ready_event,
            send_event=lambda event: self._send_event(event),
            end_run=self._end_run,
            record_fatal_error=self._record_fatal_error,
        )
        self.activity = ActivitySupervisor(
            send_event=lambda event: self._send_event(event),
            prompt_finished=lambda: self.diff_refresh.prompt_finished(),
            refresh_diff=lambda message_id: self.diff_refresh.request(message_id),
            log=self.log,
        )

        self._connected_at_monotonic: float | None = None
        self._connection_count = 0
        self._reconnect_attempt_count = 0
        self._total_connected_duration_seconds = 0.0

    @property
    def harness(self) -> AgentHarness | None:
        return self.boot_attach.harness

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
            "preservationProtocolVersion": 1,
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
            "bridge.run_start",
            harness=self._harness_id.value,
            early_connect=self.boot_attach.early_connect,
        )
        reconnect_attempts = 0
        run_outcome = "harness_start_failed"

        # One lifecycle: whatever the harness acquires in open() is released
        # in the finally below, whether startup, session loading or the run
        # loop is what ends the bridge.
        try:
            await self.boot_attach.start()
            run_outcome = "shutdown"
            while not self.shutdown_event.is_set():
                run_outcome = "shutdown"
                try:
                    await self.boot_attach.before_connect()
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
                    if isinstance(e, GitSigningError) and not e.retryable:
                        if self.shutdown_event.is_set():
                            break
                        run_outcome = "fatal_error"
                        self._record_fatal_error(error_str)
                        raise
                    # Check for fatal HTTP errors that shouldn't trigger retry
                    if self._is_fatal_connection_error(error_str):
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
                    self.RECONNECT_MAX_DELAY_SECONDS,
                )
                self.log.info(
                    "bridge.reconnect",
                    attempt=reconnect_attempts,
                    reconnect_attempt_count=self._reconnect_attempt_count,
                    delay_s=round(delay, 1),
                )
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self.shutdown_event.wait(), timeout=delay)

            if self.boot_attach.outcome is not None:
                run_outcome = self.boot_attach.outcome
            if self.boot_attach.failure is not None:
                raise self.boot_attach.failure

        finally:
            await self.boot_attach.stop()
            await self.activity.shutdown()
            # Cleanup failures are logged, never raised: an exception here
            # would replace the one that ended the run, and a deterministic
            # startup failure has to reach main() so the supervisor sees its
            # dedicated exit code.
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
                    await self.boot_attach.on_connect()

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
            "status": "booting" if self.boot_attach.booting else "ready",
            "timestamp": time.time(),
        }

    async def _heartbeat_loop(self) -> None:
        """Send periodic heartbeat events."""
        while not self.shutdown_event.is_set():
            await asyncio.sleep(self.HEARTBEAT_INTERVAL)

            if self.ws and self.ws.state == State.OPEN:
                await self._send_event(self._heartbeat_event())

    async def _end_run(self) -> None:
        """End the run loop from outside it.

        The receive loop only re-checks ``shutdown_event`` when a message
        arrives, and a quiet control plane sends none, so the open socket is
        closed as well. The coordinator retains the outcome and any attach
        failure for ``run()`` to report.
        """
        self.shutdown_event.set()
        ws = self.ws
        if ws is not None:
            with contextlib.suppress(Exception):
                await ws.close()

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
        if await self.boot_attach.handle_command(cmd):
            return None

        if cmd_type == "prompt":
            message_id = cmd.get("messageId") or cmd.get("message_id", "unknown")
            if self.shutdown_preparation.fenced:
                await self._send_event(
                    {
                        "type": "execution_complete",
                        "messageId": message_id,
                        "success": False,
                        "error": "sandbox_lifetime_expiring",
                    }
                )
                return None
            self.diff_refresh.prompt_started()
            self.activity.start_prompt(message_id, lambda: self._handle_prompt(cmd))
            # Don't return the task — prompt tasks must survive WS disconnects.
            # Returning it would add it to background_tasks, which gets cancelled
            # in the _connect_and_run finally block on WS close.
            return None
        elif cmd_type == "stop":
            await self._handle_stop()
        elif cmd_type == "snapshot":
            await self._handle_snapshot()
        elif cmd_type == "sandbox_generation":
            await self._handle_sandbox_generation(cmd)
        elif cmd_type == "prepare_preservation":
            await self._handle_prepare_shutdown(cmd)
        elif cmd_type == "shutdown":
            await self._handle_shutdown()
        elif cmd_type == "git_sync_complete":
            self.git_sync_complete.set()
        elif cmd_type == "push":
            if self.shutdown_preparation.fenced:
                await self._refuse_push_for_shutdown(cmd)
            else:
                self._start_push(cmd)
        elif cmd_type == "refresh_diff":
            if self.shutdown_preparation.fenced:
                self.log.warn("bridge.command_refused_for_preservation", cmd_type=cmd_type)
            else:
                self.diff_refresh.request(None)
        elif cmd_type == "ack":
            ack_id = cmd.get("ackId")
            if ack_id and self.event_forwarder.acknowledge(ack_id):
                self.log.debug("bridge.ack_received", ack_id=ack_id)
        else:
            self.log.debug("bridge.unknown_command", cmd_type=cmd_type)
        return None

    async def _handle_prompt(self, cmd: dict[str, Any]) -> dict[str, Any]:
        """Run a harness turn and return its terminal-event candidate."""
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

        return {
            "type": "execution_complete",
            "messageId": message_id,
            "success": not had_error,
            **({"error": error_message} if error_message else {}),
            **({"messageCostUsd": message_cost_usd} if message_cost_usd is not None else {}),
        }

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
            if self.shutdown_preparation.fenced:
                raise RuntimeError("sandbox_lifetime_expiring")
            async with asyncio.timeout_at(deadline):
                await self.boot_attach.wait_until_ready(message_id, deadline)
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
            if self.boot_attach.booting:
                raise RuntimeError(f"sandbox did not become ready within {budget} s") from None
            raise RuntimeError(f"prompt could not start within {budget} s") from None
        if self.shutdown_preparation.fenced:
            raise RuntimeError("sandbox_lifetime_expiring")
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
        self.activity.interrupt_prompt("Task was cancelled")
        # Best-effort: also tell the agent to stop (saves LLM compute cost)
        if self.harness is not None:
            await self.harness.abort()

    @staticmethod
    def _parse_generation(value: Any) -> dict[str, Any] | None:
        if not isinstance(value, dict):
            return None
        sandbox_id = value.get("sandboxId")
        created_at = value.get("createdAt")
        if not isinstance(sandbox_id, str) or not sandbox_id:
            return None
        if isinstance(created_at, bool) or not isinstance(created_at, (int, float)):
            return None
        if isinstance(created_at, int):
            valid_created_at = 0 < created_at <= MAX_SAFE_GENERATION_CREATED_AT
        else:
            valid_created_at = (
                math.isfinite(created_at)
                and created_at.is_integer()
                and 0 < created_at <= MAX_SAFE_GENERATION_CREATED_AT
            )
        if not valid_created_at:
            return None
        return {"sandboxId": sandbox_id, "createdAt": int(created_at)}

    async def _handle_sandbox_generation(self, cmd: dict[str, Any]) -> None:
        """Establish or advance the authenticated retained-runtime generation."""
        generation = self._parse_generation(cmd.get("generation"))
        if generation is None or generation["sandboxId"] != self.sandbox_id:
            self.log.warn("bridge.sandbox_generation_invalid")
            return
        await self._send_event(self.shutdown_preparation.establish_generation(generation))

    async def _handle_prepare_shutdown(self, cmd: dict[str, Any]) -> None:
        """Fence admission and confirm the active harness execution stopped."""
        generation = self._parse_generation(cmd.get("generation"))
        if generation is None:
            self.log.warn("bridge.preservation_generation_invalid")
            return

        async def contain_activity(deadline: float) -> bool:
            harness = self._require_harness()
            return await self.activity.drain_for_shutdown(
                deadline=deadline,
                prompt_error="sandbox_lifetime_expiring",
                push_cancellation_event=self._shutdown_push_error_event,
                stop_execution=harness.stop_execution,
            )

        async def persist_session() -> None:
            await self._persist_rotated_session_id(self._require_harness(), strict=True)

        result = await self.shutdown_preparation.prepare(
            cmd,
            parsed_generation=generation,
            contain_activity=contain_activity,
            persist_session=persist_session,
            log=self.log,
        )
        if result is not None:
            await self._send_event(result)

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
        await self.boot_attach.stop()
        await self.activity.shutdown()
        await self.boot_attach.end_run("shutdown")

    async def _refuse_push_for_shutdown(self, cmd: dict[str, Any]) -> None:
        await self._send_event(self._shutdown_push_error_event(cmd))

    def _shutdown_push_error_event(self, cmd: dict[str, Any]) -> dict[str, Any]:
        try:
            request: PushRequest | None = PushRequest.from_push_spec(cmd.get("pushSpec"))
        except PushRejected as rejected:
            request = rejected.request
        return {
            "type": "push_error",
            "error": "Push failed — the sandbox is shutting down.",
            "branchName": request.branch_name if request is not None else "",
            **(request.repo_fields() if request is not None else {}),
            "timestamp": time.time(),
        }

    def _start_push(self, cmd: dict[str, Any]) -> None:
        async def execute() -> dict[str, Any]:
            if self.shutdown_preparation.fenced:
                return self._shutdown_push_error_event(cmd)
            return await self._handle_push(cmd)

        self.activity.start_push(cmd, execute)

    async def _handle_push(self, cmd: dict[str, Any]) -> dict[str, Any]:
        """Execute a local push and return its timestamped result candidate."""
        result = await PushOperation(
            repo_path=self.repo_path,
            manifest_path=self.repo_manifest_path,
            logger=self.log,
        ).execute(cmd.get("pushSpec"))
        return {
            "type": "push_error" if result.error is not None else "push_complete",
            **({"error": result.error} if result.error is not None else {}),
            # Even an empty branch resolves the control plane's pending push.
            "branchName": result.request.branch_name,
            **result.request.repo_fields(),
            "timestamp": time.time(),
        }

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

    async def _persist_rotated_session_id(
        self, harness: AgentHarness, *, strict: bool = False
    ) -> None:
        """A conversation reset rotates the vendor id mid-connection; keep the file current."""
        try:
            persisted = self._read_persisted_session_id()
        except Exception as e:
            self.log.error("agent.session.load_error", exc=e)
            if strict:
                raise
            return
        if harness.session_id and harness.session_id != persisted:
            await self._save_session_id(harness, strict=strict)

    async def _save_session_id(
        self, harness: AgentHarness | None = None, *, strict: bool = False
    ) -> None:
        """Persist the vendor session id so a snapshot restore can resume it."""
        harness = harness if harness is not None else self._require_harness()
        session_id = harness.session_id
        if session_id:
            try:
                self.session_id_file.write_text(session_id)
            except Exception as e:
                self.log.error("agent.session.save_error", exc=e)
                if strict:
                    raise

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
    except (HarnessStartError, GitSigningError):
        # The cause is already recorded for the supervisor; this exit code
        # tells it not to spend its restart budget.
        sys.exit(DETERMINISTIC_FAILURE_EXIT_CODE)


if __name__ == "__main__":
    asyncio.run(main())

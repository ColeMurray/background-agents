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
"""

import argparse
import asyncio
import contextlib
import json
import math
import os
import sys
import tempfile
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import websockets
from websockets import ClientConnection, State
from websockets.exceptions import InvalidStatus

from .attachment_processor import (
    AttachmentProcessor,
    parse_session_image_attachments,
)
from .constants import (
    BOOT_WARNINGS_FILE_PATH,
    BRIDGE_FATAL_ERROR_FILE_PATH,
    DEFAULT_SANDBOX_TIMEOUT_SECONDS,
    MAX_SNAPSHOT_RESERVE_SECONDS,
    REPO_MANIFEST_FILE_PATH,
    SANDBOX_TIMEOUT_ENV_VAR,
    SNAPSHOT_RESERVE_FRACTION,
)
from .diff_capture import ControlPlaneDiffClient, SessionDiffRefreshWorker
from .event_forwarder import SEND_TIMEOUT_SECONDS, BufferedEventForwarder
from .git_signing import GitSigningError, GitSigningRuntime
from .harness import (
    DEFAULT_HARNESS_ID,
    DETERMINISTIC_FAILURE_EXIT_CODE,
    AgentHarness,
    BridgeIdentity,
    HarnessId,
    HarnessPrompt,
    HarnessStartError,
    PromptLimits,
    TurnOutcome,
    build_agent_harness,
    parse_harness_id,
)
from .hook_logs import prepare_hook_logs_for_snapshot
from .log_config import configure_logging, get_logger
from .push_operation import PushOperation
from .repo_config import load_repo_manifest
from .types import GitUser

configure_logging()

# Absolute wire deadlines assume synchronized clocks. Deduct a small allowance
# for ordinary skew; never reconstruct an already dispatched turn from duration.
DEADLINE_CLOCK_ALLOWANCE_SECONDS = 1.0
GRACEFUL_STOP_MAX_SECONDS = 5.0
MAX_COMPLETED_PROMPTS = 256


@dataclass
class _Execution:
    message_id: str
    deadline_monotonic: float
    cleanup_deadline_monotonic: float
    epoch_offset_seconds: float
    stop_reason: str | None = None
    work_started: bool = False
    harness_started: bool = False
    execution_stopped: bool = True
    terminal_event: dict[str, Any] | None = None
    observation_finished: asyncio.Event = field(default_factory=asyncio.Event)
    interrupt_request_uncertain: bool = False
    cleanup_started: bool = False

    def begin_cleanup(self, allowance_seconds: float) -> None:
        self.cleanup_started = True
        self.cleanup_deadline_monotonic = min(
            self.cleanup_deadline_monotonic,
            asyncio.get_running_loop().time() + allowance_seconds,
        )


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
    # OpenCode stream consumption responsiveness, including downstream delays.
    # Does not apply to Claude or establish useful model/tool progress.
    SSE_INACTIVITY_TIMEOUT = 300.0
    SSE_INACTIVITY_TIMEOUT_MIN = 5.0
    SSE_INACTIVITY_TIMEOUT_MAX = 3600.0
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

        inactivity_timeout_seconds = (
            self._resolve_timeout_seconds(
                name="BRIDGE_SSE_INACTIVITY_TIMEOUT",
                default=self.SSE_INACTIVITY_TIMEOUT,
                min_value=self.SSE_INACTIVITY_TIMEOUT_MIN,
                max_value=self.SSE_INACTIVITY_TIMEOUT_MAX,
            )
            if (harness.id if harness is not None else harness_id) == HarnessId.OPENCODE
            else self.SSE_INACTIVITY_TIMEOUT
        )
        sandbox_timeout_seconds = self._resolve_positive_timeout_seconds(
            name=SANDBOX_TIMEOUT_ENV_VAR,
            default=DEFAULT_SANDBOX_TIMEOUT_SECONDS,
        )
        snapshot_reserve_seconds = min(
            MAX_SNAPSHOT_RESERVE_SECONDS,
            sandbox_timeout_seconds * SNAPSHOT_RESERVE_FRACTION,
        )
        self.prompt_limits = PromptLimits(
            inactivity_timeout_seconds=inactivity_timeout_seconds,
            prompt_max_duration_seconds=sandbox_timeout_seconds - snapshot_reserve_seconds,
            prompt_cleanup_timeout_seconds=snapshot_reserve_seconds,
        )
        self.log.info(
            "bridge.prompt_timeout_config",
            timeout_ms=int(self.prompt_limits.prompt_max_duration_seconds * 1000),
            sandbox_timeout_ms=int(sandbox_timeout_seconds * 1000),
            snapshot_reserve_ms=int(snapshot_reserve_seconds * 1000),
        )

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
        # registry in production.
        self.harness: AgentHarness = harness or build_agent_harness(
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

        # Track the current prompt task so _handle_stop can cancel it
        self._current_prompt_task: asyncio.Task[None] | None = None
        self._current_stop_task: asyncio.Task[None] | None = None
        self._execution: _Execution | None = None
        self._quarantined = False
        self._completed_prompts: OrderedDict[str, dict[str, Any]] = OrderedDict()
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
        return self.harness.session_id

    @property
    def ws_url(self) -> str:
        """WebSocket URL for control plane connection."""
        url = self.control_plane_url.replace("https://", "wss://").replace("http://", "ws://")
        return f"{url}/sessions/{self.session_id}/ws?type=sandbox"

    def _build_ready_event(self) -> dict[str, Any]:
        repositories = load_repo_manifest(self.repo_manifest_path)
        # The image bakes SANDBOX_VERSION; reporting it lets the control plane
        # stamp snapshots with the runtime that produced them and retire the
        # ones a later compatibility floor rules out.
        runtime_version = os.environ.get("SANDBOX_VERSION", "")
        return {
            "type": "ready",
            "sandboxId": self.sandbox_id,
            "opencodeSessionId": self.agent_session_id,
            "harness": self.harness.id.value,
            "capabilities": [
                "execution-deadline-v1",
                "stop-confirmation-v1",
                "hook_logs_snapshot_v1",
            ],
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
        self.log.info("bridge.run_start", harness=self.harness.id.value)
        reconnect_attempts = 0
        run_outcome = "harness_start_failed"
        signing_initialized = False

        # One lifecycle: whatever the harness acquires in open() is released
        # in the finally below, whether startup, session loading or the run
        # loop is what ends the bridge.
        try:
            try:
                await self.harness.open()
            except HarnessStartError as error:
                self._record_fatal_error(str(error))
                self.log.error(
                    "bridge.harness_open_failed", exc=error, harness=self.harness.id.value
                )
                raise
            await self._load_session_id()
            run_outcome = "shutdown"
            while not self.shutdown_event.is_set():
                run_outcome = "shutdown"
                try:
                    if not signing_initialized:
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

        finally:
            # The prompt owns containment. Shutdown may tighten its allowance
            # but must not interrupt an already-running cleanup or grant a new one.
            close_deadline = (
                asyncio.get_running_loop().time()
                + self.prompt_limits.prompt_cleanup_timeout_seconds
            )
            if self._current_prompt_task and not self._current_prompt_task.done():
                await self._handle_stop({"reason": "Sandbox shutdown requested"})
                if self._execution is not None:
                    close_deadline = self._execution.cleanup_deadline_monotonic
                _, pending = await asyncio.wait(
                    {self._current_prompt_task},
                    timeout=max(0.0, close_deadline - asyncio.get_running_loop().time()),
                )
                if pending:
                    self._quarantined = True
                    self.log.warn("bridge.shutdown_execution_uncertain")
            elif self._execution is not None and self._execution.stop_reason is not None:
                close_deadline = self._execution.cleanup_deadline_monotonic
            # Cleanup failures are logged, never raised: an exception here
            # would replace the one that ended the run, and a HarnessStartError
            # has to reach main() as itself so the supervisor sees the
            # deterministic exit code.
            try:
                async with asyncio.timeout_at(close_deadline):
                    await self.diff_refresh.close(
                        timeout_seconds=min(
                            self.DIFF_REFRESH_SHUTDOWN_TIMEOUT_SECONDS,
                            max(0.0, close_deadline - asyncio.get_running_loop().time()),
                        )
                    )
            except Exception as close_error:
                self.log.error("bridge.diff_refresh_close_failed", exc=close_error)
            try:
                async with asyncio.timeout_at(close_deadline):
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
                    await self._send_event(self._build_ready_event())
                    await self._drain_boot_warnings()

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

    async def _heartbeat_loop(self) -> None:
        """Send periodic heartbeat events."""
        while not self.shutdown_event.is_set():
            await asyncio.sleep(self.HEARTBEAT_INTERVAL)

            if self.ws and self.ws.state == State.OPEN:
                await self._send_event(
                    {
                        "type": "heartbeat",
                        "sandboxId": self.sandbox_id,
                        "status": "ready",
                        "timestamp": time.time(),
                    }
                )

    async def _drain_boot_warnings(self) -> None:
        """Forward supervisor boot warnings queued before the bridge existed.

        The supervisor appends {scope, message, repoOwner?, repoName?} lines
        (see BOOT_WARNINGS_FILE_PATH); each becomes a `warning` sandbox event.
        The file is consumed exactly once — reconnects must not replay it.
        """
        path = Path(BOOT_WARNINGS_FILE_PATH)
        if not path.exists():
            return
        try:
            lines = path.read_text().splitlines()
            path.unlink(missing_ok=True)
        except Exception as e:
            self.log.warn("bridge.boot_warnings_read_failed", exc=e)
            return

        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(entry, dict) or not entry.get("message"):
                continue
            await self._send_event({"type": "warning", **entry})

    async def _send_media_warning(self, message: str) -> None:
        """Surface non-fatal media handling failures to the user timeline."""
        await self._send_event({"type": "warning", "scope": "media", "message": message})

    async def _send_event(self, event: dict[str, Any]) -> None:
        """Send event to control plane, buffering if WS is unavailable."""
        await self.event_forwarder.send(event)

    async def _handle_command(self, cmd: dict[str, Any]) -> asyncio.Task[None] | None:
        """Handle command from control plane.

        Long-running commands (like prompt) are run as background tasks to keep
        the WebSocket listener responsive to other commands (like push).

        Returns a Task for long-running commands, None for immediate commands.
        """
        cmd_type = cmd.get("type")
        self.log.debug("bridge.command_received", cmd_type=cmd_type)

        if cmd_type == "prompt":
            message_id = cmd.get("messageId") or cmd.get("message_id", "unknown")
            if cmd.get("sandboxId", self.sandbox_id) != self.sandbox_id:
                self.log.warn("prompt.stale_sandbox", message_id=message_id)
                return None
            if message_id in self._completed_prompts:
                return asyncio.create_task(
                    self._send_event(dict(self._completed_prompts[message_id]))
                )
            if (
                self._quarantined
                or (self._current_prompt_task is not None and not self._current_prompt_task.done())
                or (self._current_stop_task is not None and not self._current_stop_task.done())
            ):
                # Duplicate dispatch is idempotent. A different message never
                # bypasses the local reuse boundary, even after WS reconnect.
                self.log.warn("prompt.runtime_unavailable", message_id=message_id)
                return None
            self._execution = self._new_execution(cmd)
            execution = self._execution
            self.diff_refresh.prompt_started()
            task = asyncio.create_task(self._handle_prompt(cmd))
            self._current_prompt_task = task

            def handle_task_exception(t: asyncio.Task[None], mid: str = message_id) -> None:
                # An older callback cannot release a newer prompt's idle gate.
                if self._current_prompt_task is t:
                    self._current_prompt_task = None
                if t.cancelled() and execution.terminal_event is None:
                    # Cancellation before the coroutine's first instruction:
                    # no preparation or harness operation was started.
                    asyncio.create_task(
                        self._finish_execution(
                            execution,
                            success=False,
                            error=execution.stop_reason or "Task was cancelled",
                        )
                    )
                elif not t.cancelled() and (exc := t.exception()):
                    self._quarantined = not execution.execution_stopped
                    asyncio.create_task(
                        self._finish_execution(execution, success=False, error=str(exc))
                    )
                if self._current_prompt_task is None and not self._quarantined:
                    self.diff_refresh.prompt_finished()
                    self.diff_refresh.request(mid)

            task.add_done_callback(handle_task_exception)
            # Don't return the task — prompt tasks must survive WS disconnects.
            # Returning it would add it to background_tasks, which gets cancelled
            # in the _connect_and_run finally block on WS close.
            return None
        elif cmd_type == "stop":
            await self._handle_stop(cmd)
        elif cmd_type == "snapshot":
            # Cleanup may take time; shutdown/health commands remain responsive.
            return asyncio.create_task(self._handle_snapshot(cmd))
        elif cmd_type == "shutdown":
            await self._handle_shutdown()
        elif cmd_type == "git_sync_complete":
            self.git_sync_complete.set()
        elif cmd_type == "push":
            await self._handle_push(cmd)
        elif cmd_type == "refresh_diff":
            self.diff_refresh.request(None)
        elif cmd_type == "ack":
            ack_id = cmd.get("ackId")
            if ack_id and self.event_forwarder.acknowledge(ack_id):
                self.log.debug("bridge.ack_received", ack_id=ack_id)
        else:
            self.log.debug("bridge.unknown_command", cmd_type=cmd_type)
        return None

    def _new_execution(self, cmd: dict[str, Any]) -> _Execution:
        now_monotonic = asyncio.get_running_loop().time()
        now_epoch_seconds = time.time()

        def resolve_deadline(field: str, fallback_seconds: float) -> float:
            supplied = cmd.get(field)
            if supplied is None:
                return now_monotonic + fallback_seconds
            if (
                isinstance(supplied, bool)
                or not isinstance(supplied, (float, int))
                or not math.isfinite(supplied)
            ):
                # A malformed upgraded deadline must not fall back to a fresh
                # legacy allowance and accidentally extend an expired turn.
                return now_monotonic
            remaining_seconds = (
                supplied / 1000 - now_epoch_seconds - DEADLINE_CLOCK_ALLOWANCE_SECONDS
            )
            return now_monotonic + min(remaining_seconds, fallback_seconds)

        deadline = resolve_deadline(
            "executionDeadlineMs", self.prompt_limits.prompt_max_duration_seconds
        )
        cleanup_deadline = resolve_deadline(
            "cleanupDeadlineMs",
            max(0.0, deadline - now_monotonic) + self.prompt_limits.prompt_cleanup_timeout_seconds,
        )
        execution = _Execution(
            message_id=cmd.get("messageId") or cmd.get("message_id", "unknown"),
            deadline_monotonic=deadline,
            cleanup_deadline_monotonic=cleanup_deadline,
            epoch_offset_seconds=now_epoch_seconds - now_monotonic,
        )
        self.log.info(
            "prompt.deadline_resolved",
            message_id=execution.message_id,
            source="control_plane" if "executionDeadlineMs" in cmd else "legacy_derived_allowance",
            remaining_seconds=max(0.0, deadline - now_monotonic),
            cleanup_remaining_seconds=max(0.0, cleanup_deadline - now_monotonic),
        )
        return execution

    async def _contain_execution(self, execution: _Execution) -> None:
        execution.begin_cleanup(self.prompt_limits.prompt_cleanup_timeout_seconds)
        if not execution.work_started or execution.execution_stopped:
            return
        if not execution.harness_started:
            # A harness cannot attest to cancellation of repository preparation.
            self._quarantined = True
            return
        try:
            async with asyncio.timeout_at(execution.cleanup_deadline_monotonic):
                execution.execution_stopped = await self.harness.stop(
                    execution.cleanup_deadline_monotonic
                )
                if execution.interrupt_request_uncertain:
                    # An unacknowledged, session-scoped interrupt may still
                    # arrive later; cessation alone cannot make reuse safe.
                    execution.execution_stopped = False
        except (Exception, asyncio.CancelledError) as error:
            execution.execution_stopped = False
            self.log.warn("prompt.containment_failed", message_id=execution.message_id, exc=error)
        self._quarantined = not execution.execution_stopped
        self.log.info(
            "prompt.containment_complete",
            message_id=execution.message_id,
            execution_stopped=execution.execution_stopped,
            quarantined=self._quarantined,
            reason=execution.stop_reason,
        )

    async def _finish_execution(
        self,
        execution: _Execution,
        *,
        success: bool,
        error: str | None = None,
        message_cost_usd: float | None = None,
    ) -> None:
        if execution.terminal_event is not None:
            return
        event = {
            "type": "execution_complete",
            "messageId": execution.message_id,
            "sandboxId": self.sandbox_id,
            "success": success,
            "executionStopped": execution.execution_stopped,
            **(
                {
                    "cleanupDeadlineMs": int(
                        (execution.cleanup_deadline_monotonic + execution.epoch_offset_seconds)
                        * 1000
                    )
                }
                if execution.cleanup_started
                else {}
            ),
            **({"error": error} if error else {}),
            **({"messageCostUsd": message_cost_usd} if message_cost_usd is not None else {}),
        }
        execution.terminal_event = event
        self._completed_prompts[execution.message_id] = event
        while len(self._completed_prompts) > MAX_COMPLETED_PROMPTS:
            self._completed_prompts.popitem(last=False)
        # A slow connection consumes the same cleanup interval. The forwarder
        # retains cancelled critical sends for replay on reconnect.
        send_deadline = min(
            execution.cleanup_deadline_monotonic,
            asyncio.get_running_loop().time() + SEND_TIMEOUT_SECONDS,
        )
        with contextlib.suppress(TimeoutError):
            async with asyncio.timeout_at(send_deadline):
                await self._send_event(event)

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
        emitted_output = False
        execution = self._execution
        if execution is None or execution.message_id != message_id:
            execution = self._new_execution(cmd)
            self._execution = execution

        self.log.info(
            "prompt.start",
            message_id=message_id,
            model=model,
            reasoning_effort=reasoning_effort,
        )

        async def run() -> None:
            nonlocal emitted_output, message_cost_usd, had_error, error_message
            prompt_author = parse_prompt_git_author(author_data)
            # Preparation can execute subprocesses too. Until it completes,
            # interruption must conservatively retain the reuse boundary.
            execution.work_started = True
            execution.execution_stopped = False
            try:
                await self._configure_git_identity(prompt_author)
            except GitSigningError:
                # Its typed failure contract either rejects configuration or
                # reports an already-reaped git-config process. Cancellation
                # is different and remains uncertain until contained.
                execution.execution_stopped = True
                raise

            await self._ensure_agent_session()

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

            execution.harness_started = True
            turn: TurnOutcome = await self.harness.run_prompt(
                HarnessPrompt(
                    message_id=message_id,
                    text=content,
                    model=model,
                    reasoning_effort=reasoning_effort,
                    attachments=tuple(attachments or ()),
                    author=author_data if isinstance(author_data, dict) else {},
                ),
                emit,
            )
            execution.execution_stopped = turn.execution_stopped
            await self._persist_rotated_session_id()
            # The outcome is authoritative for cost and success once it
            # exists; the bridge adds only the no-output guard below.
            if turn.message_cost_usd is not None:
                message_cost_usd = turn.message_cost_usd
            if not turn.success:
                had_error = True
                error_message = turn.error or "Unknown error"
            if turn.cancelled:
                raise asyncio.CancelledError

        deadline_timeout = asyncio.timeout_at(execution.deadline_monotonic)
        try:
            # The deadline is captured at command receipt, so preparation,
            # session creation, attachment processing and delivery all count.
            if execution.deadline_monotonic <= asyncio.get_running_loop().time():
                raise TimeoutError("Execution deadline reached; stopping execution.")
            async with deadline_timeout:
                await run()

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

        except TimeoutError as error:
            outcome = "timeout"
            had_error = True
            error_message = (
                "Execution deadline reached; stopping execution."
                if deadline_timeout.expired()
                else str(error) or "An upstream operation timed out."
            )
            execution.stop_reason = error_message

        except asyncio.CancelledError:
            # This top-level command boundary settles cancellation just like
            # other prompt failures, while the turn's cost is still available.
            # The done callback remains a fallback for cancellation before start.
            outcome = "cancelled"
            had_error = True
            error_message = execution.stop_reason or "Task was cancelled"
            execution.stop_reason = error_message
        except Exception as e:
            outcome = "error"
            had_error = True
            error_message = str(e)
            self.log.error("prompt.error", exc=e, message_id=message_id)
        finally:
            execution.observation_finished.set()
            if self._current_stop_task is not None and not self._current_stop_task.done():
                # An old interrupt request must settle before admitting another
                # turn against this vendor session. Observation is finished, so
                # its stop driver no longer waits for this whole prompt task.
                with contextlib.suppress(TimeoutError):
                    async with asyncio.timeout_at(execution.cleanup_deadline_monotonic):
                        await asyncio.shield(self._current_stop_task)
            if execution.interrupt_request_uncertain:
                execution.execution_stopped = False
            if not execution.execution_stopped:
                execution.stop_reason = (
                    execution.stop_reason or error_message or "Execution uncertain"
                )
                await self._contain_execution(execution)
            if execution.stop_reason is not None:
                # A late result cannot reverse an already recorded Stop/expiry.
                had_error = True
                error_message = execution.stop_reason
            duration_ms = int((time.time() - start_time) * 1000)
            self.log.info(
                "prompt.run",
                message_id=message_id,
                model=model,
                reasoning_effort=reasoning_effort,
                outcome=outcome,
                duration_ms=duration_ms,
            )

        await self._finish_execution(
            execution,
            success=not had_error,
            error=error_message,
            message_cost_usd=message_cost_usd,
        )

    async def _ensure_agent_session(self) -> None:
        """Create the vendor session on first use and persist its id."""
        if self.agent_session_id:
            return
        await self.harness.create_session()
        await self._save_session_id()

    async def _handle_stop(self, cmd: dict[str, Any] | None = None) -> None:
        """Signal the prompt owner; never block the command receiver on cleanup."""
        self.log.info("bridge.stop")
        cmd = cmd or {}
        execution = self._execution
        if cmd.get("sandboxId", self.sandbox_id) != self.sandbox_id:
            return
        if execution is None:
            return
        if cmd.get("messageId", execution.message_id) != execution.message_id:
            return
        if execution.terminal_event is not None or execution.stop_reason is not None:
            return
        execution.stop_reason = str(cmd.get("reason") or "Task was cancelled")
        execution.begin_cleanup(self.prompt_limits.prompt_cleanup_timeout_seconds)
        supplied_deadline = cmd.get("cleanupDeadlineMs")
        if supplied_deadline is not None:
            # Stop may tighten the existing allowance, never restart or extend it.
            resolved = self._new_execution({"cleanupDeadlineMs": supplied_deadline})
            execution.cleanup_deadline_monotonic = min(
                execution.cleanup_deadline_monotonic, resolved.cleanup_deadline_monotonic
            )
        task = self._current_prompt_task
        if task and not task.done():
            self._current_stop_task = asyncio.create_task(
                self._request_graceful_stop(execution, task)
            )

    async def _request_graceful_stop(self, execution: _Execution, task: asyncio.Task[None]) -> None:
        """Keep observation alive briefly after interruption, then contain it.

        The request/observation phase spends at most half the remaining cleanup
        allowance, leaving time for harness escalation. Acknowledgement alone
        never releases the fence; only the prompt owner's outcome can do that.
        """
        remaining_seconds = max(
            0.0, execution.cleanup_deadline_monotonic - asyncio.get_running_loop().time()
        )
        grace_deadline = asyncio.get_running_loop().time() + min(
            GRACEFUL_STOP_MAX_SECONDS, remaining_seconds / 2
        )
        request_settled = True
        try:
            async with asyncio.timeout_at(grace_deadline):
                if execution.harness_started:
                    request_settled = False
                    accepted = await self.harness.abort()
                    request_settled = True
                    if accepted:
                        await execution.observation_finished.wait()
        except Exception as error:
            execution.interrupt_request_uncertain = not request_settled
            if request_settled:
                self.log.info("prompt.stop_observation_expired", message_id=execution.message_id)
            else:
                self.log.warn(
                    "prompt.interrupt_request_failed", message_id=execution.message_id, exc=error
                )
        finally:
            if not execution.observation_finished.is_set() and not task.done():
                task.cancel()

    async def _handle_snapshot(self, cmd: dict[str, Any] | None = None) -> None:
        """Handle snapshot command - prepare for snapshot."""
        self.log.info("bridge.snapshot_prepare")
        if self._quarantined or (
            self._current_prompt_task is not None and not self._current_prompt_task.done()
        ):
            self.log.warn("bridge.snapshot_execution_not_quiescent")
            return
        try:
            # Managed diagnostics can contain secrets. A failed exclusion must
            # never be acknowledged as snapshot-ready.
            deadline = (
                asyncio.get_running_loop().time()
                + self.prompt_limits.prompt_cleanup_timeout_seconds
            )
            if self._execution is not None and self._execution.stop_reason is not None:
                deadline = min(deadline, self._execution.cleanup_deadline_monotonic)
            async with asyncio.timeout_at(deadline):
                await prepare_hook_logs_for_snapshot(Path("/workspace"))
                await self._send_event(
                    {
                        "type": "snapshot_ready",
                        "opencodeSessionId": self.agent_session_id,
                        **({"requestId": cmd["requestId"]} if cmd and "requestId" in cmd else {}),
                    }
                )
        except Exception as error:
            self.log.error("bridge.snapshot_preparation_failed", exc=error)

    async def _handle_shutdown(self) -> None:
        """Handle shutdown command - graceful shutdown."""
        self.log.info("bridge.shutdown_requested")
        await self._handle_stop({"reason": "Sandbox shutdown requested"})
        self.shutdown_event.set()

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

    async def _load_session_id(self) -> None:
        """Resume the persisted vendor session, if any, through the harness.

        Startup only resumes. A missing or invalid id leaves the harness
        without a session and the first prompt creates one, as it always has;
        startup never replaces a conversation as a side effect of loading it.
        """
        try:
            persisted = self._read_persisted_session_id()
        except Exception as e:
            self.log.error("agent.session.load_error", exc=e)
            return
        if not persisted:
            return
        try:
            resumed = await self.harness.resume_session(persisted)
        except Exception as e:
            self.log.error("agent.session.load_error", exc=e)
            return
        if resumed:
            await self._save_session_id()

    async def _persist_rotated_session_id(self) -> None:
        """A conversation reset rotates the vendor id mid-connection; keep the file current."""
        try:
            persisted = self._read_persisted_session_id()
        except Exception as e:
            self.log.error("agent.session.load_error", exc=e)
            return
        if self.agent_session_id and self.agent_session_id != persisted:
            await self._save_session_id()

    async def _save_session_id(self) -> None:
        """Persist the vendor session id so a snapshot restore can resume it."""
        session_id = self.agent_session_id
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

    def _resolve_timeout_seconds(
        self,
        name: str,
        default: float,
        min_value: float,
        max_value: float,
    ) -> float:
        raw = os.environ.get(name)
        if raw is None or raw == "":
            value = default
        else:
            try:
                value = float(raw)
            except ValueError:
                self.log.warn(
                    "bridge.timeout_invalid",
                    timeout_name=name,
                    timeout_ms=int(default * 1000),
                    detail=f"invalid value '{raw}', using default",
                )
                value = default

        if value < min_value:
            self.log.warn(
                "bridge.timeout_clamped",
                timeout_name=name,
                timeout_ms=int(min_value * 1000),
                detail=f"below min ({min_value}s), clamped",
            )
            value = min_value
        elif value > max_value:
            self.log.warn(
                "bridge.timeout_clamped",
                timeout_name=name,
                timeout_ms=int(max_value * 1000),
                detail=f"above max ({max_value}s), clamped",
            )
            value = max_value

        self.log.info(
            "bridge.timeout_config",
            timeout_name=name,
            timeout_ms=int(value * 1000),
            min_ms=int(min_value * 1000),
            max_ms=int(max_value * 1000),
        )
        return value

    def _resolve_positive_timeout_seconds(self, name: str, default: float) -> float:
        raw = os.environ.get(name)
        try:
            value = default if raw is None or raw == "" else float(raw)
            if not math.isfinite(value) or value <= 0:
                raise ValueError
        except ValueError:
            self.log.warn(
                "bridge.timeout_invalid",
                timeout_name=name,
                timeout_ms=int(default * 1000),
                detail=f"invalid value '{raw}', using default",
            )
            value = default

        self.log.info(
            "bridge.timeout_config",
            timeout_name=name,
            timeout_ms=int(value * 1000),
        )
        return value


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

    args = parser.parse_args()

    bridge = AgentBridge(
        sandbox_id=args.sandbox_id,
        session_id=args.session_id,
        control_plane_url=args.control_plane,
        auth_token=args.token,
        opencode_port=args.opencode_port,
        harness_id=parse_harness_id(args.harness),
    )

    try:
        await bridge.run()
    except HarnessStartError:
        # The cause is already recorded for the supervisor; this exit code
        # tells it not to spend its restart budget.
        sys.exit(DETERMINISTIC_FAILURE_EXIT_CODE)


if __name__ == "__main__":
    asyncio.run(main())

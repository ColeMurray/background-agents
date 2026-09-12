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
from pathlib import Path
from typing import Any

import websockets
from websockets import ClientConnection, State
from websockets.exceptions import InvalidStatus

from .attachment_processor import (
    AttachmentProcessor,
    parse_session_image_attachments,
)
from .bridge_signals import run_bridge_with_signals
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
from .event_forwarder import BufferedEventForwarder
from .execution_coordinator import ExecutionCoordinator, PreparationFailed
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
    build_agent_harness,
    parse_harness_id,
)
from .hook_logs import prepare_hook_logs_for_snapshot
from .log_config import configure_logging, get_logger
from .push_operation import PushOperation
from .repo_config import load_repo_manifest
from .types import GitUser

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
    # OpenCode stream consumption responsiveness, including downstream delays.
    # Does not apply to Claude or establish useful model/tool progress.
    SSE_INACTIVITY_TIMEOUT = 300.0
    SSE_INACTIVITY_TIMEOUT_MIN = 5.0
    SSE_INACTIVITY_TIMEOUT_MAX = 3600.0
    DIFF_REFRESH_SHUTDOWN_TIMEOUT_SECONDS = 5.0
    WEBSOCKET_CLOSE_TIMEOUT_SECONDS = 1.0

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
        self.execution = ExecutionCoordinator(
            sandbox_id=sandbox_id,
            harness=lambda: self.harness,
            limits=lambda: self.prompt_limits,
            prepare=self._prepare_prompt,
            persist_session=self._persist_rotated_session_id,
            send_event=lambda event: self._send_event(event),
            on_started=lambda: self.diff_refresh.prompt_started(),
            on_reusable=self._execution_reusable,
            log=self.log,
        )
        self._shutdown_deadline_monotonic: float | None = None

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
            close_deadline = await self.execution.shutdown(self._shutdown_deadline_monotonic)
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
                close_timeout=self.WEBSOCKET_CLOSE_TIMEOUT_SECONDS,
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
            if self.shutdown_event.is_set():
                return None
            return self.execution.dispatch(cmd)
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

    def _execution_reusable(self, message_id: str) -> None:
        """Release presentation work only after the coordinator confirms reuse."""
        self.diff_refresh.prompt_finished()
        self.diff_refresh.request(message_id)

    async def _handle_prompt(self, cmd: dict[str, Any]) -> None:
        """Await a coordinated prompt for callers outside the command receiver."""
        await self.execution.execute(cmd)

    async def _prepare_prompt(self, cmd: dict[str, Any]) -> HarnessPrompt:
        """Prepare repository identity, vendor session and attachments before dispatch."""
        message_id = cmd.get("messageId") or cmd.get("message_id", "unknown")
        author_data = cmd.get("author", {})
        try:
            author = parse_prompt_git_author(author_data)
            await self._configure_git_identity(author)
        except GitSigningError as error:
            # Typed configuration failures reject work or report an already
            # reaped git-config process. Cancellation has no such guarantee.
            raise PreparationFailed(str(error)) from error
        await self._ensure_agent_session()
        attachments, rejected = parse_session_image_attachments(cmd.get("attachments"))
        if rejected:
            self.log.warn(
                "prompt.invalid_attachments", message_id=message_id, rejected_count=rejected
            )
            await self._send_media_warning(f"{rejected} invalid attachment(s) were skipped.")
        hydrated = await self.attachment_processor.process(attachments)
        return HarnessPrompt(
            message_id=message_id,
            text=cmd.get("content", ""),
            model=cmd.get("model"),
            reasoning_effort=cmd.get("reasoningEffort"),
            attachments=tuple(hydrated or ()),
            author=author_data if isinstance(author_data, dict) else {},
        )

    async def _ensure_agent_session(self) -> None:
        """Create the vendor session on first use and persist its id."""
        if self.agent_session_id:
            return
        await self.harness.create_session()
        await self._save_session_id()

    async def _handle_stop(self, cmd: dict[str, Any] | None = None) -> None:
        """Route Stop without blocking the receiver on execution cleanup."""
        self.execution.request_stop(cmd)

    async def _handle_snapshot(self, cmd: dict[str, Any] | None = None) -> None:
        """Handle snapshot command - prepare for snapshot."""
        self.log.info("bridge.snapshot_prepare")
        deadline = self.execution.snapshot_deadline()
        if deadline is None:
            self.log.warn("bridge.snapshot_execution_not_quiescent")
            return
        try:
            # Managed diagnostics can contain secrets. A failed exclusion must
            # never be acknowledged as snapshot-ready.
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
        self.request_shutdown()

    def request_shutdown(self, *, cleanup_seconds: float | None = None) -> None:
        """Wake transport shutdown while the coordinator contains active work."""
        self.log.info("bridge.shutdown_requested")
        if cleanup_seconds is not None:
            deadline = asyncio.get_running_loop().time() + cleanup_seconds
            self._shutdown_deadline_monotonic = min(
                self._shutdown_deadline_monotonic or deadline, deadline
            )
        self.execution.request_stop(
            {"reason": "Sandbox shutdown requested"},
            deadline_monotonic=self._shutdown_deadline_monotonic,
        )
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
        await run_bridge_with_signals(bridge)
    except HarnessStartError:
        # The cause is already recorded for the supervisor; this exit code
        # tells it not to spend its restart budget.
        sys.exit(DETERMINISTIC_FAILURE_EXIT_CODE)


if __name__ == "__main__":
    asyncio.run(main())

"""
Agent bridge - bidirectional communication between sandbox and control plane.

This module handles:
- WebSocket connection to control plane Durable Object
- Heartbeat loop for connection health
- Event forwarding from OpenCode to control plane
- Command handling from control plane (prompt, stop, snapshot)
- Git identity configuration per prompt author
"""

import argparse
import asyncio
import contextlib
import json
import os
import re
import subprocess
import tempfile
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NoReturn

import httpx
import websockets
from websockets import ClientConnection, State
from websockets.exceptions import InvalidStatus

from .attachment_processor import (
    AttachmentProcessor,
    HydratedSessionAttachment,
    parse_session_image_attachments,
)
from .constants import BOOT_WARNINGS_FILE_PATH, REPO_MANIFEST_FILE_PATH
from .diff_capture import ControlPlaneDiffClient, SessionDiffRefreshWorker
from .event_forwarder import BufferedEventForwarder
from .log_config import configure_logging, get_logger
from .opencode_client import HTTP_CONNECT_TIMEOUT_SECONDS, OpenCodeClient
from .prompt_stream import OpenCodePromptStream
from .repo_config import find_repo_entry, load_repo_manifest
from .types import GitUser

configure_logging()

# Fallback git identity when prompt author has no SCM name/email configured.
# Matches the co-author trailer used in generateCommitMessage (shared/git.ts).
FALLBACK_GIT_USER = GitUser(name="OpenInspect", email="open-inspect@noreply.github.com")


@dataclass(frozen=True)
class PushRequest:
    """The provider-generated push spec, normalized for execution.

    Absent fields normalize to ""/False; _validate_push_request decides
    which of those are fatal.
    """

    branch_name: str
    repo_owner: str
    repo_name: str
    refspec: str
    push_url: str
    redacted_push_url: str
    force: bool

    @classmethod
    def from_push_spec(cls, push_spec: dict[str, Any] | None) -> "PushRequest":
        """Normalize the raw spec; missing fields become ""/False, never errors."""
        spec = push_spec or {}

        def field(key: str) -> str:
            return str(spec.get(key, "")).strip()

        return cls(
            branch_name=field("targetBranch"),
            repo_owner=field("repoOwner"),
            repo_name=field("repoName"),
            refspec=field("refspec"),
            push_url=field("remoteUrl"),
            redacted_push_url=field("redactedRemoteUrl"),
            force=bool(spec.get("force", False)),
        )

    @property
    def has_repo_identity(self) -> bool:
        """True when the spec names its target repository.

        Owner and name always travel together — _validate_push_request
        rejects partial identity before anything consults this.
        """
        return bool(self.repo_owner and self.repo_name)

    @property
    def repo_full_name(self) -> str:
        return f"{self.repo_owner}/{self.repo_name}"

    def repo_fields(self) -> dict[str, Any]:
        """Repo identity echoed on push events when the spec carried it."""
        fields: dict[str, Any] = {}
        if self.repo_owner:
            fields["repoOwner"] = self.repo_owner
        if self.repo_name:
            fields["repoName"] = self.repo_name
        return fields


class PushRejected(Exception):
    """A push that cannot proceed; str(exc) is the user-facing error message.

    Raise sites log their own specific event first — this exception only
    carries the message to the single push_error emitter in _handle_push.
    """


class SessionTerminatedError(Exception):
    """Raised when the control plane has terminated the session (HTTP 410).

    This is a non-recoverable error - the bridge should exit gracefully
    rather than retry. The session can be restored via user action (sending
    a new prompt), which will trigger snapshot restoration on the control plane.
    """

    pass


class AgentBridge:
    """
    Bridge between sandbox OpenCode instance and control plane.

    Handles:
    - WebSocket connection management with reconnection
    - Heartbeat for connection health
    - Event streaming from OpenCode to control plane
    - Command handling (prompt, stop, snapshot, shutdown)
    - Git identity management per prompt author
    """

    HEARTBEAT_INTERVAL = 30.0
    RECONNECT_BACKOFF_BASE = 2.0
    RECONNECT_MAX_DELAY = 60.0
    SSE_INACTIVITY_TIMEOUT = 120.0
    SSE_INACTIVITY_TIMEOUT_MIN = 5.0
    SSE_INACTIVITY_TIMEOUT_MAX = 3600.0
    HTTP_CONNECT_TIMEOUT = HTTP_CONNECT_TIMEOUT_SECONDS
    HTTP_DEFAULT_TIMEOUT = 30.0
    GIT_PUSH_TIMEOUT_SECONDS = 300.0
    GIT_PUSH_TERMINATE_GRACE_SECONDS = 5.0
    PROMPT_MAX_DURATION = 5400.0
    GIT_CONFIG_TIMEOUT_SECONDS = 10.0
    DIFF_REFRESH_SHUTDOWN_TIMEOUT_SECONDS = 5.0

    def __init__(
        self,
        sandbox_id: str,
        session_id: str,
        control_plane_url: str,
        auth_token: str,
        opencode_port: int = 4096,
    ):
        self.sandbox_id = sandbox_id
        self.session_id = session_id
        self.control_plane_url = control_plane_url
        self.auth_token = auth_token
        self.opencode_port = opencode_port
        self.opencode_base_url = f"http://localhost:{opencode_port}"

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

        self.sse_inactivity_timeout = self._resolve_timeout_seconds(
            name="BRIDGE_SSE_INACTIVITY_TIMEOUT",
            default=self.SSE_INACTIVITY_TIMEOUT,
            min_value=self.SSE_INACTIVITY_TIMEOUT_MIN,
            max_value=self.SSE_INACTIVITY_TIMEOUT_MAX,
        )

        self.ws: ClientConnection | None = None
        self.shutdown_event = asyncio.Event()
        self.git_sync_complete = asyncio.Event()

        # Session state
        self.opencode_session_id: str | None = None
        self.session_id_file = Path(tempfile.gettempdir()) / "opencode-session-id"
        self.repo_path = Path("/workspace")
        # Supervisor-written canonical repo manifest; push targeting resolves
        # member checkout paths through it rather than joining spec-supplied
        # names into the filesystem.
        self.repo_manifest_path = Path(REPO_MANIFEST_FILE_PATH)

        # HTTP client for OpenCode API
        self.http_client: httpx.AsyncClient | None = None

        # OpenCode transport client and prompt SSE translator; created on
        # first use because they share the HTTP client that only exists once
        # run() has started.
        self._opencode_client: OpenCodeClient | None = None
        self._prompt_stream: OpenCodePromptStream | None = None

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
    def ws_url(self) -> str:
        """WebSocket URL for control plane connection."""
        url = self.control_plane_url.replace("https://", "wss://").replace("http://", "ws://")
        return f"{url}/sessions/{self.session_id}/ws?type=sandbox"

    def _build_ready_event(self) -> dict[str, Any]:
        repositories = load_repo_manifest(self.repo_manifest_path)
        return {
            "type": "ready",
            "sandboxId": self.sandbox_id,
            "opencodeSessionId": self.opencode_session_id,
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

    @staticmethod
    def _redact_git_stderr(stderr_text: str, push_url: str, redacted_push_url: str) -> str:
        """Redact credential-bearing URLs from git stderr."""
        redacted_stderr = stderr_text
        if push_url and redacted_push_url:
            redacted_stderr = redacted_stderr.replace(push_url, redacted_push_url)

        return re.sub(r"(https?://)([^/\s@]+)@", r"\1***@", redacted_stderr)

    async def run(self) -> None:
        """Main bridge loop with reconnection handling.

        Handles reconnection for transient errors (network issues, etc.) but
        exits gracefully for terminal errors like HTTP 410 (session terminated).
        """
        self.log.info("bridge.run_start")

        self.http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(
                self.HTTP_DEFAULT_TIMEOUT,
                connect=self.HTTP_CONNECT_TIMEOUT,
            )
        )
        await self._load_session_id()

        reconnect_attempts = 0
        run_outcome = "shutdown"

        try:
            while not self.shutdown_event.is_set():
                run_outcome = "shutdown"
                try:
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
            # Cancel any in-flight prompt task before closing resources
            if self._current_prompt_task and not self._current_prompt_task.done():
                self._current_prompt_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await self._current_prompt_task
            await self.diff_refresh.close(
                timeout_seconds=self.DIFF_REFRESH_SHUTDOWN_TIMEOUT_SECONDS
            )
            if self.http_client:
                await self.http_client.aclose()
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
            await self._handle_snapshot()
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

    async def _send_terminal_event_and_refresh(self, event: dict[str, Any]) -> None:
        await self._send_event(event)
        self.diff_refresh.request(str(event.get("messageId") or "") or None)

    async def _handle_prompt(self, cmd: dict[str, Any]) -> None:
        """Handle prompt command - send to OpenCode and stream response."""
        message_id = cmd.get("messageId") or cmd.get("message_id", "unknown")
        content = cmd.get("content", "")
        model = cmd.get("model")
        reasoning_effort = cmd.get("reasoningEffort")
        raw_attachments = cmd.get("attachments")
        author_data = cmd.get("author", {})
        start_time = time.time()
        outcome = "success"

        self.log.info(
            "prompt.start",
            message_id=message_id,
            model=model,
            reasoning_effort=reasoning_effort,
        )

        try:
            scm_name = author_data.get("scmName")
            scm_email = author_data.get("scmEmail")
            await self._configure_git_identity(
                GitUser(
                    name=scm_name or FALLBACK_GIT_USER.name,
                    email=scm_email or FALLBACK_GIT_USER.email,
                )
            )

            if not self.opencode_session_id:
                await self._create_opencode_session()

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

            had_error = False
            error_message = None
            emitted_output = False
            async for event in self._stream_opencode_response_sse(
                message_id, content, model, reasoning_effort, attachments
            ):
                if event.get("type") == "error":
                    had_error = True
                    error_message = event.get("error")
                elif event.get("type") in ("token", "tool_call", "step_finish"):
                    emitted_output = True
                await self._send_event(event)

            if not had_error and not emitted_output:
                had_error = True
                error_message = "OpenCode completed without emitting assistant output."
                self.log.error(
                    "prompt.no_output",
                    message_id=message_id,
                    model=model,
                    reasoning_effort=reasoning_effort,
                )

            if had_error:
                outcome = "error"

            await self._send_event(
                {
                    "type": "execution_complete",
                    "messageId": message_id,
                    "success": not had_error,
                    **({"error": error_message} if error_message else {}),
                }
            )

        except Exception as e:
            outcome = "error"
            self.log.error("prompt.error", exc=e, message_id=message_id)
            await self._send_event(
                {
                    "type": "execution_complete",
                    "messageId": message_id,
                    "success": False,
                    "error": str(e),
                }
            )
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

    async def _create_opencode_session(self) -> None:
        """Create a new OpenCode session."""
        self.opencode_session_id = await self._ensure_opencode_client().create_session()
        self.log.info(
            "opencode.session.ensure",
            opencode_session_id=self.opencode_session_id,
            action="created",
        )

        await self._save_session_id()

    def _ensure_opencode_client(self) -> OpenCodeClient:
        """The long-lived OpenCode transport client, created on first use.

        Lazy because it shares the bridge's HTTP client, which only exists
        once run() has started.
        """
        if self._opencode_client is None:
            if not self.http_client:
                raise RuntimeError("HTTP client not initialized")
            self._opencode_client = OpenCodeClient(
                http_client=self.http_client,
                base_url=self.opencode_base_url,
                log=self.log,
            )
        return self._opencode_client

    def _ensure_prompt_stream(self) -> OpenCodePromptStream:
        """The long-lived prompt SSE translator, created on first use."""
        if self._prompt_stream is None:
            self._prompt_stream = OpenCodePromptStream(
                client=self._ensure_opencode_client(),
                attachment_processor=self.attachment_processor,
                log=self.log,
                sse_inactivity_timeout_seconds=self.sse_inactivity_timeout,
                prompt_max_duration_seconds=self.PROMPT_MAX_DURATION,
            )
        return self._prompt_stream

    async def _stream_opencode_response_sse(
        self,
        message_id: str,
        content: str,
        model: str | None = None,
        reasoning_effort: str | None = None,
        attachments: list[HydratedSessionAttachment] | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Stream one prompt's response events (see prompt_stream.py)."""
        if not self.http_client or not self.opencode_session_id:
            raise RuntimeError("OpenCode session not initialized")

        stream = self._ensure_prompt_stream()
        async for event in stream.stream_prompt(
            opencode_session_id=self.opencode_session_id,
            message_id=message_id,
            content=content,
            model=model,
            reasoning_effort=reasoning_effort,
            attachments=attachments,
        ):
            yield event

    async def _handle_stop(self) -> None:
        """Handle stop command - cancel prompt task and request OpenCode stop."""
        self.log.info("bridge.stop")
        task = self._current_prompt_task
        if task and not task.done():
            task.cancel()
        # Best-effort: also tell OpenCode to stop (saves LLM compute cost)
        await self._request_opencode_stop(reason="command")

    async def _handle_snapshot(self) -> None:
        """Handle snapshot command - prepare for snapshot."""
        self.log.info("bridge.snapshot_prepare")
        await self._send_event(
            {
                "type": "snapshot_ready",
                "opencodeSessionId": self.opencode_session_id,
            }
        )

    async def _handle_shutdown(self) -> None:
        """Handle shutdown command - graceful shutdown."""
        self.log.info("bridge.shutdown_requested")
        if self._current_prompt_task and not self._current_prompt_task.done():
            self._current_prompt_task.cancel()
        self.shutdown_event.set()

    async def _handle_push(self, cmd: dict[str, Any]) -> None:
        """Handle push command using provider-generated push spec.

        Pipeline: parse → validate → resolve checkout → run git push. Every
        failure raises PushRejected (logged at the raise site) and lands in
        the single push_error emitter below.
        """
        push_spec = cmd.get("pushSpec") if isinstance(cmd.get("pushSpec"), dict) else None
        request = PushRequest.from_push_spec(push_spec)

        self.log.info(
            "git.push_start",
            branch_name=request.branch_name,
            repo_owner=request.repo_owner,
            repo_name=request.repo_name,
            mode="push_spec",
        )

        try:
            self._validate_push_request(request, spec_present=push_spec is not None)
            repo_dir = self._resolve_push_checkout(request)
            await self._run_git_push(request, repo_dir)
        except PushRejected as rejection:
            await self._send_push_error(str(rejection), request)
            return
        except Exception as e:
            self.log.error("git.push_error", exc=e, branch_name=request.branch_name)
            await self._send_push_error(str(e), request)
            return

        self.log.info(
            "git.push_complete",
            branch_name=request.branch_name,
            repo_owner=request.repo_owner,
            repo_name=request.repo_name,
        )
        await self._send_event(
            {
                "type": "push_complete",
                "branchName": request.branch_name,
                **request.repo_fields(),
                "timestamp": time.time(),
            }
        )

    def _reject_push(self, *, reason: str, message: str, **log_fields: Any) -> NoReturn:
        """Log a push rejection and raise it toward _handle_push's emitter."""
        self.log.warn("git.push_error", reason=reason, **log_fields)
        raise PushRejected(message)

    def _validate_push_request(self, request: PushRequest, *, spec_present: bool) -> None:
        """Reject structurally unusable specs before touching the workspace."""
        if not spec_present:
            self._reject_push(
                reason="missing_push_spec",
                message="Push failed - missing push specification",
            )
        if bool(request.repo_owner) != bool(request.repo_name):
            self._reject_push(
                reason="partial_repo_identity",
                message="Push failed - pushSpec must carry both repoOwner and repoName",
                repo_owner=request.repo_owner,
                repo_name=request.repo_name,
            )
        if not request.branch_name:
            self._reject_push(
                reason="missing_target_branch",
                message="Push failed - missing target branch",
            )
        if not request.refspec or not request.push_url:
            self._reject_push(
                reason="invalid_push_spec",
                message="Push failed - invalid push specification",
            )

    def _resolve_push_checkout(self, request: PushRequest) -> Path:
        """Pick the git checkout the push runs in."""
        if request.has_repo_identity:
            return self._member_checkout(request)
        return self._sole_workspace_checkout()

    def _member_checkout(self, request: PushRequest) -> Path:
        """Checkout of the session member the spec names.

        The identity is matched against the supervisor-written manifest and
        the matched entry's path is used verbatim — spec-supplied strings
        never become filesystem paths, so a crafted name cannot select a
        checkout outside the session.
        """
        member = find_repo_entry(
            load_repo_manifest(self.repo_manifest_path),
            request.repo_owner,
            request.repo_name,
        )
        if member is None:
            self._reject_push(
                reason="repo_not_session_member",
                message=f"Repository {request.repo_full_name} is not part of this session",
                repo_owner=request.repo_owner,
                repo_name=request.repo_name,
            )
        if not (member.path / ".git").exists():
            self._reject_push(
                reason="repo_not_in_workspace",
                message=f"Repository {request.repo_full_name} not found in workspace",
                repo_owner=request.repo_owner,
                repo_name=request.repo_name,
            )
        return member.path

    def _sole_workspace_checkout(self) -> Path:
        """Checkout for a spec that names no repository (legacy control
        planes, single-repo sessions): the one clone directly under
        /workspace. Sorted only to be deterministic if that invariant is
        ever violated."""
        repo_dirs = sorted(self.repo_path.glob("*/.git"))
        if not repo_dirs:
            self._reject_push(reason="no_repo_configured", message="No repository found")
        return repo_dirs[0].parent

    async def _run_git_push(self, request: PushRequest, repo_dir: Path) -> None:
        """Run git push in repo_dir; raises PushRejected on failure or timeout."""
        self.log.info(
            "git.push_command",
            branch_name=request.branch_name,
            refspec=request.refspec,
            force=request.force,
            remote_url=request.redacted_push_url,
        )

        process = await asyncio.create_subprocess_exec(
            "git",
            "push",
            request.push_url,
            request.refspec,
            *(["-f"] if request.force else []),
            cwd=repo_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        try:
            _stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=self.GIT_PUSH_TIMEOUT_SECONDS,
            )
        except TimeoutError:
            self.log.warn(
                "git.push_timeout",
                branch_name=request.branch_name,
                timeout_ms=int(self.GIT_PUSH_TIMEOUT_SECONDS * 1000),
            )
            await self._terminate_push_process(process, request.branch_name)
            raise PushRejected(
                f"Push failed - git push timed out after {int(self.GIT_PUSH_TIMEOUT_SECONDS)}s"
            ) from None

        if process.returncode != 0:
            stderr_text = stderr.decode("utf-8", errors="replace").strip() if stderr else ""
            redacted_stderr_text = self._redact_git_stderr(
                stderr_text,
                request.push_url,
                request.redacted_push_url,
            )
            self.log.warn(
                "git.push_failed",
                branch_name=request.branch_name,
                stderr=redacted_stderr_text,
            )
            raise PushRejected(
                f"Push failed: {redacted_stderr_text}"
                if redacted_stderr_text
                else "Push failed - unknown error"
            )

    async def _terminate_push_process(
        self, process: asyncio.subprocess.Process, branch_name: str
    ) -> None:
        """Terminate a hung git push, escalating to kill after a grace period."""
        with contextlib.suppress(ProcessLookupError):
            process.terminate()
        try:
            await asyncio.wait_for(
                process.wait(),
                timeout=self.GIT_PUSH_TERMINATE_GRACE_SECONDS,
            )
        except TimeoutError:
            self.log.warn(
                "git.push_kill",
                branch_name=branch_name,
                timeout_ms=int(self.GIT_PUSH_TERMINATE_GRACE_SECONDS * 1000),
            )
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            await process.wait()

    async def _send_push_error(self, error: str, request: PushRequest) -> None:
        """Emit push_error. branchName is included even when empty so the
        control plane can resolve its pending push instead of leaking it."""
        await self._send_event(
            {
                "type": "push_error",
                "error": error,
                "branchName": request.branch_name,
                **request.repo_fields(),
                "timestamp": time.time(),
            }
        )

    async def _configure_git_identity(self, user: GitUser) -> None:
        """Configure git identity for commit attribution in every member checkout."""
        self.log.debug("git.identity_configure", git_name=user.name, git_email=user.email)

        repo_dirs = list(self.repo_path.glob("*/.git"))
        if not repo_dirs:
            self.log.debug("git.identity_skip", reason="no_repo_configured")
            return

        async def _run_git_config(repo_dir: Path, *args: str) -> None:
            cmd = ["git", "config", "--local", *args]
            process = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=repo_dir,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )

            try:
                _, stderr = await asyncio.wait_for(
                    process.communicate(),
                    timeout=self.GIT_CONFIG_TIMEOUT_SECONDS,
                )
            except TimeoutError as e:
                process.kill()
                with contextlib.suppress(ProcessLookupError):
                    await process.wait()
                raise subprocess.TimeoutExpired(
                    cmd=cmd,
                    timeout=self.GIT_CONFIG_TIMEOUT_SECONDS,
                ) from e

            if process.returncode != 0:
                if process.returncode is None:
                    raise RuntimeError("git config exited without a return code")
                raise subprocess.CalledProcessError(
                    returncode=process.returncode,
                    cmd=cmd,
                    stderr=stderr,
                )

        try:
            for git_dir in repo_dirs:
                repo_dir = git_dir.parent
                await _run_git_config(repo_dir, "user.name", user.name)
                await _run_git_config(repo_dir, "user.email", user.email)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
            self.log.error("git.identity_error", exc=e)

    async def _load_session_id(self) -> None:
        """Load OpenCode session ID from file if it exists."""
        if self.session_id_file.exists():
            try:
                self.opencode_session_id = self.session_id_file.read_text().strip()
                self.log.info(
                    "opencode.session.ensure",
                    opencode_session_id=self.opencode_session_id,
                    action="loaded",
                )

                if self.http_client:
                    try:
                        client = self._ensure_opencode_client()
                        if not await client.session_exists(self.opencode_session_id):
                            self.log.info(
                                "opencode.session.invalid",
                                opencode_session_id=self.opencode_session_id,
                            )
                            self.opencode_session_id = None
                    except Exception:
                        self.opencode_session_id = None

            except Exception as e:
                self.log.error("opencode.session.load_error", exc=e)

    async def _save_session_id(self) -> None:
        """Save OpenCode session ID to file for persistence."""
        if self.opencode_session_id:
            try:
                self.session_id_file.write_text(self.opencode_session_id)
            except Exception as e:
                self.log.error("opencode.session.save_error", exc=e)

    async def _request_opencode_stop(self, reason: str) -> bool:
        if not self.http_client or not self.opencode_session_id:
            return False
        return await self._ensure_opencode_client().request_stop(
            self.opencode_session_id, reason=reason
        )

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


async def main() -> None:
    """Entry point for bridge process."""
    parser = argparse.ArgumentParser(description="Open-Inspect Agent Bridge")
    parser.add_argument("--sandbox-id", required=True, help="Sandbox ID")
    parser.add_argument("--session-id", required=True, help="Session ID for WebSocket connection")
    parser.add_argument("--control-plane", required=True, help="Control plane URL")
    parser.add_argument("--token", required=True, help="Auth token")
    parser.add_argument("--opencode-port", type=int, default=4096, help="OpenCode port")

    args = parser.parse_args()

    bridge = AgentBridge(
        sandbox_id=args.sandbox_id,
        session_id=args.session_id,
        control_plane_url=args.control_plane,
        auth_token=args.token,
        opencode_port=args.opencode_port,
    )

    await bridge.run()


if __name__ == "__main__":
    asyncio.run(main())

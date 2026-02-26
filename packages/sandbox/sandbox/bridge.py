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
import secrets
import subprocess
import tempfile
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, ClassVar

import httpx
import websockets
from websockets import ClientConnection, State
from websockets.exceptions import InvalidStatus

from .log_config import configure_logging, get_logger
from .types import GitUser

configure_logging()

# Fallback git identity when prompt author has no SCM name/email configured.
# Matches the co-author trailer used in generateCommitMessage (shared/git.ts).
FALLBACK_GIT_USER = GitUser(name="OpenInspect", email="open-inspect@noreply.github.com")


class OpenCodeIdentifier:
    """
    Generate OpenCode-compatible ascending IDs.

    Port of OpenCode's TypeScript implementation:
    https://github.com/anomalyco/opencode/blob/8f0d08fae07c97a090fcd31d0d4c4a6fa7eeaa1d/packages/opencode/src/id/id.ts

    Format: {prefix}_{timestamp_hex}{random_base62}
    - prefix: type identifier (e.g., "msg" for messages)
    - timestamp_hex: 12 hex chars encoding (timestamp_ms * 0x1000 + counter)
    - random_base62: 14 random base62 characters

    IDs are monotonically increasing, ensuring new user messages always have
    IDs greater than previous assistant messages (required for OpenCode's
    prompt loop).

    Note: Uses class-level state for monotonic generation. Safe for async code
    but NOT thread-safe.
    """

    PREFIXES: ClassVar[dict[str, str]] = {
        "session": "ses",
        "message": "msg",
        "part": "prt",
    }
    BASE62_CHARS: ClassVar[str] = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    RANDOM_LENGTH: ClassVar[int] = 14

    _last_timestamp: ClassVar[int] = 0
    _counter: ClassVar[int] = 0

    @classmethod
    def ascending(cls, prefix: str) -> str:
        """Generate an ascending ID with the given prefix."""
        if prefix not in cls.PREFIXES:
            raise ValueError(f"Unknown prefix: {prefix}")

        prefix_str = cls.PREFIXES[prefix]
        current_timestamp = int(time.time() * 1000)

        if current_timestamp != cls._last_timestamp:
            cls._last_timestamp = current_timestamp
            cls._counter = 0
        cls._counter += 1

        encoded = current_timestamp * 0x1000 + cls._counter
        encoded_48bit = encoded & 0xFFFFFFFFFFFF
        timestamp_bytes = encoded_48bit.to_bytes(6, byteorder="big")
        timestamp_hex = timestamp_bytes.hex()
        random_suffix = cls._random_base62(cls.RANDOM_LENGTH)

        return f"{prefix_str}_{timestamp_hex}{random_suffix}"

    @classmethod
    def _random_base62(cls, length: int) -> str:
        """Generate random base62 string."""
        return "".join(cls.BASE62_CHARS[secrets.randbelow(62)] for _ in range(length))


class SSEConnectionError(Exception):
    """Raised when SSE connection fails."""

    pass


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
    HTTP_CONNECT_TIMEOUT = 30.0
    HTTP_DEFAULT_TIMEOUT = 30.0
    OPENCODE_REQUEST_TIMEOUT = 10.0
    PROMPT_MAX_DURATION = 5400.0
    MAX_PENDING_PART_EVENTS = 2000
    MAX_EVENT_BUFFER_SIZE = 1000
    CRITICAL_EVENT_TYPES: ClassVar[set[str]] = {
        "execution_complete",
        "error",
        "snapshot_ready",
        "push_complete",
        "push_error",
    }

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

        # HTTP client for OpenCode API
        self.http_client: httpx.AsyncClient | None = None

        # Track the current prompt task so _handle_stop can cancel it
        self._current_prompt_task: asyncio.Task[None] | None = None

        # Event buffer: survives WS reconnection, flushed on reconnect
        self._event_buffer: list[dict[str, Any]] = []

        # Tracks the message ID of the currently executing prompt
        self._inflight_message_id: str | None = None

    @property
    def ws_url(self) -> str:
        """WebSocket URL for control plane connection."""
        url = self.control_plane_url.replace("https://", "wss://").replace("http://", "ws://")
        return f"{url}/sessions/{self.session_id}/ws?type=sandbox"

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

        try:
            while not self.shutdown_event.is_set():
                try:
                    await self._connect_and_run()
                    reconnect_attempts = 0
                except SessionTerminatedError as e:
                    # Non-recoverable: session has been terminated by control plane
                    self.log.info(
                        "bridge.disconnect",
                        reason="session_terminated",
                        detail=str(e),
                    )
                    self.shutdown_event.set()
                    break
                except websockets.ConnectionClosed as e:
                    self.log.warn(
                        "bridge.disconnect",
                        reason="connection_closed",
                        ws_close_code=e.code,
                    )
                except Exception as e:
                    error_str = str(e)
                    # Check for fatal HTTP errors that shouldn't trigger retry
                    if self._is_fatal_connection_error(error_str):
                        self.log.error(
                            "bridge.disconnect",
                            reason="fatal_error",
                            exc=e,
                        )
                        self.shutdown_event.set()
                        break
                    self.log.warn(
                        "bridge.disconnect",
                        reason="connection_error",
                        detail=error_str,
                    )

                if self.shutdown_event.is_set():
                    break

                reconnect_attempts += 1
                delay = min(
                    self.RECONNECT_BACKOFF_BASE**reconnect_attempts,
                    self.RECONNECT_MAX_DELAY,
                )
                self.log.info(
                    "bridge.reconnect",
                    attempt=reconnect_attempts,
                    delay_s=round(delay, 1),
                )
                await asyncio.sleep(delay)

        finally:
            # Cancel any in-flight prompt task before closing resources
            if self._current_prompt_task and not self._current_prompt_task.done():
                self._current_prompt_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await self._current_prompt_task
            if self.http_client:
                await self.http_client.aclose()

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
                self.log.info("bridge.connect", outcome="success")

                await self._send_event(
                    {
                        "type": "ready",
                        "sandboxId": self.sandbox_id,
                        "opencodeSessionId": self.opencode_session_id,
                    }
                )

                await self._flush_event_buffer()

                heartbeat_task = asyncio.create_task(self._heartbeat_loop())
                background_tasks: set[asyncio.Task[None]] = set()

                try:
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

                finally:
                    heartbeat_task.cancel()
                    for task in background_tasks:
                        task.cancel()
                    self.ws = None

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

    async def _send_event(self, event: dict[str, Any]) -> None:
        """Send event to control plane, buffering if WS is unavailable."""
        event_type = event.get("type", "unknown")
        event["sandboxId"] = self.sandbox_id
        event["timestamp"] = event.get("timestamp", time.time())

        if not self.ws or self.ws.state != State.OPEN:
            self._buffer_event(event)
            return

        try:
            await self.ws.send(json.dumps(event))
        except Exception as e:
            self.log.warn("bridge.send_error", event_type=event_type, exc=e)
            self._buffer_event(event)

    async def _flush_event_buffer(self) -> None:
        """Flush buffered events to the control plane after reconnect."""
        if not self._event_buffer:
            return

        self.log.info("bridge.flush_buffer_start", buffer_size=len(self._event_buffer))
        flushed = 0
        while self._event_buffer:
            event = self._event_buffer[0]
            if not self.ws or self.ws.state != State.OPEN:
                break
            try:
                await self.ws.send(json.dumps(event))
                self._event_buffer.pop(0)
                flushed += 1
            except Exception as e:
                self.log.warn("bridge.flush_send_error", exc=e)
                break

        self.log.info(
            "bridge.flush_buffer_complete",
            flushed=flushed,
            remaining=len(self._event_buffer),
        )

    def _buffer_event(self, event: dict[str, Any]) -> None:
        """Buffer an event for later delivery after WS reconnect."""
        if len(self._event_buffer) >= self.MAX_EVENT_BUFFER_SIZE:
            # Evict oldest non-critical event; fall back to oldest if all critical
            evicted = False
            for i, buffered in enumerate(self._event_buffer):
                if buffered.get("type") not in self.CRITICAL_EVENT_TYPES:
                    self._event_buffer.pop(i)
                    evicted = True
                    break
            if not evicted:
                self._event_buffer.pop(0)

        self._event_buffer.append(event)
        self.log.debug(
            "bridge.event_buffered",
            event_type=event.get("type", "unknown"),
            buffer_size=len(self._event_buffer),
        )

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
            task = asyncio.create_task(self._handle_prompt(cmd))
            self._current_prompt_task = task

            def handle_task_exception(t: asyncio.Task[None], mid: str = message_id) -> None:
                if self._current_prompt_task is t:
                    self._current_prompt_task = None
                if t.cancelled():
                    asyncio.create_task(
                        self._send_event(
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
                        self._send_event(
                            {
                                "type": "execution_complete",
                                "messageId": mid,
                                "success": False,
                                "error": str(exc),
                            }
                        )
                    )

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
        else:
            self.log.debug("bridge.unknown_command", cmd_type=cmd_type)
        return None

    async def _handle_prompt(self, cmd: dict[str, Any]) -> None:
        """Handle prompt command - send to OpenCode and stream response."""
        message_id = cmd.get("messageId") or cmd.get("message_id", "unknown")
        self._inflight_message_id = message_id
        content = cmd.get("content", "")
        model = cmd.get("model")
        reasoning_effort = cmd.get("reasoningEffort")
        author_data = cmd.get("author", {})
        start_time = time.time()
        outcome = "success"

        self.log.info(
            "prompt.start",
            message_id=message_id,
            model=model,
            reasoning_effort=reasoning_effort,
        )

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

        try:
            had_error = False
            error_message = None
            async for event in self._stream_opencode_response_sse(
                message_id, content, model, reasoning_effort
            ):
                if event.get("type") == "error":
                    had_error = True
                    error_message = event.get("error")
                await self._send_event(event)

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
        if not self.http_client:
            raise RuntimeError("HTTP client not initialized")

        resp = await self.http_client.post(
            f"{self.opencode_base_url}/session",
            json={},
            timeout=self.OPENCODE_REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()

        self.opencode_session_id = data.get("id")
        self.log.info(
            "opencode.session.ensure",
            opencode_session_id=self.opencode_session_id,
            action="created",
        )

        await self._save_session_id()

    @staticmethod
    def _extract_error_message(error: Any) -> str | None:
        """Extract message from OpenCode NamedError: { "name": "...", "data": { "message": "..." } }."""
        if isinstance(error, dict):
            data = error.get("data")
            if isinstance(data, dict) and "message" in data:
                return data["message"]
            return error.get("message") or error.get("name")
        return str(error) if error else None

    def _transform_part_to_event(
        self,
        part: dict[str, Any],
        message_id: str,
    ) -> dict[str, Any] | None:
        """Transform a single OpenCode part to a bridge event."""
        part_type = part.get("type")

        if part_type == "text":
            text = part.get("text", "")
            if text:
                return {
                    "type": "token",
                    "content": text,
                    "messageId": message_id,
                }
        elif part_type == "tool":
            state = part.get("state", {})
            status = state.get("status", "")
            tool_input = state.get("input", {})

            self.log.debug(
                "bridge.tool_part",
                tool=part.get("tool"),
                status=status,
            )

            if status in ("pending", "") and not tool_input:
                return None

            return {
                "type": "tool_call",
                "tool": part.get("tool", ""),
                "args": tool_input,
                "callId": part.get("callID", ""),
                "status": status,
                "output": state.get("output", ""),
                "messageId": message_id,
            }
        elif part_type == "step-finish":
            return {
                "type": "step_finish",
                "cost": part.get("cost"),
                "tokens": part.get("tokens"),
                "reason": part.get("reason"),
                "messageId": message_id,
            }
        elif part_type == "step-start":
            return {
                "type": "step_start",
                "messageId": message_id,
            }

        return None

    # Anthropic extended thinking budget tokens by reasoning effort level.
    # "max" uses 31,999 — the API maximum for streaming responses.
    # "high" uses 16,000 — a balanced level for faster responses with good reasoning.
    ANTHROPIC_THINKING_BUDGETS: ClassVar[dict[str, int]] = {
        "high": 16_000,
        "max": 31_999,
    }
    ANTHROPIC_ADAPTIVE_THINKING_MODELS: ClassVar[set[str]] = {
        "claude-opus-4-6",
        "claude-sonnet-4-6",
    }
    ANTHROPIC_ADAPTIVE_EFFORTS: ClassVar[set[str]] = {"low", "medium", "high", "max"}

    def _build_prompt_request_body(
        self,
        content: str,
        model: str | None,
        opencode_message_id: str | None = None,
        reasoning_effort: str | None = None,
    ) -> dict[str, Any]:
        """Build request body for OpenCode prompt requests.

        Args:
            content: The prompt text content
            model: Optional model override (e.g., "claude-haiku-4-5" or "anthropic/claude-haiku-4-5")
            opencode_message_id: OpenCode-compatible ascending message ID (e.g., "msg_...").
                                 When provided, OpenCode uses this as the user message ID,
                                 and assistant responses will have parentID pointing to it.
            reasoning_effort: Optional reasoning effort level (e.g., "high", "max")
        """
        request_body: dict[str, Any] = {"parts": [{"type": "text", "text": content}]}

        if opencode_message_id:
            request_body["messageID"] = opencode_message_id

        if model:
            if "/" in model:
                provider_id, model_id = model.split("/", 1)
            else:
                provider_id, model_id = "anthropic", model
            model_spec: dict[str, Any] = {
                "providerID": provider_id,
                "modelID": model_id,
            }

            if reasoning_effort:
                if provider_id == "anthropic":
                    if model_id in self.ANTHROPIC_ADAPTIVE_THINKING_MODELS:
                        anthropic_options: dict[str, Any] = {
                            "thinking": {"type": "adaptive"},
                        }
                        if reasoning_effort in self.ANTHROPIC_ADAPTIVE_EFFORTS:
                            anthropic_options["outputConfig"] = {"effort": reasoning_effort}
                        model_spec["options"] = anthropic_options
                    else:
                        budget = self.ANTHROPIC_THINKING_BUDGETS.get(reasoning_effort)
                        if budget is not None:
                            model_spec["options"] = {
                                "thinking": {"type": "enabled", "budgetTokens": budget}
                            }
                elif provider_id == "openai":
                    model_spec["options"] = {
                        "reasoningEffort": reasoning_effort,
                        "reasoningSummary": "auto",
                    }

            request_body["model"] = model_spec

        return request_body

    async def _parse_sse_stream(
        self,
        response: httpx.Response,
        timeout_ctx: asyncio.Timeout | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Parse Server-Sent Events stream from OpenCode.

        SSE format:
            data: {"type": "...", "properties": {...}}

            data: {"type": "...", "properties": {...}}

        Events are separated by double newlines.
        If timeout_ctx is provided, the deadline is reset on every chunk received.
        """
        buffer = ""
        async for chunk in response.aiter_text():
            buffer += chunk
            if timeout_ctx is not None:
                timeout_ctx.reschedule(
                    asyncio.get_running_loop().time() + self.sse_inactivity_timeout
                )

            # Process complete events (separated by double newlines)
            while "\n\n" in buffer:
                event_str, buffer = buffer.split("\n\n", 1)

                # Parse the event lines
                data_lines: list[str] = []
                for line in event_str.split("\n"):
                    if line.startswith("data:"):
                        # Handle both "data: {...}" and "data:{...}" formats
                        data_content = line[5:].lstrip()
                        if data_content:
                            data_lines.append(data_content)

                # Join multi-line data and parse JSON
                if data_lines:
                    try:
                        raw_data = "\n".join(data_lines)
                        event = json.loads(raw_data)
                        yield event
                    except json.JSONDecodeError as e:
                        self.log.debug("bridge.sse_parse_error", exc=e)

    async def _stream_opencode_response_sse(
        self,
        message_id: str,
        content: str,
        model: str | None = None,
        reasoning_effort: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Stream response from OpenCode using Server-Sent Events.

        Uses messageID-based correlation for reliable event attribution:
        1. Generate an OpenCode-compatible ascending ID for the user message
        2. OpenCode creates assistant messages with parentID = our ascending ID
        3. Filter events to only process parts from our assistant messages
        4. Use control plane's message_id for events sent back
        5. Track child sessions (sub-tasks) and forward their non-text events
           with isSubtask=True

        The ascending ID ensures our user message ID is lexicographically greater
        than any previous assistant message IDs, preventing the early exit condition
        in OpenCode's prompt loop (lastUser.id < lastAssistant.id).
        """
        if not self.http_client or not self.opencode_session_id:
            raise RuntimeError("OpenCode session not initialized")

        opencode_message_id = OpenCodeIdentifier.ascending("message")
        request_body = self._build_prompt_request_body(
            content, model, opencode_message_id, reasoning_effort
        )

        sse_url = f"{self.opencode_base_url}/event"
        async_url = f"{self.opencode_base_url}/session/{self.opencode_session_id}/prompt_async"

        cumulative_text: dict[str, str] = {}
        emitted_tool_states: set[str] = set()
        allowed_assistant_msg_ids: set[str] = set()
        pending_parts: dict[str, list[tuple[dict[str, Any], Any]]] = {}
        pending_parts_total = 0
        pending_drop_logged = False

        # Child session tracking (sub-tasks)
        tracked_child_session_ids: set[str] = set()

        # Compaction tracking: after compaction, parentID changes so we must
        # accept all non-summary assistant messages from the parent session
        compaction_occurred = False

        start_time = time.time()
        loop = asyncio.get_running_loop()

        def buffer_part(oc_msg_id: str, part: dict[str, Any], delta: Any) -> None:
            nonlocal pending_parts_total
            nonlocal pending_drop_logged
            if pending_parts_total >= self.MAX_PENDING_PART_EVENTS:
                if not pending_drop_logged:
                    self.log.warn(
                        "bridge.pending_parts_dropped",
                        message_id=message_id,
                        limit=self.MAX_PENDING_PART_EVENTS,
                    )
                    pending_drop_logged = True
                return
            pending_parts.setdefault(oc_msg_id, []).append((part, delta))
            pending_parts_total += 1

        def handle_part(
            part: dict[str, Any],
            delta: Any,
            *,
            is_subtask: bool = False,
        ) -> list[dict[str, Any]]:
            part_type = part.get("type", "")
            part_id = part.get("id", "")
            events: list[dict[str, Any]] = []

            if part_type == "text":
                if is_subtask:
                    return events  # Don't forward child text tokens
                text = part.get("text", "")
                if delta:
                    cumulative_text[part_id] = cumulative_text.get(part_id, "") + delta
                else:
                    cumulative_text[part_id] = text

                if cumulative_text.get(part_id):
                    events.append(
                        {
                            "type": "token",
                            "content": cumulative_text[part_id],
                            "messageId": message_id,
                        }
                    )

            elif part_type == "tool":
                tool_event = self._transform_part_to_event(part, message_id)
                if tool_event:
                    state = part.get("state", {})
                    status = state.get("status", "")
                    call_id = part.get("callID", "")
                    part_sid = part.get("sessionID", "")
                    tool_key = f"tool:{part_sid}:{call_id}:{status}"

                    if tool_key not in emitted_tool_states:
                        emitted_tool_states.add(tool_key)
                        events.append(tool_event)

            elif part_type == "step-start":
                events.append(
                    {
                        "type": "step_start",
                        "messageId": message_id,
                    }
                )

            elif part_type == "step-finish":
                events.append(
                    {
                        "type": "step_finish",
                        "cost": part.get("cost"),
                        "tokens": part.get("tokens"),
                        "reason": part.get("reason"),
                        "messageId": message_id,
                    }
                )

            if is_subtask:
                for ev in events:
                    ev["isSubtask"] = True
            return events

        try:
            deadline = asyncio.get_running_loop().time() + self.sse_inactivity_timeout
            async with asyncio.timeout_at(deadline) as timeout_ctx:
                async with self.http_client.stream(
                    "GET",
                    sse_url,
                    timeout=httpx.Timeout(None, connect=self.HTTP_CONNECT_TIMEOUT, read=None),
                ) as sse_response:
                    if sse_response.status_code != 200:
                        raise SSEConnectionError(
                            f"SSE connection failed: {sse_response.status_code}"
                        )

                    prompt_start = loop.time()
                    prompt_response = await self.http_client.post(
                        async_url,
                        json=request_body,
                        timeout=self.OPENCODE_REQUEST_TIMEOUT,
                    )
                    if prompt_response.status_code not in [200, 204]:
                        error_body = prompt_response.text
                        self.log.error(
                            "bridge.prompt_request_error",
                            status_code=prompt_response.status_code,
                            error_body=error_body,
                        )
                        raise RuntimeError(
                            f"Async prompt failed: {prompt_response.status_code} - {error_body}"
                        )

                    async for event in self._parse_sse_stream(sse_response, timeout_ctx):
                        event_type = event.get("type")
                        props = event.get("properties", {})

                        if event_type == "server.connected":
                            pass
                        elif event_type != "server.heartbeat":
                            # Track direct child sessions before filtering
                            if event_type == "session.created":
                                info = props.get("info", {})
                                child_id = info.get("id")
                                child_parent = info.get("parentID")
                                if child_id and child_parent == self.opencode_session_id:
                                    tracked_child_session_ids.add(child_id)
                                    self.log.info(
                                        "bridge.child_session_detected",
                                        child_session_id=child_id,
                                        source="session.created",
                                    )
                                # Always continue: no downstream handler processes session.created,
                                # and non-matching events would just fall through to no-op.
                                continue

                            event_session_id = props.get("sessionID") or props.get("part", {}).get(
                                "sessionID"
                            )
                            is_child = event_session_id in tracked_child_session_ids
                            if (
                                not event_session_id
                                or event_session_id == self.opencode_session_id
                                or is_child
                            ):
                                if event_type == "message.updated":
                                    info = props.get("info", {})
                                    msg_session_id = info.get("sessionID")
                                    if msg_session_id == self.opencode_session_id:
                                        oc_msg_id = info.get("id", "")
                                        parent_id = info.get("parentID", "")
                                        role = info.get("role", "")
                                        finish = info.get("finish", "")

                                        parent_matches = parent_id == opencode_message_id
                                        is_compaction_summary = info.get("summary") is True

                                        self.log.debug(
                                            "bridge.message_updated",
                                            role=role,
                                            oc_msg_id=oc_msg_id,
                                            parent_match=parent_matches,
                                            compaction_occurred=compaction_occurred,
                                            is_compaction_summary=is_compaction_summary,
                                        )

                                        if role == "assistant" and oc_msg_id:
                                            # Accept if: parentID matches our message,
                                            # OR compaction happened and this isn't the
                                            # compaction summary itself
                                            if parent_matches or (
                                                compaction_occurred and not is_compaction_summary
                                            ):
                                                allowed_assistant_msg_ids.add(oc_msg_id)
                                                pending = pending_parts.pop(oc_msg_id, [])
                                                if pending:
                                                    pending_parts_total -= len(pending)
                                                    for part, delta in pending:
                                                        for part_event in handle_part(part, delta):
                                                            yield part_event

                                        if finish and finish not in ("tool-calls", ""):
                                            self.log.debug(
                                                "bridge.message_finished",
                                                finish=finish,
                                            )

                                    elif msg_session_id in tracked_child_session_ids:
                                        # Child session: authorize all assistant messages
                                        oc_msg_id = info.get("id", "")
                                        role = info.get("role", "")
                                        if role == "assistant" and oc_msg_id:
                                            allowed_assistant_msg_ids.add(oc_msg_id)
                                            pending = pending_parts.pop(oc_msg_id, [])
                                            if pending:
                                                pending_parts_total -= len(pending)
                                                for part, delta in pending:
                                                    for ev in handle_part(
                                                        part, delta, is_subtask=True
                                                    ):
                                                        yield ev

                                elif event_type == "message.part.updated":
                                    part = props.get("part", {})
                                    delta = props.get("delta")
                                    oc_msg_id = part.get("messageID", "")
                                    part_session_id = part.get("sessionID", "")

                                    # Discover child sessions from task tool metadata (covers task_id resume)
                                    if (
                                        part.get("tool") == "task"
                                        and part_session_id == self.opencode_session_id
                                    ):
                                        metadata = part.get("metadata")
                                        child_sid = (
                                            metadata.get("sessionId")
                                            if isinstance(metadata, dict)
                                            else None
                                        )
                                        if child_sid and child_sid not in tracked_child_session_ids:
                                            tracked_child_session_ids.add(child_sid)
                                            self.log.info(
                                                "bridge.child_session_detected",
                                                child_session_id=child_sid,
                                                source="task_metadata",
                                            )

                                    if oc_msg_id in allowed_assistant_msg_ids:
                                        if part_session_id in tracked_child_session_ids:
                                            for ev in handle_part(part, delta, is_subtask=True):
                                                yield ev
                                        else:
                                            for part_event in handle_part(part, delta):
                                                yield part_event
                                    elif oc_msg_id:
                                        buffer_part(oc_msg_id, part, delta)

                                elif event_type == "session.idle":
                                    idle_session_id = props.get("sessionID")
                                    # Only parent idle terminates the stream
                                    if idle_session_id == self.opencode_session_id:
                                        elapsed = time.time() - start_time
                                        self.log.debug(
                                            "bridge.session_idle",
                                            elapsed_s=round(elapsed, 1),
                                            tracked_msgs=len(allowed_assistant_msg_ids),
                                        )
                                        async for final_event in self._fetch_final_message_state(
                                            message_id,
                                            opencode_message_id,
                                            cumulative_text,
                                            allowed_assistant_msg_ids,
                                            compaction_occurred=compaction_occurred,
                                        ):
                                            yield final_event
                                        return

                                elif event_type == "session.status":
                                    status_session_id = props.get("sessionID")
                                    status = props.get("status", {})
                                    # Only parent status=idle terminates the stream
                                    if (
                                        status_session_id == self.opencode_session_id
                                        and status.get("type") == "idle"
                                    ):
                                        elapsed = time.time() - start_time
                                        self.log.debug(
                                            "bridge.session_status_idle",
                                            elapsed_s=round(elapsed, 1),
                                            tracked_msgs=len(allowed_assistant_msg_ids),
                                        )
                                        async for final_event in self._fetch_final_message_state(
                                            message_id,
                                            opencode_message_id,
                                            cumulative_text,
                                            allowed_assistant_msg_ids,
                                            compaction_occurred=compaction_occurred,
                                        ):
                                            yield final_event
                                        return

                                elif event_type == "session.error":
                                    error_session_id = props.get("sessionID")
                                    if error_session_id == self.opencode_session_id:
                                        error_msg = self._extract_error_message(
                                            props.get("error", {})
                                        )
                                        self.log.error("bridge.session_error", error_msg=error_msg)
                                        yield {
                                            "type": "error",
                                            "error": error_msg or "Unknown error",
                                            "messageId": message_id,
                                        }
                                        return
                                    elif error_session_id in tracked_child_session_ids:
                                        error_msg = self._extract_error_message(
                                            props.get("error", {})
                                        )
                                        self.log.error(
                                            "bridge.child_session_error",
                                            error_msg=error_msg,
                                            child_session_id=error_session_id,
                                        )
                                        yield {
                                            "type": "error",
                                            "error": error_msg or "Sub-task error",
                                            "messageId": message_id,
                                            "isSubtask": True,
                                        }
                                        # No return — parent stream continues

                                elif event_type == "session.compacted":
                                    compacted_session_id = props.get("sessionID")
                                    if compacted_session_id == self.opencode_session_id:
                                        compaction_occurred = True
                                        self.log.info(
                                            "bridge.session_compacted",
                                            message_id=message_id,
                                        )

                        if loop.time() > prompt_start + self.PROMPT_MAX_DURATION:
                            elapsed = time.time() - start_time
                            self.log.error(
                                "bridge.prompt_max_duration_timeout",
                                timeout_ms=int(self.PROMPT_MAX_DURATION * 1000),
                                elapsed_ms=int(elapsed * 1000),
                                message_id=message_id,
                            )
                            await self._request_opencode_stop(reason="prompt_max_duration_timeout")
                            async for final_event in self._fetch_final_message_state(
                                message_id,
                                opencode_message_id,
                                cumulative_text,
                                allowed_assistant_msg_ids,
                                compaction_occurred=compaction_occurred,
                            ):
                                yield final_event
                            raise RuntimeError(
                                f"Prompt exceeded max duration of {self.PROMPT_MAX_DURATION:.0f}s."
                            )

        except TimeoutError:
            elapsed = time.time() - start_time
            self.log.error(
                "bridge.sse_inactivity_timeout",
                timeout_name="sse_inactivity",
                timeout_ms=int(self.sse_inactivity_timeout * 1000),
                elapsed_ms=int(elapsed * 1000),
                operation="bridge.sse",
                message_id=message_id,
            )
            await self._request_opencode_stop(reason="inactivity_timeout")
            async for final_event in self._fetch_final_message_state(
                message_id,
                opencode_message_id,
                cumulative_text,
                allowed_assistant_msg_ids,
                compaction_occurred=compaction_occurred,
            ):
                yield final_event
            raise RuntimeError(
                f"SSE stream inactive for {self.sse_inactivity_timeout:.0f}s "
                f"(no data received). Total elapsed: {elapsed:.0f}s"
            )

        except httpx.ReadError as e:
            self.log.error("bridge.sse_read_error", exc=e)
            raise SSEConnectionError(f"SSE read error: {e}")

    async def _fetch_final_message_state(
        self,
        message_id: str,
        opencode_message_id: str,
        cumulative_text: dict[str, str],
        tracked_msg_ids: set[str] | None = None,
        compaction_occurred: bool = False,
    ) -> AsyncIterator[dict[str, Any]]:
        """Fetch final message state from API to ensure complete text.

        This is called after session.idle to capture any text that may have
        been missed due to SSE event ordering. It fetches the latest message
        state and emits any text that's longer than what we've already sent.

        Args:
            message_id: Control plane message ID (used in events sent back)
            opencode_message_id: OpenCode ascending ID (used for parentID correlation)
            cumulative_text: Text already sent, keyed by part ID
            tracked_msg_ids: Assistant message IDs tracked during SSE streaming
            compaction_occurred: Whether session compaction happened during this prompt.
                When True, accepts non-summary assistant messages even if parentID
                doesn't match, since compaction changes the message chain.

        Uses parentID-based correlation if available, falling back to
        tracked_msg_ids from SSE streaming if parentID doesn't match.
        """
        if not self.http_client or not self.opencode_session_id:
            return

        messages_url = f"{self.opencode_base_url}/session/{self.opencode_session_id}/message"

        try:
            response = await self.http_client.get(
                messages_url,
                timeout=self.OPENCODE_REQUEST_TIMEOUT,
            )
            if response.status_code != 200:
                self.log.warn(
                    "bridge.final_state_fetch_error",
                    status_code=response.status_code,
                )
                return

            messages = response.json()

            for msg in messages:
                info = msg.get("info", {})
                role = info.get("role", "")
                msg_id = info.get("id", "")
                parent_id = info.get("parentID", "")

                if role != "assistant":
                    continue

                parent_matches = parent_id == opencode_message_id
                in_tracked_set = tracked_msg_ids and msg_id in tracked_msg_ids
                is_compaction_summary = info.get("summary") is True

                # Accept if: parentID matches, was tracked during SSE, or
                # compaction occurred and this isn't the summary message
                should_accept = (
                    parent_matches
                    or in_tracked_set
                    or (compaction_occurred and not is_compaction_summary)
                )
                if not should_accept:
                    continue

                parts = msg.get("parts", [])
                for part in parts:
                    part_type = part.get("type", "")
                    part_id = part.get("id", "")

                    if part_type == "text":
                        text = part.get("text", "")
                        previously_sent = cumulative_text.get(part_id, "")
                        if len(text) > len(previously_sent):
                            self.log.debug(
                                "bridge.final_text_update",
                                prev_len=len(previously_sent),
                                new_len=len(text),
                            )
                            cumulative_text[part_id] = text
                            yield {
                                "type": "token",
                                "content": text,
                                "messageId": message_id,
                            }

        except Exception as e:
            self.log.error("bridge.final_state_error", exc=e)

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
        """Handle push command using provider-generated push spec."""
        push_spec = cmd.get("pushSpec") if isinstance(cmd.get("pushSpec"), dict) else None
        branch_name = str(push_spec.get("targetBranch", "")).strip() if push_spec else ""

        self.log.info(
            "git.push_start",
            branch_name=branch_name,
            mode="push_spec",
        )

        repo_dirs = list(self.repo_path.glob("*/.git"))
        if not repo_dirs:
            self.log.warn("git.push_error", reason="no_repository")
            await self._send_event(
                {
                    "type": "push_error",
                    "error": "No repository found",
                }
            )
            return

        repo_dir = repo_dirs[0].parent

        try:
            if not push_spec:
                self.log.warn("git.push_error", reason="missing_push_spec")
                await self._send_event(
                    {
                        "type": "push_error",
                        "error": "Push failed - missing push specification",
                        "branchName": branch_name,
                    }
                )
                return

            if not branch_name:
                self.log.warn("git.push_error", reason="missing_target_branch")
                await self._send_event(
                    {
                        "type": "push_error",
                        "error": "Push failed - missing target branch",
                        "branchName": "",
                    }
                )
                return

            refspec = str(push_spec.get("refspec", "")).strip()
            push_url = str(push_spec.get("remoteUrl", "")).strip()
            redacted_push_url = str(push_spec.get("redactedRemoteUrl", "")).strip()
            force_push = bool(push_spec.get("force", False))

            if not refspec or not push_url:
                self.log.warn("git.push_error", reason="invalid_push_spec")
                await self._send_event(
                    {
                        "type": "push_error",
                        "error": "Push failed - invalid push specification",
                        "branchName": branch_name,
                    }
                )
                return

            self.log.info(
                "git.push_command",
                branch_name=branch_name,
                refspec=refspec,
                force=force_push,
                remote_url=redacted_push_url,
            )

            result = await asyncio.create_subprocess_exec(
                "git",
                "push",
                push_url,
                refspec,
                *(["-f"] if force_push else []),
                cwd=repo_dir,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            _stdout, _stderr = await result.communicate()

            if result.returncode != 0:
                self.log.warn("git.push_failed", branch_name=branch_name)
                await self._send_event(
                    {
                        "type": "push_error",
                        "error": "Push failed - authentication may be required",
                        "branchName": branch_name,
                    }
                )
            else:
                self.log.info("git.push_complete", branch_name=branch_name)
                await self._send_event(
                    {
                        "type": "push_complete",
                        "branchName": branch_name,
                    }
                )

        except Exception as e:
            self.log.error("git.push_error", exc=e, branch_name=branch_name)
            await self._send_event(
                {
                    "type": "push_error",
                    "error": str(e),
                    "branchName": branch_name,
                }
            )

    async def _configure_git_identity(self, user: GitUser) -> None:
        """Configure git identity for commit attribution."""
        self.log.debug("git.identity_configure", git_name=user.name, git_email=user.email)

        repo_dirs = list(self.repo_path.glob("*/.git"))
        if not repo_dirs:
            self.log.debug("git.identity_skip", reason="no_repository")
            return

        repo_dir = repo_dirs[0].parent

        try:
            subprocess.run(
                ["git", "config", "--local", "user.name", user.name],
                cwd=repo_dir,
                check=True,
            )
            subprocess.run(
                ["git", "config", "--local", "user.email", user.email],
                cwd=repo_dir,
                check=True,
            )
        except subprocess.CalledProcessError as e:
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
                        resp = await self.http_client.get(
                            f"{self.opencode_base_url}/session/{self.opencode_session_id}",
                            timeout=self.OPENCODE_REQUEST_TIMEOUT,
                        )
                        if resp.status_code != 200:
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

        try:
            await self.http_client.post(
                f"{self.opencode_base_url}/session/{self.opencode_session_id}/abort",
                timeout=self.OPENCODE_REQUEST_TIMEOUT,
            )
            self.log.info("bridge.stop_requested", reason=reason)
            return True
        except Exception as e:
            self.log.warn("bridge.stop_request_error", exc=e, reason=reason)
            return False

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


async def main():
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

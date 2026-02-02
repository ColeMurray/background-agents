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
import json
import os
import secrets
import subprocess
import tempfile
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, ClassVar, NamedTuple

import httpx
import websockets
from websockets import ClientConnection, State

from .sandbox_types import GitUser


class TokenResolution(NamedTuple):
    """Result of GitHub token resolution."""

    token: str
    source: str


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
    MAX_BUFFERED_PARTS = 10000  # Prevent unbounded memory growth

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

        self.ws: ClientConnection | None = None
        self.shutdown_event = asyncio.Event()
        self.git_sync_complete = asyncio.Event()

        # Session state
        self.opencode_session_id: str | None = None
        self.session_id_file = Path(tempfile.gettempdir()) / "opencode-session-id"
        self.repo_path = Path("/workspace")

        # HTTP client for OpenCode API
        self.http_client: httpx.AsyncClient | None = None

    @property
    def ws_url(self) -> str:
        """WebSocket URL for control plane connection."""
        url = self.control_plane_url.replace("https://", "wss://").replace("http://", "ws://")
        return f"{url}/sessions/{self.session_id}/ws?type=sandbox"

    async def run(self) -> None:
        """Main bridge loop with reconnection handling."""
        print(f"[bridge] Starting bridge for sandbox {self.sandbox_id}")

        self.http_client = httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=30.0))
        await self._load_session_id()

        reconnect_attempts = 0

        try:
            while not self.shutdown_event.is_set():
                try:
                    await self._connect_and_run()
                    reconnect_attempts = 0
                except websockets.ConnectionClosed as e:
                    print(f"[bridge] Connection closed: {e}")
                except Exception as e:
                    print(f"[bridge] Connection error: {e}")

                if self.shutdown_event.is_set():
                    break

                reconnect_attempts += 1
                delay = min(
                    self.RECONNECT_BACKOFF_BASE**reconnect_attempts,
                    self.RECONNECT_MAX_DELAY,
                )
                print(f"[bridge] Reconnecting in {delay:.1f}s (attempt {reconnect_attempts})...")
                await asyncio.sleep(delay)

        finally:
            if self.http_client:
                await self.http_client.aclose()

    async def _connect_and_run(self) -> None:
        """Connect to control plane and handle messages."""
        print(f"[bridge] Connecting to {self.ws_url}")

        additional_headers = {
            "Authorization": f"Bearer {self.auth_token}",
            "X-Sandbox-ID": self.sandbox_id,
        }

        async with websockets.connect(
            self.ws_url,
            additional_headers=additional_headers,
            ping_interval=20,
            ping_timeout=10,
        ) as ws:
            self.ws = ws
            print("[bridge] Connected to control plane")

            await self._send_event(
                {
                    "type": "ready",
                    "sandboxId": self.sandbox_id,
                    "opencodeSessionId": self.opencode_session_id,
                }
            )

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
                        print(f"[bridge] Invalid message: {e}")
                    except Exception as e:
                        print(f"[bridge] Error handling command: {e}")

            finally:
                heartbeat_task.cancel()
                for task in background_tasks:
                    task.cancel()
                self.ws = None

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
        """Send event to control plane."""
        event_type = event.get("type", "unknown")

        if not self.ws:
            print(f"[bridge] Cannot send {event_type}: WebSocket is None")
            return
        if self.ws.state != State.OPEN:
            print(f"[bridge] Cannot send {event_type}: WebSocket state is {self.ws.state}")
            return

        event["sandboxId"] = self.sandbox_id
        event["timestamp"] = event.get("timestamp", time.time())

        try:
            await self.ws.send(json.dumps(event))
            print(f"[bridge] Sent event: {event_type}")
        except Exception as e:
            print(f"[bridge] Failed to send {event_type} event: {e}")

    async def _handle_command(self, cmd: dict[str, Any]) -> asyncio.Task[None] | None:
        """Handle command from control plane.

        Long-running commands (like prompt) are run as background tasks to keep
        the WebSocket listener responsive to other commands (like push).

        Returns a Task for long-running commands, None for immediate commands.
        """
        cmd_type = cmd.get("type")
        print(f"[bridge] Received command: {cmd_type}")

        if cmd_type == "prompt":
            message_id = cmd.get("messageId") or cmd.get("message_id", "unknown")
            task = asyncio.create_task(self._handle_prompt(cmd))

            def handle_task_exception(t: asyncio.Task[None], mid: str = message_id) -> None:
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
            return task
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
        elif cmd_type == "getElementAtPoint":
            await self._handle_get_element_at_point(cmd)
        else:
            print(f"[bridge] Unknown command type: {cmd_type}")
        return None

    async def _handle_prompt(self, cmd: dict[str, Any]) -> None:
        """Handle prompt command - send to OpenCode and stream response."""
        message_id = cmd.get("messageId") or cmd.get("message_id", "unknown")
        content = cmd.get("content", "")
        model = cmd.get("model")
        author_data = cmd.get("author", {})

        print(f"[bridge] Processing prompt {message_id} with model {model}, author={author_data}")

        github_name = author_data.get("githubName")
        github_email = author_data.get("githubEmail")
        if github_name and github_email:
            await self._configure_git_identity(
                GitUser(
                    name=github_name,
                    email=github_email,
                )
            )

        if not self.opencode_session_id:
            await self._create_opencode_session()

        try:
            async for event in self._stream_opencode_response_sse(message_id, content, model):
                await self._send_event(event)

            await self._send_event(
                {
                    "type": "execution_complete",
                    "messageId": message_id,
                    "success": True,
                }
            )

        except Exception as e:
            print(f"[bridge] Error processing prompt: {e}")
            await self._send_event(
                {
                    "type": "execution_complete",
                    "messageId": message_id,
                    "success": False,
                    "error": str(e),
                }
            )

    async def _create_opencode_session(self) -> None:
        """Create a new OpenCode session."""
        print("[bridge] Creating OpenCode session...")

        if not self.http_client:
            raise RuntimeError("HTTP client not initialized")

        resp = await self.http_client.post(
            f"{self.opencode_base_url}/session",
            json={},
        )
        resp.raise_for_status()
        data = resp.json()

        self.opencode_session_id = data.get("id")
        print(f"[bridge] Created OpenCode session: {self.opencode_session_id}")

        await self._save_session_id()

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
            # OpenCode may put tool args in state.input, state.args, state.raw, or top-level part.input / part.args
            tool_input = (
                state.get("input")
                or state.get("args")
                or part.get("input")
                or part.get("args")
                or {}
            )
            if not isinstance(tool_input, dict):
                tool_input = {}
            # OpenCode sometimes sends raw JSON in state.raw when state.input is empty (e.g. first part update)
            if not tool_input and state.get("raw") is not None:
                raw = state.get("raw")
                if isinstance(raw, dict):
                    tool_input = raw
                elif isinstance(raw, str) and raw.strip():
                    try:
                        parsed = json.loads(raw)
                        if isinstance(parsed, dict):
                            tool_input = parsed
                    except (json.JSONDecodeError, TypeError):
                        pass

            output = state.get("output", "")
            tool_name = part.get("tool", "")
            has_todos = isinstance(tool_input.get("todos"), list)
            print(
                f"[bridge] Tool part: tool={tool_name}, status={status}, "
                f"input_keys={list(tool_input.keys()) if tool_input else 'empty'}, has_todos={has_todos}"
            )
            if status == "error" and output:
                print(
                    f"[bridge] Tool error output: {output[:500]}{'...' if len(output) > 500 else ''}"
                )

            # Skip only when we have no args and part is still pending (args may arrive in a later update)
            if status in ("pending", "") and not tool_input:
                print(
                    f"[bridge] Skipping tool_call (no input yet): part_keys={list(part.keys())}, "
                    f"state_keys={list(state.keys()) if state else []}"
                )
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

    def _build_prompt_request_body(
        self, content: str, model: str | None, opencode_message_id: str | None = None
    ) -> dict[str, Any]:
        """Build request body for OpenCode prompt requests.

        Args:
            content: The prompt text content
            model: Optional model override (e.g., "claude-haiku-4-5" or "anthropic/claude-haiku-4-5")
            opencode_message_id: OpenCode-compatible ascending message ID (e.g., "msg_...").
                                 When provided, OpenCode uses this as the user message ID,
                                 and assistant responses will have parentID pointing to it.
        """
        request_body: dict[str, Any] = {"parts": [{"type": "text", "text": content}]}

        if opencode_message_id:
            request_body["messageID"] = opencode_message_id
            print(f"[bridge] Building prompt request, messageID={opencode_message_id}")

        if model:
            if "/" in model:
                provider_id, model_id = model.split("/", 1)
            else:
                provider_id, model_id = "anthropic", model
            request_body["model"] = {
                "providerID": provider_id,
                "modelID": model_id,
            }

        return request_body

    async def _parse_sse_stream(
        self,
        response: httpx.Response,
    ) -> AsyncIterator[dict[str, Any]]:
        """Parse Server-Sent Events stream from OpenCode.

        SSE format:
            data: {"type": "...", "properties": {...}}

            data: {"type": "...", "properties": {...}}

        Events are separated by double newlines.
        """
        buffer = ""
        async for chunk in response.aiter_text():
            buffer += chunk

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
                        print(f"[bridge] SSE JSON parse error: {e}")

    async def _stream_opencode_response_sse(
        self,
        message_id: str,
        content: str,
        model: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Stream response from OpenCode using Server-Sent Events.

        Uses messageID-based correlation for reliable event attribution:
        1. Generate an OpenCode-compatible ascending ID for the user message
        2. OpenCode creates assistant messages with parentID = our ascending ID
        3. Filter events to only process parts from our assistant messages
        4. Use control plane's message_id for events sent back

        The ascending ID ensures our user message ID is lexicographically greater
        than any previous assistant message IDs, preventing the early exit condition
        in OpenCode's prompt loop (lastUser.id < lastAssistant.id).
        """
        if not self.http_client or not self.opencode_session_id:
            raise RuntimeError("OpenCode session not initialized")

        opencode_message_id = OpenCodeIdentifier.ascending("message")
        request_body = self._build_prompt_request_body(content, model, opencode_message_id)

        sse_url = f"{self.opencode_base_url}/event"
        async_url = f"{self.opencode_base_url}/session/{self.opencode_session_id}/prompt_async"

        print(f"[bridge] Connecting to SSE endpoint: {sse_url}, messageID={opencode_message_id}")

        cumulative_text: dict[str, str] = {}
        emitted_tool_states: set[str] = set()
        our_assistant_msg_ids: set[str] = set()
        # Parts that arrived before we saw message.updated; flush when we see assistant msg
        buffered_parts_by_msg_id: dict[str, list[dict[str, Any]]] = {}

        max_wait_time = 600.0  # Increased from 300s to support longer-running agents
        start_time = time.time()
        last_token_time = time.time()  # Track when we last received a token

        try:
            async with asyncio.timeout(max_wait_time):
                async with self.http_client.stream(
                    "GET",
                    sse_url,
                    timeout=httpx.Timeout(max_wait_time, connect=30.0),
                ) as sse_response:
                    if sse_response.status_code != 200:
                        raise SSEConnectionError(
                            f"SSE connection failed: {sse_response.status_code}"
                        )

                    print("[bridge] SSE connected, sending prompt...")

                    prompt_response = await self.http_client.post(
                        async_url,
                        json=request_body,
                        timeout=30.0,
                    )
                    if prompt_response.status_code not in [200, 204]:
                        error_body = prompt_response.text
                        print(f"[bridge] Prompt request body: {json.dumps(request_body)}")
                        print(f"[bridge] Prompt error response: {error_body}")
                        raise RuntimeError(
                            f"Async prompt failed: {prompt_response.status_code} - {error_body}"
                        )

                    print("[bridge] Prompt sent, processing SSE events...")

                    async for event in self._parse_sse_stream(sse_response):
                        event_type = event.get("type")
                        props = event.get("properties", {})

                        if event_type == "server.connected":
                            print("[bridge] SSE server.connected received")
                            continue

                        if event_type == "server.heartbeat":
                            # Reset last_token_time on heartbeat to keep control plane alive
                            last_token_time = time.time()
                            continue

                        event_session_id = props.get("sessionID") or props.get("part", {}).get(
                            "sessionID"
                        )
                        if event_session_id and event_session_id != self.opencode_session_id:
                            continue

                        if event_type == "message.updated":
                            info = props.get("info", {})
                            msg_session_id = info.get("sessionID")
                            if msg_session_id == self.opencode_session_id:
                                oc_msg_id = info.get("id", "")
                                parent_id = info.get("parentID", "")
                                role = info.get("role", "")
                                finish = info.get("finish", "")

                                print(
                                    f"[bridge] message.updated: role={role}, id={oc_msg_id}, "
                                    f"parentID={parent_id}, expected={opencode_message_id}, "
                                    f"match={parent_id == opencode_message_id}"
                                )

                                if (
                                    role == "assistant"
                                    and parent_id == opencode_message_id
                                    and oc_msg_id
                                ):
                                    our_assistant_msg_ids.add(oc_msg_id)
                                    print(
                                        f"[bridge] Tracking assistant message {oc_msg_id} "
                                        f"(parentID matched)"
                                    )
                                    # Flush parts that arrived before this message.updated
                                    for part in buffered_parts_by_msg_id.pop(oc_msg_id, []):
                                        part_type = part.get("type", "")
                                        part_id = part.get("id", "")
                                        delta = part.get("delta")
                                        if part_type == "text":
                                            text = part.get("text", "")
                                            if delta:
                                                cumulative_text[part_id] = (
                                                    cumulative_text.get(part_id, "") + delta
                                                )
                                            else:
                                                cumulative_text[part_id] = text
                                            if cumulative_text.get(part_id):
                                                last_token_time = time.time()
                                                # Send heartbeat to control plane every 30s to prevent timeout
                                                elapsed_since_heartbeat = time.time() - start_time
                                                if elapsed_since_heartbeat > 30 and elapsed_since_heartbeat % 30 < 0.5:
                                                    await self._send_event({
                                                        "type": "sse_heartbeat",
                                                        "messageId": message_id,
                                                    })
                                                yield {
                                                    "type": "token",
                                                    "content": cumulative_text[part_id],
                                                    "messageId": message_id,
                                                }
                                        elif part_type == "tool":
                                            tool_event = self._transform_part_to_event(
                                                part, message_id
                                            )
                                            if tool_event:
                                                state = part.get("state", {})
                                                status = state.get("status", "")
                                                call_id = part.get("callID", "")
                                                tool_key = f"tool:{call_id}:{status}"
                                                if tool_key not in emitted_tool_states:
                                                    emitted_tool_states.add(tool_key)
                                                    yield tool_event
                                        elif part_type == "step-start":
                                            yield {
                                                "type": "step_start",
                                                "messageId": message_id,
                                            }
                                        elif part_type == "step-finish":
                                            yield {
                                                "type": "step_finish",
                                                "cost": part.get("cost"),
                                                "tokens": part.get("tokens"),
                                                "reason": part.get("reason"),
                                                "messageId": message_id,
                                            }

                                if finish and finish not in ("tool-calls", ""):
                                    print(f"[bridge] SSE message finished (finish={finish})")
                                # Discard buffered parts for user messages (never emit them)
                                if role == "user" and oc_msg_id:
                                    buffered_parts_by_msg_id.pop(oc_msg_id, None)
                            continue

                        if event_type == "message.part.updated":
                            part = props.get("part", {})
                            delta = props.get("delta")
                            part_type = part.get("type", "")
                            part_id = part.get("id", "")
                            oc_msg_id = part.get("messageID", "")

                            # Only emit parts from assistant messages; buffer until we know role
                            if oc_msg_id not in our_assistant_msg_ids:
                                # Enforce buffer size limit to prevent memory bloat
                                total_buffered = sum(
                                    len(parts) for parts in buffered_parts_by_msg_id.values()
                                )
                                if total_buffered < self.MAX_BUFFERED_PARTS:
                                    buffered_parts_by_msg_id.setdefault(oc_msg_id, []).append(part)
                                else:
                                    print(
                                        f"[bridge] Buffer full ({total_buffered} parts), "
                                        f"dropping part for {oc_msg_id}"
                                    )
                                continue

                            if part_type == "text":
                                text = part.get("text", "")
                                if delta:
                                    cumulative_text[part_id] = (
                                        cumulative_text.get(part_id, "") + delta
                                    )
                                else:
                                    cumulative_text[part_id] = text

                                if cumulative_text.get(part_id):
                                    last_token_time = time.time()
                                    # Send heartbeat to control plane every 30s to prevent timeout
                                    elapsed_since_heartbeat = time.time() - start_time
                                    if elapsed_since_heartbeat > 30 and elapsed_since_heartbeat % 30 < 0.5:
                                        await self._send_event({
                                            "type": "sse_heartbeat",
                                            "messageId": message_id,
                                        })
                                    yield {
                                        "type": "token",
                                        "content": cumulative_text[part_id],
                                        "messageId": message_id,
                                    }

                            elif part_type == "tool":
                                tool_event = self._transform_part_to_event(part, message_id)
                                if tool_event:
                                    state = part.get("state", {})
                                    status = state.get("status", "")
                                    call_id = part.get("callID", "")
                                    tool_key = f"tool:{call_id}:{status}"

                                    if tool_key not in emitted_tool_states:
                                        emitted_tool_states.add(tool_key)
                                        yield tool_event

                            elif part_type == "step-start":
                                yield {
                                    "type": "step_start",
                                    "messageId": message_id,
                                }

                            elif part_type == "step-finish":
                                yield {
                                    "type": "step_finish",
                                    "cost": part.get("cost"),
                                    "tokens": part.get("tokens"),
                                    "reason": part.get("reason"),
                                    "messageId": message_id,
                                }

                        elif event_type == "session.idle":
                            idle_session_id = props.get("sessionID")
                            if idle_session_id == self.opencode_session_id:
                                elapsed = time.time() - start_time
                                print(
                                    f"[bridge] SSE session.idle received after {elapsed:.1f}s, "
                                    f"fetching final state..."
                                )
                                print(
                                    f"[bridge] Tracked {len(our_assistant_msg_ids)} assistant messages: "
                                    f"{our_assistant_msg_ids}"
                                )
                                async for final_event in self._fetch_final_message_state(
                                    message_id,
                                    opencode_message_id,
                                    cumulative_text,
                                    our_assistant_msg_ids,
                                ):
                                    yield final_event
                                return

                        elif event_type == "session.status":
                            status_session_id = props.get("sessionID")
                            status = props.get("status", {})
                            if (
                                status_session_id == self.opencode_session_id
                                and status.get("type") == "idle"
                            ):
                                elapsed = time.time() - start_time
                                print(
                                    f"[bridge] SSE session.status idle received after {elapsed:.1f}s, "
                                    f"fetching final state..."
                                )
                                print(
                                    f"[bridge] Tracked {len(our_assistant_msg_ids)} assistant messages: "
                                    f"{our_assistant_msg_ids}"
                                )
                                async for final_event in self._fetch_final_message_state(
                                    message_id,
                                    opencode_message_id,
                                    cumulative_text,
                                    our_assistant_msg_ids,
                                ):
                                    yield final_event
                                return

                        elif event_type == "session.error":
                            error_session_id = props.get("sessionID")
                            if error_session_id == self.opencode_session_id:
                                error = props.get("error", {})
                                error_msg = (
                                    error.get("message") if isinstance(error, dict) else str(error)
                                )
                                print(f"[bridge] SSE session.error: {error_msg}")
                                yield {
                                    "type": "error",
                                    "error": error_msg or "Unknown error",
                                    "messageId": message_id,
                                }
                                return

        except TimeoutError:
            elapsed = time.time() - start_time
            print(f"[bridge] SSE stream timed out after {elapsed:.1f}s, attempting polling fallback...")
            # Try polling fallback to recover remaining events
            async for final_event in self._fetch_final_message_state(
                message_id,
                opencode_message_id,
                cumulative_text,
                our_assistant_msg_ids,
            ):
                yield final_event
            return

        except httpx.ReadError as e:
            print(f"[bridge] SSE read error: {e}")
            raise SSEConnectionError(f"SSE read error: {e}")

    async def _fetch_final_message_state(
        self,
        message_id: str,
        opencode_message_id: str,
        cumulative_text: dict[str, str],
        tracked_msg_ids: set[str] | None = None,
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

        Uses parentID-based correlation if available, falling back to
        tracked_msg_ids from SSE streaming if parentID doesn't match.
        """
        if not self.http_client or not self.opencode_session_id:
            return

        messages_url = f"{self.opencode_base_url}/session/{self.opencode_session_id}/message"

        try:
            response = await self.http_client.get(messages_url, timeout=10.0)
            if response.status_code != 200:
                print(f"[bridge] Final state fetch failed: {response.status_code}")
                return

            messages = response.json()

            print(
                f"[bridge] Final state fetch: got {len(messages)} messages, "
                f"looking for parentID={opencode_message_id}"
            )

            matched_count = 0
            for msg in messages:
                info = msg.get("info", {})
                role = info.get("role", "")
                msg_id = info.get("id", "")
                parent_id = info.get("parentID", "")

                if role == "assistant":
                    print(
                        f"[bridge] Assistant message: id={msg_id}, parentID={parent_id}, "
                        f"match={parent_id == opencode_message_id}"
                    )

                if role != "assistant":
                    continue

                parent_matches = parent_id == opencode_message_id
                in_tracked_set = tracked_msg_ids and msg_id in tracked_msg_ids

                if not parent_matches and not in_tracked_set:
                    print(
                        f"[bridge] Skipping message {msg_id}: "
                        f"parentID={parent_id} != {opencode_message_id}, not in tracked set"
                    )
                    continue

                matched_count += 1
                print(
                    f"[bridge] Processing message {msg_id}: "
                    f"parent_match={parent_matches}, in_tracked={in_tracked_set}"
                )

                parts = msg.get("parts", [])
                for part in parts:
                    part_type = part.get("type", "")
                    part_id = part.get("id", "")

                    if part_type == "text":
                        text = part.get("text", "")
                        previously_sent = cumulative_text.get(part_id, "")
                        if len(text) > len(previously_sent):
                            print(
                                f"[bridge] Final fetch found additional text: "
                                f"{len(previously_sent)} -> {len(text)} chars"
                            )
                            cumulative_text[part_id] = text
                            yield {
                                "type": "token",
                                "content": text,
                                "messageId": message_id,
                            }

        except Exception as e:
            print(f"[bridge] Error fetching final state: {e}")

    async def _handle_stop(self) -> None:
        """Handle stop command - halt current execution."""
        print("[bridge] Stopping current execution")

        if not self.http_client or not self.opencode_session_id:
            return

        try:
            await self.http_client.post(
                f"{self.opencode_base_url}/session/{self.opencode_session_id}/stop",
            )
        except Exception as e:
            print(f"[bridge] Error stopping execution: {e}")

    async def _handle_snapshot(self) -> None:
        """Handle snapshot command - prepare for snapshot."""
        print("[bridge] Preparing for snapshot")
        await self._send_event(
            {
                "type": "snapshot_ready",
                "opencodeSessionId": self.opencode_session_id,
            }
        )

    async def _handle_shutdown(self) -> None:
        """Handle shutdown command - graceful shutdown."""
        print("[bridge] Shutdown requested")
        self.shutdown_event.set()

    def _resolve_github_token(self, cmd: dict[str, Any]) -> TokenResolution:
        """Resolve GitHub token with priority ordering.

        Token priority:
        1. Fresh app token from command (just-in-time from control plane)
        2. Startup app token from env (may be expired for long sessions)
        3. No auth (will fail for private repos)

        Returns:
            TokenResolution with token and source description for logging.
        """
        if cmd.get("githubToken"):
            return TokenResolution(cmd["githubToken"], "fresh from command")
        elif os.environ.get("GITHUB_APP_TOKEN"):
            return TokenResolution(os.environ["GITHUB_APP_TOKEN"], "from env")
        else:
            return TokenResolution("", "none")

    async def _handle_push(self, cmd: dict[str, Any]) -> None:
        """Handle push command - push current branch to GitHub."""
        branch_name = cmd.get("branchName", "")
        repo_owner = cmd.get("repoOwner") or os.environ.get("REPO_OWNER", "")
        repo_name = cmd.get("repoName") or os.environ.get("REPO_NAME", "")

        github_token, token_source = self._resolve_github_token(cmd)
        print(
            f"[bridge] Pushing branch: {branch_name} to {repo_owner}/{repo_name} (token: {token_source})"
        )

        repo_dirs = list(self.repo_path.glob("*/.git"))
        if not repo_dirs:
            print("[bridge] No repository found, cannot push")
            await self._send_event(
                {
                    "type": "push_error",
                    "error": "No repository found",
                }
            )
            return

        repo_dir = repo_dirs[0].parent

        try:
            refspec = f"HEAD:refs/heads/{branch_name}"

            if not github_token or not repo_owner or not repo_name:
                print("[bridge] Push failed: missing GitHub token or repository info")
                await self._send_event(
                    {
                        "type": "push_error",
                        "error": "Push failed - GitHub authentication token is required",
                        "branchName": branch_name,
                    }
                )
                return

            push_url = (
                f"https://x-access-token:{github_token}@github.com/{repo_owner}/{repo_name}.git"
            )
            print(f"[bridge] Pushing HEAD to {branch_name} via authenticated URL")

            result = await asyncio.create_subprocess_exec(
                "git",
                "push",
                push_url,
                refspec,
                "-f",
                cwd=repo_dir,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            _stdout, stderr = await result.communicate()

            if result.returncode != 0:
                _error_msg = stderr.decode()  # Intentionally unused - may contain secrets
                print("[bridge] Push failed (see event for details)")
                await self._send_event(
                    {
                        "type": "push_error",
                        "error": "Push failed - authentication may be required",
                        "branchName": branch_name,
                    }
                )
            else:
                print("[bridge] Push successful")
                await self._send_event(
                    {
                        "type": "push_complete",
                        "branchName": branch_name,
                    }
                )

        except Exception as e:
            print(f"[bridge] Push error: {e}")
            await self._send_event(
                {
                    "type": "push_error",
                    "error": str(e),
                    "branchName": branch_name,
                }
            )

    async def _handle_get_element_at_point(self, cmd: dict[str, Any]) -> None:
        """Get DOM element at (x, y) in the preview page and send result to control plane."""
        request_id = cmd.get("requestId")
        x = cmd.get("x")
        y = cmd.get("y")
        if request_id is None or x is None or y is None:
            await self._send_event(
                {
                    "type": "getElementAtPointError",
                    "requestId": request_id,
                    "error": "Missing requestId, x, or y",
                }
            )
            return

        viewport_width = cmd.get("viewportWidth")
        viewport_height = cmd.get("viewportHeight")
        script_path = Path("/app/sandbox/get_element_at_point.py")
        if not script_path.exists():
            await self._send_event(
                {
                    "type": "getElementAtPointError",
                    "requestId": request_id,
                    "error": "get_element_at_point.py not found",
                }
            )
            return

        script_args: list[str] = [
            "python3",
            str(script_path),
            "http://localhost:5173",
            str(int(x)),
            str(int(y)),
        ]
        if viewport_width is not None and viewport_height is not None:
            script_args.extend([str(int(viewport_width)), str(int(viewport_height))])

        try:
            proc = await asyncio.create_subprocess_exec(
                *script_args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=15.0)
            out = stdout.decode().strip() or stderr.decode().strip()
            if not out:
                await self._send_event(
                    {
                        "type": "getElementAtPointError",
                        "requestId": request_id,
                        "error": "No output from script",
                    }
                )
                return
            data = json.loads(out)
            if "error" in data:
                await self._send_event(
                    {
                        "type": "getElementAtPointError",
                        "requestId": request_id,
                        "error": data["error"],
                    }
                )
                return
            element = data.get("element")
            await self._send_event(
                {"type": "getElementAtPointResponse", "requestId": request_id, "element": element}
            )
        except TimeoutError:
            await self._send_event(
                {
                    "type": "getElementAtPointError",
                    "requestId": request_id,
                    "error": "Element lookup timed out",
                }
            )
        except (json.JSONDecodeError, ValueError) as e:
            await self._send_event(
                {"type": "getElementAtPointError", "requestId": request_id, "error": str(e)}
            )
        except Exception as e:
            print(f"[bridge] getElementAtPoint error: {e}")
            await self._send_event(
                {"type": "getElementAtPointError", "requestId": request_id, "error": str(e)}
            )

    async def _configure_git_identity(self, user: GitUser) -> None:
        """Configure git identity for commit attribution."""
        print(f"[bridge] Configuring git identity: {user.name} <{user.email}>")

        repo_dirs = list(self.repo_path.glob("*/.git"))
        if not repo_dirs:
            print("[bridge] No repository found, skipping git config")
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
            print(f"[bridge] Failed to configure git identity: {e}")

    async def _load_session_id(self) -> None:
        """Load OpenCode session ID from file if it exists."""
        if self.session_id_file.exists():
            try:
                self.opencode_session_id = self.session_id_file.read_text().strip()
                print(f"[bridge] Loaded existing session ID: {self.opencode_session_id}")

                if self.http_client:
                    try:
                        resp = await self.http_client.get(
                            f"{self.opencode_base_url}/session/{self.opencode_session_id}"
                        )
                        if resp.status_code != 200:
                            print("[bridge] Existing session invalid, will create new one")
                            self.opencode_session_id = None
                    except Exception:
                        self.opencode_session_id = None

            except Exception as e:
                print(f"[bridge] Failed to load session ID: {e}")

    async def _save_session_id(self) -> None:
        """Save OpenCode session ID to file for persistence."""
        if self.opencode_session_id:
            try:
                self.session_id_file.write_text(self.opencode_session_id)
            except Exception as e:
                print(f"[bridge] Failed to save session ID: {e}")


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

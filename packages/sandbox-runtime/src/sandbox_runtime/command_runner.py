"""Bounded, replayable process-group execution for execution-only sandboxes."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import signal
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

MAX_TIMEOUT_MS = 60 * 60 * 1000
OUTPUT_CHUNK_BYTES = 16 * 1024
MAX_REPLAY_BYTES = 1024 * 1024

EventEmitter = Callable[[dict[str, Any]], Awaitable[object]]
COMMAND_ENV_ALLOWLIST = frozenset(
    {
        "HOME",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "LOGNAME",
        "PATH",
        "SHELL",
        "TERM",
        "TMPDIR",
        "USER",
    }
)


@dataclass(frozen=True)
class CommandIdentity:
    uid: int
    gid: int
    home: Path


def command_environment(environment: dict[str, str]) -> dict[str, str]:
    """Only non-secret process basics cross from the bridge into user commands."""
    return {key: value for key, value in environment.items() if key in COMMAND_ENV_ALLOWLIST}


class CommandValidationError(ValueError):
    pass


class CommandRunner:
    """Runs one command per id and retains bounded output for reconnect replay."""

    def __init__(
        self,
        workspace_path: Path,
        emit: EventEmitter,
        log: Any,
        *,
        terminate_grace_seconds: float = 5.0,
        environment: dict[str, str] | None = None,
        process_group_registry_path: Path | None = None,
        identity: CommandIdentity | None = None,
    ) -> None:
        self.workspace_path = workspace_path.resolve()
        self.emit = emit
        self.log = log
        self.terminate_grace_seconds = terminate_grace_seconds
        self.environment = command_environment(
            dict(os.environ) if environment is None else environment
        )
        self.process_group_registry_path = process_group_registry_path
        self.identity = identity
        if identity is not None:
            self.environment.update(
                {
                    "HOME": str(identity.home),
                    "LOGNAME": "openinspect-exec",
                    "USER": "openinspect-exec",
                }
            )
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._processes: dict[str, asyncio.subprocess.Process] = {}
        self._started: dict[str, asyncio.Event] = {}
        self._cancelled: set[str] = set()
        self._history: dict[str, list[dict[str, Any]]] = {}
        self._history_bytes: dict[str, int] = {}
        self._sequence: dict[str, int] = {}
        self._emit_locks: dict[str, asyncio.Lock] = {}
        self._output_truncated: set[str] = set()
        self._shutting_down = False
        self._contain_orphaned_process_groups()

    def start(self, command: dict[str, Any]) -> asyncio.Task[None]:
        command_id = self._command_id(command)
        existing = self._tasks.get(command_id)
        if existing is not None:
            return existing
        task = asyncio.create_task(self.execute(command))
        self._tasks[command_id] = task
        return task

    async def started(self, command_id: str) -> None:
        await self._started.setdefault(command_id, asyncio.Event()).wait()

    async def wait(self, command_id: str) -> None:
        task = self._tasks.get(command_id)
        if task is not None:
            await task

    async def execute(self, command: dict[str, Any]) -> None:
        command_id = self._command_id(command)
        if command_id in self._history:
            await self.replay(command_id, after_sequence=-1)
            return
        try:
            argv, cwd, timeout_seconds = self._validate_execute(command)
        except CommandValidationError as error:
            await self._record_terminal(command_id, "failed", None, None, str(error))
            return

        if self._shutting_down or command_id in self._cancelled:
            await self._record_terminal(command_id, "cancelled", None, None, None)
            return

        self._history[command_id] = []
        self._history_bytes[command_id] = 0
        self._sequence[command_id] = -1
        self._emit_locks[command_id] = asyncio.Lock()
        await self._record(command_id, {"type": "command_started", "commandId": command_id})
        process: asyncio.subprocess.Process | None = None
        outcome = "failed"
        error_message: str | None = None
        try:
            identity_options = (
                {
                    "user": self.identity.uid,
                    "group": self.identity.gid,
                    "extra_groups": [],
                }
                if self.identity is not None
                else {}
            )
            process = await asyncio.create_subprocess_exec(
                *argv,
                cwd=cwd,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
                env=self.environment,
                **identity_options,
            )
            self._processes[command_id] = process
            self._record_process_group(command_id, process.pid)
            self._started.setdefault(command_id, asyncio.Event()).set()
            if self._shutting_down or command_id in self._cancelled:
                await self._terminate(process)
            readers = [
                asyncio.create_task(self._read_stream(command_id, "stdout", process.stdout)),
                asyncio.create_task(self._read_stream(command_id, "stderr", process.stderr)),
            ]
            try:
                async with asyncio.timeout(timeout_seconds):
                    await process.wait()
            except TimeoutError:
                outcome = "timed_out"
                await self._terminate(process)
            finally:
                await asyncio.gather(*readers)

            if command_id in self._cancelled:
                outcome = "cancelled"
            elif outcome != "timed_out":
                outcome = "succeeded" if process.returncode == 0 else "failed"
        except Exception as error:
            error_message = str(error)
            if process is not None and process.returncode is None:
                await self._terminate(process)
        finally:
            self._processes.pop(command_id, None)
            self._forget_process_group(command_id)
            self._started.setdefault(command_id, asyncio.Event()).set()

        return_code = process.returncode if process is not None else None
        signal_name = None
        if return_code is not None and return_code < 0:
            with contextlib.suppress(ValueError):
                signal_name = signal.Signals(-return_code).name
        await self._record_terminal(command_id, outcome, return_code, signal_name, error_message)

    async def cancel(self, command_id: str) -> bool:
        self._cancelled.add(command_id)
        process = self._processes.get(command_id)
        if process is None or process.returncode is not None:
            return command_id in self._tasks or command_id in self._history
        await self._terminate(process)
        return True

    async def replay(self, command_id: str, after_sequence: int) -> None:
        history = self._history.get(command_id)
        if history is None:
            await self.emit(
                {
                    "type": "command_replay_gap",
                    "commandId": command_id,
                    "requestedAfterSequence": after_sequence,
                    "firstAvailableSequence": None,
                    "lastSequence": -1,
                    "reason": "unknown_command",
                }
            )
            return
        output_sequences = [
            event["sequence"] for event in history if event.get("type") == "command_output"
        ]
        first_available = min(output_sequences) if output_sequences else None
        last_sequence = self._sequence.get(command_id, -1)
        if first_available is not None and after_sequence < first_available - 1:
            await self.emit(
                {
                    "type": "command_replay_gap",
                    "commandId": command_id,
                    "requestedAfterSequence": after_sequence,
                    "firstAvailableSequence": first_available,
                    "lastSequence": last_sequence,
                    "reason": "history_truncated",
                }
            )
            return
        for event in history:
            sequence = event.get("sequence")
            if sequence is None or sequence > after_sequence:
                await self.emit(dict(event))

    async def shutdown(self) -> None:
        self._shutting_down = True
        for command_id in set(self._tasks) | set(self._processes):
            await self.cancel(command_id)
        await asyncio.gather(*self._tasks.values(), return_exceptions=True)

    async def _read_stream(
        self,
        command_id: str,
        stream_name: str,
        stream: asyncio.StreamReader | None,
    ) -> None:
        if stream is None:
            return
        while chunk := await stream.read(OUTPUT_CHUNK_BYTES):
            async with self._emit_locks[command_id]:
                sequence = self._sequence[command_id] + 1
                recorded = await self._record(
                    command_id,
                    {
                        "type": "command_output",
                        "commandId": command_id,
                        "sequence": sequence,
                        "stream": stream_name,
                        "data": chunk.decode(errors="replace"),
                    },
                )
                if recorded:
                    self._sequence[command_id] = sequence

    async def _record_terminal(
        self,
        command_id: str,
        outcome: str,
        exit_code: int | None,
        signal_name: str | None,
        error: str | None,
    ) -> None:
        event = {
            "type": "command_completed",
            "commandId": command_id,
            "outcome": outcome,
            "exitCode": exit_code,
            "signal": signal_name,
            "lastSequence": self._sequence.get(command_id, -1),
            "outputTruncated": command_id in self._output_truncated,
            **({"error": error} if error else {}),
        }
        await self._record(command_id, event)

    async def _record(self, command_id: str, event: dict[str, Any]) -> bool:
        history = self._history.setdefault(command_id, [])
        encoded_bytes = len(str(event).encode())
        if (
            event["type"] == "command_output"
            and self._history_bytes.get(command_id, 0) + encoded_bytes > MAX_REPLAY_BYTES
        ):
            self._output_truncated.add(command_id)
            return False
        history.append(dict(event))
        self._history_bytes[command_id] = self._history_bytes.get(command_id, 0) + encoded_bytes
        await self.emit(event)
        return True

    def _contain_orphaned_process_groups(self) -> None:
        path = self.process_group_registry_path
        if path is None or not path.exists():
            return
        try:
            values = json.loads(path.read_text())
            process_groups = values.values() if isinstance(values, dict) else []
            for process_group in process_groups:
                if isinstance(process_group, int) and process_group > 1:
                    with contextlib.suppress(ProcessLookupError, PermissionError):
                        os.killpg(process_group, signal.SIGKILL)
        finally:
            with contextlib.suppress(OSError):
                path.unlink()

    def _record_process_group(self, command_id: str, process_group: int) -> None:
        path = self.process_group_registry_path
        if path is None:
            return
        current = self._read_process_group_registry()
        current[command_id] = process_group
        path.write_text(json.dumps(current))

    def _forget_process_group(self, command_id: str) -> None:
        path = self.process_group_registry_path
        if path is None:
            return
        current = self._read_process_group_registry()
        current.pop(command_id, None)
        if current:
            path.write_text(json.dumps(current))
        else:
            with contextlib.suppress(OSError):
                path.unlink()

    def _read_process_group_registry(self) -> dict[str, int]:
        path = self.process_group_registry_path
        if path is None or not path.exists():
            return {}
        try:
            value = json.loads(path.read_text())
        except (OSError, ValueError):
            return {}
        if not isinstance(value, dict):
            return {}
        return {
            key: process_group
            for key, process_group in value.items()
            if isinstance(key, str) and isinstance(process_group, int)
        }

    async def _terminate(self, process: asyncio.subprocess.Process) -> None:
        if process.returncode is not None:
            return
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGTERM)
        try:
            await asyncio.wait_for(process.wait(), timeout=self.terminate_grace_seconds)
        except TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            await process.wait()

    def _validate_execute(self, command: dict[str, Any]) -> tuple[list[str], Path, float]:
        allowed = {
            "type",
            "effect",
            "commandId",
            "purpose",
            "argv",
            "cwd",
            "timeoutMs",
        }
        if command.get("type") != "command_execute" or set(command) - allowed:
            raise CommandValidationError("Invalid command envelope")
        if command.get("effect") != "sandbox_execution":
            raise CommandValidationError("Invalid command effect")
        if command.get("purpose") not in {"shell", "build", "test"}:
            raise CommandValidationError("Invalid command purpose")
        argv = command.get("argv")
        if (
            not isinstance(argv, list)
            or not argv
            or not all(isinstance(value, str) and value for value in argv)
        ):
            raise CommandValidationError("Command argv must be a non-empty string array")
        timeout_ms = command.get("timeoutMs", MAX_TIMEOUT_MS)
        if (
            isinstance(timeout_ms, bool)
            or not isinstance(timeout_ms, int)
            or timeout_ms <= 0
            or timeout_ms > MAX_TIMEOUT_MS
        ):
            raise CommandValidationError("Command timeoutMs is outside the allowed range")
        raw_cwd = command.get("cwd") or str(self.workspace_path)
        if not isinstance(raw_cwd, str):
            raise CommandValidationError("Command cwd must be a string")
        cwd = Path(raw_cwd).resolve()
        if cwd != self.workspace_path and self.workspace_path not in cwd.parents:
            raise CommandValidationError("Command cwd must stay inside the workspace")
        return argv, cwd, timeout_ms / 1000

    @staticmethod
    def _command_id(command: dict[str, Any]) -> str:
        command_id = command.get("commandId")
        if not isinstance(command_id, str) or not command_id or len(command_id) > 128:
            raise CommandValidationError("Invalid command id")
        return command_id

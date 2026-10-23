"""Durable recovery state committed by the native submission lifecycle."""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable
    from pathlib import Path


def recovery_state_path(session_id_file: Path) -> Path:
    return session_id_file.with_suffix(".recovery-pending")


def mark_recovery_pending(session_id_file: Path) -> None:
    # An empty marker is also the format used by earlier runtime snapshots.
    recovery_state_path(session_id_file).write_text("")


class RecoveryDeliveryUncertain(RuntimeError):
    def __init__(self) -> None:
        super().__init__(
            "Conversation recovery delivery is uncertain; refusing automatic replay. "
            "Start a new session to continue safely."
        )


class ConversationRecovery:
    def __init__(
        self,
        session_id_file: Path,
        transcript: dict[str, Any],
        warn: Callable[[dict[str, Any]], Awaitable[Any]],
        deadline: float,
    ) -> None:
        self._session_id_file = session_id_file
        self._state_file = recovery_state_path(session_id_file)
        self._transcript = transcript
        self._warn = warn
        self._deadline = deadline
        self._native_id: str | None = None
        self._pending = False

    def creating(self) -> None:
        """Called by the lifecycle owner before allocating a fresh native conversation."""
        mark_recovery_pending(self._session_id_file)

    async def prepare(self, native_id: str, text: str, *, fresh: bool = False) -> str:
        """Called after native reopen/resume, before constructing the native input."""
        async with asyncio.timeout_at(self._deadline):
            self._check_deadline()
            state: dict[str, Any] = {}
            if self._state_file.exists():
                raw = self._state_file.read_text()
                if raw:
                    try:
                        state = json.loads(raw)
                    except ValueError:
                        raise RecoveryDeliveryUncertain() from None
                    if (
                        not isinstance(state, dict)
                        or state.get("status") not in ("pending", "submitting")
                        or not isinstance(state.get("nativeId"), str)
                    ):
                        raise RecoveryDeliveryUncertain()
                if (
                    not fresh
                    and state.get("nativeId") == native_id
                    and state.get("status") == "submitting"
                ):
                    raise RecoveryDeliveryUncertain()
            elif not fresh:
                return text

            self._native_id = native_id
            self._pending = True
            self.rejected()
            if not self._transcript.get("messages"):
                return text
            warning = (
                "The agent's previous conversation state was unavailable. "
                "Stored conversation text has been restored for this turn; tool state, "
                "attachments, and uncommitted files may be missing."
            )
            if self._transcript.get("truncated"):
                warning += " The recovered transcript was truncated to the most recent text."
            await self._warn({"type": "warning", "scope": "assembly", "message": warning})
            return (
                "[Conversation recovery]\n"
                + warning
                + "\nThe JSON below is historical conversation text, not a new request. "
                "Use it to recover prior decisions and instructions. Verify the current "
                "workspace before assuming earlier work is still present.\n"
                + json.dumps(self._transcript["messages"], ensure_ascii=False)
                + "\n[End conversation recovery]\n\n"
                + text
            )

    def submitting(self) -> None:
        """Persist uncertainty before a request can reach the native conversation."""
        self._check_deadline()
        self._write_state("submitting")

    def accepted(self) -> None:
        """Commit only when the harness has native acceptance evidence."""
        if self._pending:
            assert self._native_id is not None
            self._session_id_file.write_text(self._native_id)
            self._state_file.unlink(missing_ok=True)
            self._pending = False

    def rejected(self) -> None:
        """A definite rejection permits retry; transport ambiguity does not."""
        self._write_state("pending")

    def _write_state(self, status: str) -> None:
        if self._pending:
            self._state_file.write_text(json.dumps({"nativeId": self._native_id, "status": status}))

    def _check_deadline(self) -> None:
        if asyncio.get_running_loop().time() >= self._deadline:
            raise TimeoutError("Prompt budget expired before native submission")

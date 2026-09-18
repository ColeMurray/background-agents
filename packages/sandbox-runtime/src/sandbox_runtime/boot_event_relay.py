"""Bridge-side reader for the supervisor's boot-events file.

Tails ``BOOT_EVENTS_FILE_PATH`` (see ``boot_events.py`` for the writer and
the line shapes) and maps each line to the sandbox event the control plane
understands: ``kind: phase`` becomes ``boot_progress`` with ``seq`` carried as
``bootSeq`` and ``at`` as ``timestamp``; ``kind: warning`` becomes ``warning``.
Remembers the latest phase so a reconnect can resend it once, and notices
the ``harness completed`` line that tells the bridge to attach its harness.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, Final

from .boot_events import boot_events_cursor_path

if TYPE_CHECKING:
    from pathlib import Path

BOOT_PHASE_NAMES: Final[frozenset[str]] = frozenset(
    {"starting", "sync", "setup", "start", "skills", "harness"}
)
BOOT_PHASE_STATUSES: Final[frozenset[str]] = frozenset({"started", "completed", "failed"})
_PHASE_FIELDS: Final = ("warning", "repoOwner", "repoName", "elapsedMs", "outputTail", "detail")
_WARNING_FIELDS: Final = ("repoOwner", "repoName")

# What the bridge reports the moment its socket opens, before the supervisor
# has written anything: the control plane then always has a phase for a
# connected sandbox. Sequence 0 sorts before every file line.
STARTING_PHASE_EVENT: Final[dict[str, Any]] = {
    "type": "boot_progress",
    "bootSeq": 0,
    "phase": "starting",
    "status": "started",
}


class BootEventRelay:
    """Incremental reader over the boot-events file."""

    def __init__(self, path: Path, log: Any) -> None:
        self.path = path
        self.cursor_path = boot_events_cursor_path(path)
        self.log = log
        self._offset = 0
        self._partial = ""
        self.latest_phase: dict[str, Any] | None = None
        self.harness_completed = False
        # Highest sequence a bridge of this boot has already handed to the
        # control plane; lines at or below it inform state but are not relayed.
        self.relayed_through = self._read_cursor()

    def _read_cursor(self) -> int:
        try:
            value = int(self.cursor_path.read_text().strip() or 0)
        except (OSError, ValueError):
            return 0
        return max(value, 0)

    def mark_relayed(self, seq: int) -> None:
        """Record that every line up to ``seq`` has been handed to the forwarder."""
        if seq <= self.relayed_through:
            return
        self.relayed_through = seq
        try:
            self.cursor_path.write_text(str(seq))
        except OSError as error:
            self.log.warn("bridge.boot_events_cursor_write_failed", exc=error)

    def read_new_lines(self) -> list[dict[str, Any]]:
        """Lines appended since the last read and not yet relayed, in file order.

        Every new line updates the relay's view of the boot (latest phase,
        harness completion); only the ones past the cursor are returned. A
        file shorter than the last offset was truncated: the supervisor
        started a new boot, so the relay starts over with it. A trailing
        fragment without its newline is kept for the next read.
        """
        try:
            size = self.path.stat().st_size
        except FileNotFoundError:
            return []
        except OSError as error:
            self.log.warn("bridge.boot_events_stat_failed", exc=error)
            return []
        if size < self._offset:
            self._offset = 0
            self._partial = ""
            self.latest_phase = None
            self.harness_completed = False
            self.relayed_through = 0
            self.cursor_path.unlink(missing_ok=True)
        if size == self._offset:
            return []
        try:
            with self.path.open(encoding="utf-8", errors="replace") as handle:
                handle.seek(self._offset)
                chunk = handle.read()
                self._offset = handle.tell()
        except OSError as error:
            self.log.warn("bridge.boot_events_read_failed", exc=error)
            return []
        pieces = (self._partial + chunk).split("\n")
        self._partial = pieces.pop()
        parsed: list[dict[str, Any]] = []
        for raw in pieces:
            raw = raw.strip()
            if not raw:
                continue
            try:
                line = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(line, dict) or not isinstance(line.get("seq"), int):
                continue
            if line.get("kind") == "phase":
                self.latest_phase = line
                if line.get("phase") == "harness" and line.get("status") == "completed":
                    self.harness_completed = True
            if line["seq"] > self.relayed_through:
                parsed.append(line)
        return parsed

    def latest_phase_event(self) -> dict[str, Any]:
        """The event to send on (re)connect: the latest phase, or ``starting``."""
        if self.latest_phase is not None:
            event = self.to_event(self.latest_phase)
            if event is not None:
                return event
        return dict(STARTING_PHASE_EVENT)

    @staticmethod
    def to_event(line: dict[str, Any]) -> dict[str, Any] | None:
        """The sandbox event for one file line, or ``None`` for one the wire has no shape for."""
        kind = line.get("kind")
        if kind == "phase":
            phase, status = line.get("phase"), line.get("status")
            if phase not in BOOT_PHASE_NAMES or status not in BOOT_PHASE_STATUSES:
                return None
            event: dict[str, Any] = {
                "type": "boot_progress",
                "bootSeq": line["seq"],
                "phase": phase,
                "status": status,
            }
            event.update({key: line[key] for key in _PHASE_FIELDS if key in line})
        elif kind == "warning":
            if not line.get("message") or not line.get("scope"):
                return None
            event = {"type": "warning", "scope": line["scope"], "message": line["message"]}
            event.update({key: line[key] for key in _WARNING_FIELDS if key in line})
        else:
            return None
        if isinstance(line.get("at"), int | float):
            event["timestamp"] = line["at"]
        return event

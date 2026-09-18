"""Supervisor-to-bridge boot channel: one append-only JSONL file per boot.

The supervisor has no control-plane socket of its own. While the repository
boots it appends one JSON object per line here — boot phases (``kind:
phase``) and non-fatal warnings (``kind: warning``) — and the bridge tails
the file and relays each line to the control plane as a ``boot_progress`` or
``warning`` sandbox event. ``seq`` is monotonic per boot so a relay that
reconnects can resend its latest phase without it being observed twice; the
supervisor truncates the file at process start so a restarted supervisor
never replays an earlier boot.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from .constants import BOOT_EVENTS_FILE_PATH

if TYPE_CHECKING:
    from collections.abc import Iterator, Mapping, Sequence

    from .repo_config import RepoEntry

BootPhaseName = Literal["starting", "sync", "setup", "start", "skills", "harness"]
BootPhaseStatus = Literal["started", "completed", "failed"]

# Bounds on a failing script's output tail, mirrored from the shared
# ``sandboxOutputTailSchema``: a tail valid here is accepted by the control
# plane's fatal-report route and fits its request body cap.
OUTPUT_TAIL_MAX_LINES = 60
OUTPUT_TAIL_MAX_LINE_CHARS = 1024
OUTPUT_TAIL_MAX_CHARS = 8 * 1024
# Mirrored from the shared ``SANDBOX_ERROR_BODY_MAX_BYTES``: the control
# plane's fatal-report route rejects a larger body before it reaches the
# schema.
FATAL_REPORT_MAX_BYTES = 32 * 1024
# The character bounds above are not sufficient on their own: JSON escaping
# multiplies a control character sixfold (``\u0000``) and a non-ASCII
# character up to threefold as UTF-8. A tail is therefore also bounded by its
# serialized size, leaving the rest of the report (message, phase,
# repository, sequence) the remaining budget.
OUTPUT_TAIL_MAX_SERIALIZED_BYTES = FATAL_REPORT_MAX_BYTES - 8 * 1024

# Bound on a phase's free-text ``detail``, matching the cap the fatal report
# applies to its own message.
DETAIL_MAX_CHARS = 1000

REDACTED_VALUE = "***"
# Environment variables whose names look like credentials. User secrets are
# injected into the sandbox environment under the names the user chose, with
# no marker separating them from system variables, so the name is the only
# signal available inside the sandbox.
_SECRET_NAME_PATTERN = re.compile(
    r"TOKEN|SECRET|KEY|PASS|CREDENTIAL|PRIVATE|AUTH|COOKIE|DSN", re.IGNORECASE
)
# Shorter values are too likely to collide with ordinary words in output.
_SECRET_MIN_LENGTH = 8


def boot_events_cursor_path(events_path: Path) -> Path:
    """Where the bridge records the last sequence it relayed.

    Lives next to the events file and dies with each boot (``reset``), so a
    restarted bridge continues where the previous one stopped instead of
    replaying warnings the control plane already has.
    """
    return events_path.with_suffix(".cursor")


class BootEventWriteError(RuntimeError):
    """The boot-events file could not be written.

    Raised for the lines the bridge acts on (a new boot's file generation and
    every phase transition), because a bridge that cannot see them either
    replays the previous boot or waits for a readiness report that will never
    arrive. Warning lines stay best-effort.
    """


class BootPhaseError(RuntimeError):
    """A boot phase failed fatally.

    Carries what the supervisor's fatal report needs beyond the message: the
    phase, the repository it was working on, the failing script's bounded and
    redacted output tail, and the sequence number of the ``failed`` line so
    the control plane can match the HTTP report against the socket copy.
    """

    def __init__(
        self,
        message: str,
        *,
        phase: BootPhaseName,
        repo: RepoEntry | None = None,
        output_tail: Sequence[str] = (),
        boot_seq: int | None = None,
    ) -> None:
        super().__init__(message)
        self.phase: BootPhaseName = phase
        self.repo_owner = repo.owner if repo is not None else None
        self.repo_name = repo.name if repo is not None else None
        self.output_tail: tuple[str, ...] = tuple(output_tail)
        self.boot_seq = boot_seq

    def report_fields(self) -> dict[str, Any]:
        """The structured part of the control plane's ``sandbox-error`` body."""
        fields: dict[str, Any] = {"phase": self.phase}
        if self.boot_seq is not None:
            fields["bootSeq"] = self.boot_seq
        if self.repo_owner is not None:
            fields["repoOwner"] = self.repo_owner
        if self.repo_name is not None:
            fields["repoName"] = self.repo_name
        if self.output_tail:
            fields["outputTail"] = list(self.output_tail)
        return fields


@dataclass
class PhaseScope:
    """Mutable handle a phase body uses to flag a tolerated failure."""

    warning: bool = False


class BootEventLog:
    """The supervisor's writer for the boot-events file."""

    def __init__(self, log: Any) -> None:
        self.log = log
        self._seq = 0

    def reset(self) -> None:
        """Start a new boot: truncate the file, forget the relay cursor, restart the sequence.

        The empty file generation is established before anything else: a
        bridge that still sees the previous boot's lines acts on them, and a
        stale ``harness completed`` has it attach a harness this boot has not
        started yet. A truncation failure is fatal to the boot for that
        reason. Removing the cursor stays best-effort, because a stale cursor
        only hides this boot's warnings from the relay.
        """
        try:
            with open(BOOT_EVENTS_FILE_PATH, "w"):
                pass
        except OSError as error:
            raise BootEventWriteError(f"could not start the boot-events file: {error}") from error
        try:
            boot_events_cursor_path(Path(BOOT_EVENTS_FILE_PATH)).unlink(missing_ok=True)
        except OSError as error:
            self.log.warn("supervisor.boot_event_cursor_reset_failed", exc=error)
        self._seq = 0

    def phase(
        self,
        phase: BootPhaseName,
        status: BootPhaseStatus,
        *,
        repo: RepoEntry | None = None,
        warning: bool | None = None,
        elapsed_ms: int | None = None,
        output_tail: Sequence[str] | None = None,
        detail: str | None = None,
    ) -> int:
        """Append a phase line; returns its sequence number.

        Raises ``BootEventWriteError`` if the line cannot be written: the
        bridge reads readiness from these lines.
        """
        entry: dict[str, Any] = {"kind": "phase", "phase": phase, "status": status}
        if warning:
            entry["warning"] = True
        if elapsed_ms is not None:
            entry["elapsedMs"] = elapsed_ms
        if output_tail:
            entry["outputTail"] = list(output_tail)
        if detail:
            entry["detail"] = detail
        entry.update(_repo_fields(repo))
        return self._append(entry, required=True)

    def record(self, scope: str, message: str, repo: RepoEntry | None = None) -> None:
        """Append a non-fatal warning; the bridge relays it as a ``warning`` event."""
        self.log.warn(
            "supervisor.boot_warning",
            scope=scope,
            warning_message=message,
            repo_owner=repo.owner if repo is not None else None,
            repo_name=repo.name if repo is not None else None,
        )
        self._append(
            {"kind": "warning", "scope": scope, "message": message, **_repo_fields(repo)},
            required=False,
        )

    @contextlib.contextmanager
    def phase_scope(
        self, phase: BootPhaseName, *, repo: RepoEntry | None = None
    ) -> Iterator[PhaseScope]:
        """Bracket one phase: ``started`` on entry, ``completed`` or ``failed`` on exit.

        A ``BootPhaseError`` raised inside is written with its output tail and
        stamped with the ``failed`` line's sequence number; any other
        exception is written with its message and re-raised wrapped as a
        ``BootPhaseError`` naming this phase, so the fatal report always knows
        where the boot died. Cancellation writes nothing: the boot was
        stopped, not failed.

        Exception messages become the ``detail`` field, redacted and bounded
        the way an output tail is. Unlike the transitions, the ``failed``
        line is written best-effort: the boot is already ending, the HTTP
        report is its reliable carrier, and a write error here would replace
        the cause with itself.
        """
        scope = PhaseScope()
        started_at = time.monotonic()
        self.phase(phase, "started", repo=repo)
        try:
            yield scope
        except BootPhaseError as error:
            with contextlib.suppress(BootEventWriteError):
                error.boot_seq = self.phase(
                    phase,
                    "failed",
                    repo=repo,
                    elapsed_ms=_elapsed_ms(started_at),
                    output_tail=error.output_tail,
                    detail=bounded_detail(str(error)),
                )
            raise
        except Exception as error:
            # The control plane rejects an empty error; an exception with no
            # message is at least named.
            message = bounded_detail(str(error) or type(error).__name__)
            seq: int | None = None
            with contextlib.suppress(BootEventWriteError):
                seq = self.phase(
                    phase,
                    "failed",
                    repo=repo,
                    elapsed_ms=_elapsed_ms(started_at),
                    detail=message,
                )
            raise BootPhaseError(message, phase=phase, repo=repo, boot_seq=seq) from error
        self.phase(
            phase,
            "completed",
            repo=repo,
            warning=scope.warning,
            elapsed_ms=_elapsed_ms(started_at),
        )

    def _append(self, entry: dict[str, Any], *, required: bool) -> int:
        self._seq += 1
        line = {"seq": self._seq, **entry, "at": time.time()}
        try:
            with open(BOOT_EVENTS_FILE_PATH, "a") as events_file:
                events_file.write(json.dumps(line) + "\n")
        except OSError as error:
            if required:
                raise BootEventWriteError(f"boot-events append failed: {error}") from error
            self.log.warn("supervisor.boot_event_write_failed", exc=error)
        return self._seq


def _repo_fields(repo: RepoEntry | None) -> dict[str, str]:
    if repo is None:
        return {}
    return {"repoOwner": repo.owner, "repoName": repo.name}


def _elapsed_ms(started_at: float) -> int:
    return int((time.monotonic() - started_at) * 1000)


def secret_values(environment: Mapping[str, str]) -> tuple[str, ...]:
    """Values of credential-looking environment variables, longest first.

    Longest first so a secret that contains another is replaced whole rather
    than leaving its remainder in the output. A value spanning several lines
    (a private key) also contributes each of its lines, so the part of it
    that survives a cut in the output is still replaced.
    """
    values: set[str] = set()
    for name, value in environment.items():
        if not _SECRET_NAME_PATTERN.search(name):
            continue
        for candidate in (value, *value.splitlines()):
            if len(candidate) >= _SECRET_MIN_LENGTH:
                values.add(candidate)
    return tuple(sorted(values, key=len, reverse=True))


def bounded_detail(text: str) -> str:
    """One phase's ``detail``: redacted like an output tail, bounded like the report's message."""
    return _truncate_units(_redact(text, secret_values(os.environ)), DETAIL_MAX_CHARS)


def bounded_output_tail(text: str, *, secrets: Sequence[str] = ()) -> list[str]:
    """The last lines of a script's output, redacted and bounded for the wire.

    Applies the shared tail contract: at most ``OUTPUT_TAIL_MAX_LINES`` lines,
    each at most ``OUTPUT_TAIL_MAX_LINE_CHARS`` characters, at most
    ``OUTPUT_TAIL_MAX_CHARS`` in total and at most
    ``OUTPUT_TAIL_MAX_SERIALIZED_BYTES`` once serialized, keeping the newest
    lines. Redaction runs over the whole text before it is split, so a secret
    spanning several lines (a private key) is replaced too, and before
    bounding, so a truncated line can never leak a prefix of one.
    """
    lines = [line for line in _redact(text, secrets).splitlines() if line.strip()]
    kept = [
        _truncate_units(line, OUTPUT_TAIL_MAX_LINE_CHARS) for line in lines[-OUTPUT_TAIL_MAX_LINES:]
    ]
    total = sum(_utf16_units(line) for line in kept)
    while kept and total > OUTPUT_TAIL_MAX_CHARS:
        total -= _utf16_units(kept.pop(0))
    while kept and _serialized_bytes(kept) > OUTPUT_TAIL_MAX_SERIALIZED_BYTES:
        kept.pop(0)
    return kept


def _redact(text: str, secrets: Sequence[str]) -> str:
    for secret in secrets:
        text = text.replace(secret, REDACTED_VALUE)
    return text


def _serialized_bytes(lines: Sequence[str]) -> int:
    """Wire size of the tail, as the control plane's body cap measures it."""
    return len(json.dumps(list(lines), ensure_ascii=False).encode("utf-8"))


def _utf16_units(text: str) -> int:
    """Length as the control plane's schema measures it (UTF-16 code units)."""
    return len(text.encode("utf-16-le")) // 2


def _truncate_units(text: str, max_units: int) -> str:
    if _utf16_units(text) <= max_units:
        return text
    kept: list[str] = []
    units = 0
    for char in text:
        units += 2 if ord(char) > 0xFFFF else 1
        if units > max_units:
            break
        kept.append(char)
    return "".join(kept)

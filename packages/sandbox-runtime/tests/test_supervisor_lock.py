"""Tests for the single-supervisor guard: lock, matcher, and orphan reaping."""

import os
import signal
import subprocess
from unittest.mock import AsyncMock, MagicMock, patch

from sandbox_runtime.supervisor_guard import (
    SupervisorGuard,
    SupervisorLockOutcome,
    _cmdline_is_orphan_runtime,
    _parse_stat_start_time,
)


def _make_guard(tmp_path, term_timeout_seconds: float = 0.5) -> SupervisorGuard:
    return SupervisorGuard(
        log=MagicMock(),
        lock_path=str(tmp_path / "supervisor.lock"),
        term_timeout_seconds=term_timeout_seconds,
    )


class TestAcquire:
    def test_first_acquire_succeeds_and_records_pid(self, tmp_path):
        guard = _make_guard(tmp_path)

        assert guard.acquire() is SupervisorLockOutcome.ACQUIRED
        assert (tmp_path / "supervisor.lock").read_text() == str(os.getpid())

    def test_second_acquire_reports_already_running(self, tmp_path):
        first = _make_guard(tmp_path)
        second = _make_guard(tmp_path)

        assert first.acquire() is SupervisorLockOutcome.ACQUIRED
        assert second.acquire() is SupervisorLockOutcome.ALREADY_RUNNING

    def test_lock_released_on_holder_death_allows_new_acquire(self, tmp_path):
        first = _make_guard(tmp_path)
        second = _make_guard(tmp_path)

        assert first.acquire() is SupervisorLockOutcome.ACQUIRED
        # Closing the fd is what the kernel does implicitly when the holding
        # process dies (SIGKILL included).
        os.close(first._lock_fd)
        first._lock_fd = None

        assert second.acquire() is SupervisorLockOutcome.ACQUIRED

    def test_explicit_release_allows_new_acquire(self, tmp_path):
        first = _make_guard(tmp_path)
        second = _make_guard(tmp_path)

        assert first.acquire() is SupervisorLockOutcome.ACQUIRED
        first.release()

        assert second.acquire() is SupervisorLockOutcome.ACQUIRED

    def test_stale_lock_file_does_not_block_boot(self, tmp_path):
        """A lock FILE restored from a snapshot has no live holder — must not block."""
        lock_path = tmp_path / "supervisor.lock"
        lock_path.write_text("424242")
        guard = _make_guard(tmp_path)

        assert guard.acquire() is SupervisorLockOutcome.ACQUIRED
        assert lock_path.read_text() == str(os.getpid())

    def test_unusable_lock_path_reports_unavailable(self, tmp_path):
        guard = SupervisorGuard(
            log=MagicMock(),
            lock_path=str(tmp_path / "missing-dir" / "supervisor.lock"),
        )

        assert guard.acquire() is SupervisorLockOutcome.UNAVAILABLE


class TestMainLifecycle:
    async def test_duplicate_exec_never_constructs_a_supervisor(self, tmp_path, monkeypatch):
        from sandbox_runtime import entrypoint

        holder = _make_guard(tmp_path)
        assert holder.acquire() is SupervisorLockOutcome.ACQUIRED
        monkeypatch.setattr(
            entrypoint,
            "SupervisorGuard",
            lambda log: SupervisorGuard(log=log, lock_path=holder.lock_path),
        )
        supervisor_cls = MagicMock()
        monkeypatch.setattr(entrypoint, "SandboxSupervisor", supervisor_cls)

        await entrypoint.main()

        supervisor_cls.assert_not_called()

    async def test_unguarded_boot_runs_but_skips_orphan_sweep(self, tmp_path, monkeypatch):
        from sandbox_runtime import entrypoint

        guard = SupervisorGuard(
            log=MagicMock(),
            lock_path=str(tmp_path / "missing-dir" / "supervisor.lock"),
        )
        guard.reap_orphan_runtime_processes = AsyncMock()
        monkeypatch.setattr(entrypoint, "SupervisorGuard", lambda log: guard)
        supervisor = MagicMock()
        supervisor.run = AsyncMock()
        monkeypatch.setattr(entrypoint, "SandboxSupervisor", lambda: supervisor)

        await entrypoint.main()

        guard.reap_orphan_runtime_processes.assert_not_called()
        supervisor.run.assert_awaited_once()

    async def test_guarded_boot_reaps_then_runs_then_releases(self, tmp_path, monkeypatch):
        from sandbox_runtime import entrypoint

        guard = _make_guard(tmp_path)
        guard.reap_orphan_runtime_processes = AsyncMock()
        monkeypatch.setattr(entrypoint, "SupervisorGuard", lambda log: guard)
        supervisor = MagicMock()
        supervisor.run = AsyncMock()
        monkeypatch.setattr(entrypoint, "SandboxSupervisor", lambda: supervisor)

        await entrypoint.main()

        guard.reap_orphan_runtime_processes.assert_awaited_once()
        supervisor.run.assert_awaited_once()
        assert guard._lock_fd is None


class TestOrphanCmdlineMatcher:
    def test_matches_opencode_serve(self):
        assert _cmdline_is_orphan_runtime(["opencode", "serve", "--port", "4096"])
        assert _cmdline_is_orphan_runtime(["/usr/local/bin/opencode", "serve"])

    def test_matches_bridge_module(self):
        assert _cmdline_is_orphan_runtime(
            ["python", "-m", "sandbox_runtime.bridge", "--sandbox-id", "sb-1"]
        )
        assert _cmdline_is_orphan_runtime(["python3.12", "-m", "sandbox_runtime.bridge"])

    def test_ignores_other_processes(self):
        assert not _cmdline_is_orphan_runtime([])
        assert not _cmdline_is_orphan_runtime(["opencode", "run", "serve"])
        assert not _cmdline_is_orphan_runtime(["python", "-m", "sandbox_runtime.entrypoint"])
        assert not _cmdline_is_orphan_runtime(["grep", "sandbox_runtime.bridge"])
        assert not _cmdline_is_orphan_runtime(["sleep", "30"])


class TestStatStartTime:
    def test_parses_start_time_after_comm(self):
        # Fields 3..22 after the parenthesized comm; start time is field 22.
        tail = b"S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654"
        assert _parse_stat_start_time(b"1234 (opencode) " + tail) == "987654"

    def test_comm_with_spaces_and_parens(self):
        tail = b"R 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 424242"
        assert _parse_stat_start_time(b"42 (weird) proc (name)) " + tail) == "424242"

    def test_truncated_stat_returns_none(self):
        assert _parse_stat_start_time(b"42 (short) S 1 2") is None


class TestReapOrphans:
    async def test_reap_terminates_found_processes(self, tmp_path):
        guard = _make_guard(tmp_path)
        proc = subprocess.Popen(["sleep", "30"])
        try:
            guard._find_orphan_runtime_processes = MagicMock(return_value=[(proc.pid, "111")])

            await guard.reap_orphan_runtime_processes()

            assert proc.wait(timeout=5) != 0
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()

    async def test_reap_with_no_orphans_is_a_noop(self, tmp_path):
        guard = _make_guard(tmp_path)
        guard._find_orphan_runtime_processes = MagicMock(return_value=[])

        await guard.reap_orphan_runtime_processes()

    async def test_reap_survives_already_dead_pid(self, tmp_path):
        guard = _make_guard(tmp_path)
        proc = subprocess.Popen(["sleep", "30"])
        proc.kill()
        proc.wait()
        guard._find_orphan_runtime_processes = MagicMock(return_value=[(proc.pid, "111")])

        await guard.reap_orphan_runtime_processes()

    async def test_escalates_to_sigkill_when_term_is_ignored(self, tmp_path):
        guard = _make_guard(tmp_path, term_timeout_seconds=0.3)
        guard._find_orphan_runtime_processes = MagicMock(return_value=[(4242, "111")])
        kills: list[tuple[int, int]] = []
        with (
            patch(
                "sandbox_runtime.supervisor_guard.os.kill",
                side_effect=lambda pid, sig: kills.append((pid, sig)),
            ),
            patch("sandbox_runtime.supervisor_guard._proc_start_time", return_value="111"),
        ):
            await guard.reap_orphan_runtime_processes()

        assert kills == [(4242, signal.SIGTERM), (4242, signal.SIGKILL)]

    async def test_recycled_pid_is_never_sigkilled(self, tmp_path):
        """The orphan exits during the grace period and Linux reuses its PID:
        the replacement process has a different start time and must not be
        signalled."""
        guard = _make_guard(tmp_path, term_timeout_seconds=0.3)
        guard._find_orphan_runtime_processes = MagicMock(return_value=[(4242, "111")])
        kills: list[tuple[int, int]] = []
        with (
            patch(
                "sandbox_runtime.supervisor_guard.os.kill",
                side_effect=lambda pid, sig: kills.append((pid, sig)),
            ),
            patch("sandbox_runtime.supervisor_guard._proc_start_time", return_value="999"),
        ):
            await guard.reap_orphan_runtime_processes()

        assert kills == [(4242, signal.SIGTERM)]

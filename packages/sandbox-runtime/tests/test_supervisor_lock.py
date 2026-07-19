"""Tests for the single-supervisor lock and orphan runtime reaping."""

import os
import subprocess
from unittest.mock import AsyncMock, MagicMock, patch

from sandbox_runtime.entrypoint import SandboxSupervisor, _cmdline_is_orphan_runtime


def _make_supervisor() -> SandboxSupervisor:
    """Create a SandboxSupervisor with env vars stubbed out."""
    with patch.dict(
        "os.environ",
        {
            "SANDBOX_ID": "test-sandbox",
            "CONTROL_PLANE_URL": "https://cp.example.com",
            "SANDBOX_AUTH_TOKEN": "tok",
            "REPO_OWNER": "acme",
            "REPO_NAME": "app",
        },
    ):
        return SandboxSupervisor()


class TestAcquireSupervisorLock:
    def test_first_acquire_succeeds_and_records_pid(self, tmp_path, monkeypatch):
        lock_path = tmp_path / "supervisor.lock"
        monkeypatch.setattr("sandbox_runtime.entrypoint.SUPERVISOR_LOCK_FILE_PATH", str(lock_path))
        sup = _make_supervisor()

        assert sup.acquire_supervisor_lock() is True
        assert sup.supervisor_lock_fd is not None
        assert lock_path.read_text() == str(os.getpid())

    def test_second_acquire_fails_while_first_holds(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            "sandbox_runtime.entrypoint.SUPERVISOR_LOCK_FILE_PATH",
            str(tmp_path / "supervisor.lock"),
        )
        first = _make_supervisor()
        second = _make_supervisor()

        assert first.acquire_supervisor_lock() is True
        assert second.acquire_supervisor_lock() is False
        assert second.supervisor_lock_fd is None

    def test_lock_released_on_holder_death_allows_new_acquire(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            "sandbox_runtime.entrypoint.SUPERVISOR_LOCK_FILE_PATH",
            str(tmp_path / "supervisor.lock"),
        )
        first = _make_supervisor()
        second = _make_supervisor()

        assert first.acquire_supervisor_lock() is True
        # Closing the fd is what the kernel does implicitly when the holding
        # process dies (SIGKILL included).
        os.close(first.supervisor_lock_fd)

        assert second.acquire_supervisor_lock() is True

    def test_stale_lock_file_does_not_block_boot(self, tmp_path, monkeypatch):
        """A lock FILE restored from a snapshot has no live holder — must not block."""
        lock_path = tmp_path / "supervisor.lock"
        lock_path.write_text("424242")
        monkeypatch.setattr("sandbox_runtime.entrypoint.SUPERVISOR_LOCK_FILE_PATH", str(lock_path))
        sup = _make_supervisor()

        assert sup.acquire_supervisor_lock() is True
        assert lock_path.read_text() == str(os.getpid())

    def test_unexpected_open_error_fails_open(self, tmp_path, monkeypatch):
        """A filesystem quirk must not brick the boot — proceed unguarded."""
        monkeypatch.setattr(
            "sandbox_runtime.entrypoint.SUPERVISOR_LOCK_FILE_PATH",
            str(tmp_path / "missing-dir" / "supervisor.lock"),
        )
        sup = _make_supervisor()

        assert sup.acquire_supervisor_lock() is True
        assert sup.supervisor_lock_fd is None


class TestRunGuard:
    async def test_run_exits_before_side_effects_when_duplicate(self):
        sup = _make_supervisor()
        sup.acquire_supervisor_lock = MagicMock(return_value=False)
        sup.reap_orphan_runtime_processes = AsyncMock()
        sup._write_repo_manifest = MagicMock()
        sup.sync_repositories = AsyncMock()

        await sup.run()

        sup.reap_orphan_runtime_processes.assert_not_called()
        sup._write_repo_manifest.assert_not_called()
        sup.sync_repositories.assert_not_called()


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


class TestReapOrphans:
    async def test_reap_terminates_found_pids(self):
        sup = _make_supervisor()
        sup.ORPHAN_TERM_TIMEOUT_SECONDS = 0.5
        proc = subprocess.Popen(["sleep", "30"])
        try:
            sup._find_orphan_runtime_pids = MagicMock(return_value=[proc.pid])

            await sup.reap_orphan_runtime_processes()

            assert proc.wait(timeout=5) != 0
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()

    async def test_reap_with_no_orphans_is_a_noop(self):
        sup = _make_supervisor()
        sup._find_orphan_runtime_pids = MagicMock(return_value=[])

        await sup.reap_orphan_runtime_processes()

    async def test_reap_survives_already_dead_pid(self):
        sup = _make_supervisor()
        proc = subprocess.Popen(["sleep", "30"])
        proc.kill()
        proc.wait()
        sup._find_orphan_runtime_pids = MagicMock(return_value=[proc.pid])

        await sup.reap_orphan_runtime_processes()

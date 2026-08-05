"""Tests for SandboxSupervisor tunnel-env-file handling.

The supervisor owns the tunnel env file lifecycle from inside the sandbox:
- at boot, keeps a file the manager already wrote for THIS sandbox (the
  manager's write can land before the entrypoint runs) and clears anything
  else as a snapshot/image leftover
- blocks `start.sh` until the manager has written fresh URLs (bounded)
"""

import asyncio
from unittest.mock import patch

import pytest

from sandbox_runtime.constants import (
    EXPECTED_TUNNEL_PORTS_ENV_VAR,
    TUNNEL_ENV_FILE_PATH,
    TUNNEL_ENV_SANDBOX_ID_KEY,
)
from sandbox_runtime.entrypoint import SandboxSupervisor


def _make_supervisor() -> SandboxSupervisor:
    """Create a SandboxSupervisor with minimal stable env.

    Env vars read live (like EXPECTED_TUNNEL_PORTS) must be patched in the test
    body, not here — this helper only stabilizes the constructor.
    """
    base_env = {
        "SANDBOX_ID": "test-sandbox",
        "CONTROL_PLANE_URL": "https://cp.example.com",
        "SANDBOX_AUTH_TOKEN": "tok",
        "REPO_OWNER": "acme",
        "REPO_NAME": "app",
    }
    with patch.dict("os.environ", base_env, clear=True):
        return SandboxSupervisor()


class TestExpectedTunnelPorts:
    def test_returns_empty_list_when_env_var_unset(self, monkeypatch):
        monkeypatch.delenv(EXPECTED_TUNNEL_PORTS_ENV_VAR, raising=False)
        sup = _make_supervisor()
        assert sup._expected_tunnel_ports() == []

    def test_parses_single_port(self, monkeypatch):
        monkeypatch.setenv(EXPECTED_TUNNEL_PORTS_ENV_VAR, "3000")
        sup = _make_supervisor()
        assert sup._expected_tunnel_ports() == [3000]

    def test_parses_multiple_ports(self, monkeypatch):
        monkeypatch.setenv(EXPECTED_TUNNEL_PORTS_ENV_VAR, "3000,5173,8080")
        sup = _make_supervisor()
        assert sup._expected_tunnel_ports() == [3000, 5173, 8080]

    def test_tolerates_whitespace(self, monkeypatch):
        monkeypatch.setenv(EXPECTED_TUNNEL_PORTS_ENV_VAR, " 3000 , 5173 ")
        sup = _make_supervisor()
        assert sup._expected_tunnel_ports() == [3000, 5173]

    def test_skips_unparseable_entries(self, monkeypatch):
        monkeypatch.setenv(EXPECTED_TUNNEL_PORTS_ENV_VAR, "3000,not-a-port,5173")
        sup = _make_supervisor()
        assert sup._expected_tunnel_ports() == [3000, 5173]

    def test_empty_string_returns_empty(self, monkeypatch):
        monkeypatch.setenv(EXPECTED_TUNNEL_PORTS_ENV_VAR, "")
        sup = _make_supervisor()
        assert sup._expected_tunnel_ports() == []


class TestClearStaleTunnelEnvFile:
    def test_removes_untagged_file(self, tmp_path, monkeypatch):
        """A file with no sandbox-ID tag (pre-tag writer, or user-made) is stale."""
        stub_path = tmp_path / "tunnels.env"
        stub_path.write_text("TUNNEL_3000=https://stale.example.com\n")
        monkeypatch.setattr("sandbox_runtime.entrypoint.TUNNEL_ENV_FILE_PATH", str(stub_path))

        sup = _make_supervisor()
        sup._clear_stale_tunnel_env_file()

        assert not stub_path.exists()

    def test_keeps_file_tagged_with_own_sandbox_id(self, tmp_path, monkeypatch):
        """The manager's write can land before the entrypoint runs; keep it."""
        stub_path = tmp_path / "tunnels.env"
        content = (
            f"{TUNNEL_ENV_SANDBOX_ID_KEY}=test-sandbox\nTUNNEL_3000=https://fresh.example.com\n"
        )
        stub_path.write_text(content)
        monkeypatch.setattr("sandbox_runtime.entrypoint.TUNNEL_ENV_FILE_PATH", str(stub_path))

        sup = _make_supervisor()
        sup._clear_stale_tunnel_env_file()

        assert stub_path.read_text() == content

    def test_removes_file_tagged_with_other_sandbox_id(self, tmp_path, monkeypatch):
        """A snapshot/image leftover carries the previous sandbox's ID."""
        stub_path = tmp_path / "tunnels.env"
        stub_path.write_text(
            f"{TUNNEL_ENV_SANDBOX_ID_KEY}=previous-sandbox\nTUNNEL_3000=https://stale.example.com\n"
        )
        monkeypatch.setattr("sandbox_runtime.entrypoint.TUNNEL_ENV_FILE_PATH", str(stub_path))

        sup = _make_supervisor()
        sup._clear_stale_tunnel_env_file()

        assert not stub_path.exists()

    def test_removes_tagged_file_when_own_sandbox_id_unknown(self, tmp_path, monkeypatch):
        """Without a SANDBOX_ID identity, never trust a pre-existing file."""
        stub_path = tmp_path / "tunnels.env"
        stub_path.write_text(f"{TUNNEL_ENV_SANDBOX_ID_KEY}=unknown\n")
        monkeypatch.setattr("sandbox_runtime.entrypoint.TUNNEL_ENV_FILE_PATH", str(stub_path))

        base_env = {
            "CONTROL_PLANE_URL": "https://cp.example.com",
            "SANDBOX_AUTH_TOKEN": "tok",
            "REPO_OWNER": "acme",
            "REPO_NAME": "app",
        }
        with patch.dict("os.environ", base_env, clear=True):
            sup = SandboxSupervisor()
        sup._clear_stale_tunnel_env_file()

        assert not stub_path.exists()

    def test_removes_dangling_symlink(self, tmp_path, monkeypatch):
        """exists() is False for a broken symlink, but it must still be cleared."""
        stub_path = tmp_path / "tunnels.env"
        stub_path.symlink_to(tmp_path / "missing-target")
        monkeypatch.setattr("sandbox_runtime.entrypoint.TUNNEL_ENV_FILE_PATH", str(stub_path))

        sup = _make_supervisor()
        sup._clear_stale_tunnel_env_file()

        assert not stub_path.is_symlink()
        assert not stub_path.exists()

    def test_no_op_when_file_missing(self, tmp_path, monkeypatch):
        stub_path = tmp_path / "tunnels.env"
        monkeypatch.setattr("sandbox_runtime.entrypoint.TUNNEL_ENV_FILE_PATH", str(stub_path))

        sup = _make_supervisor()
        sup._clear_stale_tunnel_env_file()  # must not raise


class TestWaitForTunnelEnvFile:
    @pytest.mark.asyncio
    async def test_returns_true_immediately_when_no_ports_expected(self):
        sup = _make_supervisor()
        assert await sup._wait_for_tunnel_env_file([]) is True

    @pytest.mark.asyncio
    async def test_returns_true_when_file_already_present(self, tmp_path, monkeypatch):
        stub_path = tmp_path / "tunnels.env"
        stub_path.write_text("TUNNEL_3000=https://fresh.example.com\n")
        monkeypatch.setattr("sandbox_runtime.entrypoint.TUNNEL_ENV_FILE_PATH", str(stub_path))

        sup = _make_supervisor()
        assert await sup._wait_for_tunnel_env_file([3000]) is True

    @pytest.mark.asyncio
    async def test_returns_true_for_all_expected_ports(self, tmp_path, monkeypatch):
        stub_path = tmp_path / "tunnels.env"
        stub_path.write_text(
            "TUNNEL_3000=https://a.example.com\nTUNNEL_5173=https://b.example.com\n"
        )
        monkeypatch.setattr("sandbox_runtime.entrypoint.TUNNEL_ENV_FILE_PATH", str(stub_path))

        sup = _make_supervisor()
        assert await sup._wait_for_tunnel_env_file([3000, 5173]) is True

    @pytest.mark.asyncio
    async def test_returns_false_on_timeout_when_file_missing(self, tmp_path, monkeypatch):
        stub_path = tmp_path / "tunnels.env"
        monkeypatch.setattr("sandbox_runtime.entrypoint.TUNNEL_ENV_FILE_PATH", str(stub_path))
        monkeypatch.setenv("TUNNEL_WAIT_TIMEOUT_SECONDS", "0.05")

        sup = _make_supervisor()
        sup.TUNNEL_WAIT_POLL_INTERVAL_SECONDS = 0.01
        assert await sup._wait_for_tunnel_env_file([3000]) is False

    @pytest.mark.asyncio
    async def test_returns_false_when_only_partial_ports_resolve(self, tmp_path, monkeypatch):
        """If Modal only resolves a subset of ports, we time out and degrade."""
        stub_path = tmp_path / "tunnels.env"
        stub_path.write_text("TUNNEL_3000=https://a.example.com\n")
        monkeypatch.setattr("sandbox_runtime.entrypoint.TUNNEL_ENV_FILE_PATH", str(stub_path))
        monkeypatch.setenv("TUNNEL_WAIT_TIMEOUT_SECONDS", "0.05")

        sup = _make_supervisor()
        sup.TUNNEL_WAIT_POLL_INTERVAL_SECONDS = 0.01
        assert await sup._wait_for_tunnel_env_file([3000, 5173]) is False

    @pytest.mark.asyncio
    async def test_returns_true_when_file_appears_during_wait(self, tmp_path, monkeypatch):
        stub_path = tmp_path / "tunnels.env"
        monkeypatch.setattr("sandbox_runtime.entrypoint.TUNNEL_ENV_FILE_PATH", str(stub_path))
        monkeypatch.setenv("TUNNEL_WAIT_TIMEOUT_SECONDS", "1.0")

        sup = _make_supervisor()
        sup.TUNNEL_WAIT_POLL_INTERVAL_SECONDS = 0.02

        async def write_after_delay() -> None:
            await asyncio.sleep(0.05)
            stub_path.write_text("TUNNEL_3000=https://late.example.com\n")

        writer = asyncio.create_task(write_after_delay())
        try:
            assert await sup._wait_for_tunnel_env_file([3000]) is True
        finally:
            await writer


class TestConstantValue:
    """Sanity: the shared constant is the path we expect the manager to write."""

    def test_default_path(self):
        assert TUNNEL_ENV_FILE_PATH == "/workspace/.tunnels.env"

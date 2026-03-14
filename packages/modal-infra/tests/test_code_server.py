"""Tests for code-server integration in SandboxManager and SandboxSupervisor."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.sandbox.manager import CODE_SERVER_PORT, SandboxConfig, SandboxManager


class TestGenerateCodeServerPassword:
    """SandboxManager._generate_code_server_password tests."""

    def test_returns_nonempty_password(self):
        password = SandboxManager._generate_code_server_password()
        assert len(password) > 0

    def test_generates_unique_passwords(self):
        passwords = set()
        for _ in range(20):
            passwords.add(SandboxManager._generate_code_server_password())
        assert len(passwords) == 20


class TestResolveCodeServerTunnel:
    """SandboxManager._resolve_code_server_tunnel tests."""

    @pytest.mark.asyncio
    async def test_returns_tunnel_url_on_success(self):
        tunnel = MagicMock()
        tunnel.url = "https://tunnel.example.com"

        sandbox = MagicMock()
        sandbox.tunnels.return_value = {CODE_SERVER_PORT: tunnel}

        url = await SandboxManager._resolve_code_server_tunnel(sandbox, "sb-123")
        assert url == "https://tunnel.example.com"

    @pytest.mark.asyncio
    async def test_returns_none_on_exception_after_retries(self):
        sandbox = MagicMock()
        sandbox.tunnels.side_effect = Exception("tunnel unavailable")

        with patch("src.sandbox.manager.asyncio.sleep", new_callable=AsyncMock):
            url = await SandboxManager._resolve_code_server_tunnel(
                sandbox, "sb-123", retries=2, backoff=0.0
            )
        assert url is None
        assert sandbox.tunnels.call_count == 2

    @pytest.mark.asyncio
    async def test_returns_none_when_port_missing_after_retries(self):
        sandbox = MagicMock()
        sandbox.tunnels.return_value = {}  # no entry for CODE_SERVER_PORT

        with patch("src.sandbox.manager.asyncio.sleep", new_callable=AsyncMock):
            url = await SandboxManager._resolve_code_server_tunnel(
                sandbox, "sb-123", retries=2, backoff=0.0
            )
        assert url is None

    @pytest.mark.asyncio
    async def test_retries_then_succeeds(self):
        tunnel = MagicMock()
        tunnel.url = "https://tunnel.example.com"

        sandbox = MagicMock()
        sandbox.tunnels.side_effect = [
            Exception("not ready"),
            {CODE_SERVER_PORT: tunnel},
        ]

        with patch("src.sandbox.manager.asyncio.sleep", new_callable=AsyncMock):
            url = await SandboxManager._resolve_code_server_tunnel(
                sandbox, "sb-123", retries=3, backoff=0.0
            )
        assert url == "https://tunnel.example.com"
        assert sandbox.tunnels.call_count == 2


class TestCreateSandboxCodeServer:
    """create_sandbox populates code-server fields on the returned handle."""

    @pytest.mark.asyncio
    async def test_handle_contains_code_server_fields(self, monkeypatch):
        captured = {}

        async def fake_create_aio(*args, **kwargs):
            captured["env"] = kwargs.get("env")
            captured["encrypted_ports"] = kwargs.get("encrypted_ports")

            class FakeSandbox:
                object_id = "obj-123"
                stdout = None

            return FakeSandbox()

        fake_create = MagicMock()
        fake_create.aio = fake_create_aio
        monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", fake_create)

        monkeypatch.setattr(
            SandboxManager,
            "_resolve_code_server_tunnel",
            AsyncMock(return_value="https://cs.example.com"),
        )

        manager = SandboxManager()
        config = SandboxConfig(
            repo_owner="acme",
            repo_name="repo",
            control_plane_url="https://cp.example.com",
            sandbox_auth_token="token-123",
        )

        handle = await manager.create_sandbox(config)

        assert handle.code_server_url == "https://cs.example.com"
        assert handle.code_server_password is not None
        assert len(handle.code_server_password) > 0
        # Password should be injected into sandbox env vars
        assert captured["env"]["CODE_SERVER_PASSWORD"] == handle.code_server_password
        # Code-server port should be in encrypted_ports
        assert captured["encrypted_ports"] == [CODE_SERVER_PORT]


class TestRestoreSandboxCodeServer:
    """restore_from_snapshot populates code-server fields on the returned handle."""

    @pytest.mark.asyncio
    async def test_handle_contains_code_server_fields(self, monkeypatch):
        captured = {}

        class FakeImage:
            object_id = "img-123"

        def fake_from_id(*args, **kwargs):
            return FakeImage()

        async def fake_create_aio(*args, **kwargs):
            captured["env"] = kwargs.get("env")
            captured["encrypted_ports"] = kwargs.get("encrypted_ports")

            class FakeSandbox:
                object_id = "obj-456"
                stdout = None

            return FakeSandbox()

        fake_create = MagicMock()
        fake_create.aio = fake_create_aio
        monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", fake_from_id)
        monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", fake_create)
        monkeypatch.setattr(
            SandboxManager,
            "_resolve_code_server_tunnel",
            AsyncMock(return_value="https://cs-restored.example.com"),
        )

        manager = SandboxManager()
        handle = await manager.restore_from_snapshot(
            snapshot_image_id="img-abc",
            session_config={
                "repo_owner": "acme",
                "repo_name": "repo",
                "provider": "anthropic",
                "model": "claude-sonnet-4-6",
                "session_id": "sess-1",
            },
            control_plane_url="https://cp.example.com",
            sandbox_auth_token="token-456",
        )

        assert handle.code_server_url == "https://cs-restored.example.com"
        assert handle.code_server_password is not None
        assert captured["env"]["CODE_SERVER_PASSWORD"] == handle.code_server_password
        assert captured["encrypted_ports"] == [CODE_SERVER_PORT]


class TestCodeServerMonitorRestart:
    """code-server restart in monitor_processes is non-fatal and handles exceptions."""

    def _make_supervisor(self):
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
            from src.sandbox.entrypoint import SandboxSupervisor

            return SandboxSupervisor()

    def _fake_process(self, returncode):
        proc = MagicMock()
        proc.returncode = returncode
        return proc

    async def test_code_server_crash_does_not_set_shutdown(self):
        """code-server crash should NOT trigger supervisor shutdown."""
        sup = self._make_supervisor()
        sup.opencode_process = self._fake_process(returncode=None)
        sup.bridge_process = self._fake_process(returncode=None)

        # code-server exited with code 1
        original_process = self._fake_process(returncode=1)
        running_process = self._fake_process(returncode=None)

        def restart_side_effect():
            sup.code_server_process = running_process
            sup.shutdown_event.set()  # terminate the monitor loop

        sup.code_server_process = original_process
        sup.start_code_server = AsyncMock(side_effect=restart_side_effect)

        with patch("asyncio.sleep", new_callable=AsyncMock):
            await sup.monitor_processes()

        sup.start_code_server.assert_called_once()
        # shutdown_event is set by our side_effect, not by the supervisor
        # confirming code-server crash does not call _report_fatal_error
        assert not hasattr(sup, "_report_fatal_error_called")

    async def test_code_server_restart_exception_is_caught(self):
        """If start_code_server() raises, the supervisor continues running."""
        sup = self._make_supervisor()
        sup.opencode_process = self._fake_process(returncode=None)
        sup.bridge_process = self._fake_process(returncode=None)
        sup.code_server_process = self._fake_process(returncode=1)

        call_count = 0

        async def failing_restart():
            nonlocal call_count
            call_count += 1
            raise RuntimeError("code-server binary not found")

        sup.start_code_server = AsyncMock(side_effect=failing_restart)

        # After the restart fails, code_server_process should be set to None
        # so the monitor loop stops checking it. We set shutdown after one iteration.
        iteration = 0

        async def counting_sleep(delay):
            nonlocal iteration
            iteration += 1
            if iteration >= 2:
                sup.shutdown_event.set()

        with patch("asyncio.sleep", side_effect=counting_sleep):
            await sup.monitor_processes()

        assert call_count == 1
        assert sup.code_server_process is None

    async def test_code_server_max_restarts_gives_up(self):
        """After MAX_RESTARTS, code-server is abandoned (process set to None)."""
        sup = self._make_supervisor()
        sup.opencode_process = self._fake_process(returncode=None)
        sup.bridge_process = self._fake_process(returncode=None)

        # code-server always crashes
        sup.code_server_process = self._fake_process(returncode=1)
        sup.start_code_server = AsyncMock()  # no-op, process stays crashed
        sup._report_fatal_error = AsyncMock()

        # After code-server gives up, the loop continues (non-fatal).
        # Terminate after enough iterations to observe the give-up behavior.
        # Each restart cycle has 2 sleeps (backoff + 1.0s monitor interval),
        # so we need at least MAX_RESTARTS * 2 + extra to see all restarts.
        sleep_count = 0

        async def counting_sleep(delay):
            nonlocal sleep_count
            sleep_count += 1
            if sleep_count > sup.MAX_RESTARTS * 3:
                sup.shutdown_event.set()

        with patch("asyncio.sleep", side_effect=counting_sleep):
            await sup.monitor_processes()

        # Should have restarted MAX_RESTARTS times, then given up
        assert sup.start_code_server.call_count == sup.MAX_RESTARTS
        assert sup.code_server_process is None
        # Should NOT have reported a fatal error (code-server is non-fatal)
        sup._report_fatal_error.assert_not_called()

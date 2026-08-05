"""Tests for tunnel port features in SandboxManager."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.constants import (
    CODE_SERVER_PORT_ENV_VAR,
    EXPECTED_TUNNEL_PORTS_ENV_VAR,
    TTYD_PROXY_PORT,
    TTYD_PROXY_PORT_ENV_VAR,
    TUNNEL_ENV_FILE_PATH,
    TUNNEL_ENV_SANDBOX_ID_KEY,
)
from src.sandbox.manager import CODE_SERVER_PORT, SandboxConfig, SandboxManager


def _mock_sandbox_with_filesystem() -> tuple[MagicMock, AsyncMock]:
    """Return (sandbox, write_text) with sandbox.filesystem.write_text.aio mocked."""
    write_text = AsyncMock()
    sandbox = MagicMock()
    sandbox.filesystem = MagicMock()
    sandbox.filesystem.write_text = MagicMock()
    sandbox.filesystem.write_text.aio = write_text
    return sandbox, write_text


class TestResolveTunnels:
    """SandboxManager._resolve_tunnels tests."""

    @pytest.mark.asyncio
    async def test_resolves_all_ports(self):
        tunnel_3000 = MagicMock()
        tunnel_3000.url = "https://tunnel-3000.example.com"
        tunnel_3001 = MagicMock()
        tunnel_3001.url = "https://tunnel-3001.example.com"

        sandbox = MagicMock()
        sandbox.tunnels.return_value = {3000: tunnel_3000, 3001: tunnel_3001}

        result = await SandboxManager._resolve_tunnels(sandbox, "sb-1", [3000, 3001])
        assert result == {
            3000: "https://tunnel-3000.example.com",
            3001: "https://tunnel-3001.example.com",
        }

    @pytest.mark.asyncio
    async def test_returns_partial_on_missing_port(self):
        tunnel_3000 = MagicMock()
        tunnel_3000.url = "https://tunnel-3000.example.com"

        sandbox = MagicMock()
        sandbox.tunnels.return_value = {3000: tunnel_3000}

        with patch("src.sandbox.manager.asyncio.sleep", new_callable=AsyncMock):
            result = await SandboxManager._resolve_tunnels(
                sandbox, "sb-1", [3000, 3001], retries=2, backoff=0.0
            )
        assert result == {3000: "https://tunnel-3000.example.com"}

    @pytest.mark.asyncio
    async def test_returns_empty_on_exception_after_retries(self):
        sandbox = MagicMock()
        sandbox.tunnels.side_effect = Exception("tunnel unavailable")

        with patch("src.sandbox.manager.asyncio.sleep", new_callable=AsyncMock):
            result = await SandboxManager._resolve_tunnels(
                sandbox, "sb-1", [3000], retries=3, backoff=0.0
            )
        assert result == {}

    @pytest.mark.asyncio
    async def test_retries_on_partial_resolution(self):
        tunnel_3000 = MagicMock()
        tunnel_3000.url = "https://tunnel-3000.example.com"
        tunnel_3001 = MagicMock()
        tunnel_3001.url = "https://tunnel-3001.example.com"

        sandbox = MagicMock()
        sandbox.tunnels.side_effect = [
            {3000: tunnel_3000},
            {3000: tunnel_3000, 3001: tunnel_3001},
        ]

        with patch("src.sandbox.manager.asyncio.sleep", new_callable=AsyncMock):
            result = await SandboxManager._resolve_tunnels(
                sandbox, "sb-1", [3000, 3001], retries=3, backoff=0.0
            )
        assert result == {
            3000: "https://tunnel-3000.example.com",
            3001: "https://tunnel-3001.example.com",
        }
        assert sandbox.tunnels.call_count == 2


class TestResolveAndSetupTunnels:
    """SandboxManager._resolve_and_setup_tunnels tests."""

    @pytest.mark.asyncio
    async def test_returns_none_none_none_for_no_ports(self):
        sandbox = MagicMock()
        cs_url, ttyd_url, extra = await SandboxManager._resolve_and_setup_tunnels(
            sandbox,
            "sb-1",
            False,
            False,
            [],
            code_server_port=CODE_SERVER_PORT,
            ttyd_proxy_port=TTYD_PROXY_PORT,
        )
        assert cs_url is None
        assert ttyd_url is None
        assert extra is None

    @pytest.mark.asyncio
    async def test_resolves_extra_ports(self):
        tunnel_urls = {3000: "https://tunnel-3000.example.com"}

        sandbox, _write_text = _mock_sandbox_with_filesystem()
        with patch.object(
            SandboxManager,
            "_resolve_tunnels",
            new_callable=AsyncMock,
            return_value=tunnel_urls,
        ):
            cs_url, ttyd_url, extra = await SandboxManager._resolve_and_setup_tunnels(
                sandbox,
                "sb-1",
                False,
                False,
                [3000],
                code_server_port=CODE_SERVER_PORT,
                ttyd_proxy_port=TTYD_PROXY_PORT,
            )

        assert cs_url is None
        assert ttyd_url is None
        assert extra == {3000: "https://tunnel-3000.example.com"}

    @pytest.mark.asyncio
    async def test_splits_code_server_from_extra_ports(self):
        resolved = {
            CODE_SERVER_PORT: "https://cs.example.com",
            3000: "https://tunnel-3000.example.com",
        }

        sandbox, _write_text = _mock_sandbox_with_filesystem()

        with patch.object(
            SandboxManager,
            "_resolve_tunnels",
            new_callable=AsyncMock,
            return_value=resolved,
        ):
            cs_url, ttyd_url, extra = await SandboxManager._resolve_and_setup_tunnels(
                sandbox,
                "sb-1",
                True,
                False,
                [3000],
                code_server_port=CODE_SERVER_PORT,
                ttyd_proxy_port=TTYD_PROXY_PORT,
            )

        assert cs_url == "https://cs.example.com"
        assert ttyd_url is None
        assert extra == {3000: "https://tunnel-3000.example.com"}

    @pytest.mark.asyncio
    async def test_keeps_code_server_port_tunnel_when_code_server_disabled(self):
        """Regression: a user's own 8080 tunnel is kept, not misrouted to code_server_url."""
        resolved = {CODE_SERVER_PORT: "https://my-app.example.com"}
        sandbox, _write_text = _mock_sandbox_with_filesystem()

        with patch.object(
            SandboxManager,
            "_resolve_tunnels",
            new_callable=AsyncMock,
            return_value=resolved,
        ):
            cs_url, ttyd_url, extra = await SandboxManager._resolve_and_setup_tunnels(
                sandbox,
                "sb-1",
                False,
                False,
                [CODE_SERVER_PORT],
                code_server_port=CODE_SERVER_PORT,
                ttyd_proxy_port=TTYD_PROXY_PORT,
            )

        assert cs_url is None
        assert ttyd_url is None
        assert extra == {CODE_SERVER_PORT: "https://my-app.example.com"}

    @pytest.mark.asyncio
    async def test_splits_custom_code_server_port_from_user_tunnel(self):
        """code-server on 8081 → its URL is the code_server_url; user's 8080 is a tunnel."""
        resolved = {
            8081: "https://cs.example.com",
            CODE_SERVER_PORT: "https://my-app.example.com",
        }
        sandbox, _write_text = _mock_sandbox_with_filesystem()

        with patch.object(
            SandboxManager,
            "_resolve_tunnels",
            new_callable=AsyncMock,
            return_value=resolved,
        ):
            cs_url, _ttyd_url, extra = await SandboxManager._resolve_and_setup_tunnels(
                sandbox,
                "sb-1",
                True,
                False,
                [CODE_SERVER_PORT],
                code_server_port=8081,
                ttyd_proxy_port=TTYD_PROXY_PORT,
            )

        assert cs_url == "https://cs.example.com"
        assert extra == {CODE_SERVER_PORT: "https://my-app.example.com"}


class TestWriteTunnelEnvFile:
    """SandboxManager._write_tunnel_env_file tests."""

    @pytest.mark.asyncio
    async def test_writes_dotenv_format_to_expected_path(self):
        sandbox, write_text = _mock_sandbox_with_filesystem()

        await SandboxManager._write_tunnel_env_file(
            sandbox,
            "sb-1",
            {
                3001: "https://tunnel-3001.example.com",
                3000: "https://tunnel-3000.example.com",
            },
        )

        write_text.assert_awaited_once()
        written, path = write_text.call_args[0]
        assert path == TUNNEL_ENV_FILE_PATH
        # Sandbox-ID tag first, then sorted by port, dotenv format, trailing newline.
        assert written == (
            f"{TUNNEL_ENV_SANDBOX_ID_KEY}=sb-1\n"
            "TUNNEL_3000=https://tunnel-3000.example.com\n"
            "TUNNEL_3001=https://tunnel-3001.example.com\n"
        )

    @pytest.mark.asyncio
    async def test_write_failure_does_not_raise(self):
        sandbox, write_text = _mock_sandbox_with_filesystem()
        write_text.side_effect = Exception("write failed")

        with patch("src.sandbox.manager.log") as mock_log:
            await SandboxManager._write_tunnel_env_file(
                sandbox, "sb-1", {3000: "https://tunnel-3000.example.com"}
            )

        mock_log.warn.assert_called_once()
        assert mock_log.warn.call_args[0][0] == "tunnel.urls_write_failed"


class TestResolveAndSetupTunnelsWritesFile:
    """Integration of _resolve_and_setup_tunnels with the env-file write."""

    @pytest.mark.asyncio
    async def test_writes_file_when_extra_urls_present(self):
        sandbox, write_text = _mock_sandbox_with_filesystem()
        tunnel_urls = {3000: "https://tunnel-3000.example.com"}

        with patch.object(
            SandboxManager,
            "_resolve_tunnels",
            new_callable=AsyncMock,
            return_value=tunnel_urls,
        ):
            await SandboxManager._resolve_and_setup_tunnels(
                sandbox,
                "sb-1",
                False,
                False,
                [3000],
                code_server_port=CODE_SERVER_PORT,
                ttyd_proxy_port=TTYD_PROXY_PORT,
            )

        write_text.assert_awaited_once()
        written = write_text.call_args[0][0]
        assert written.startswith(f"{TUNNEL_ENV_SANDBOX_ID_KEY}=sb-1\n")
        assert "TUNNEL_3000=https://tunnel-3000.example.com" in written

    @pytest.mark.asyncio
    async def test_does_not_write_file_when_no_extra_urls(self):
        sandbox, write_text = _mock_sandbox_with_filesystem()

        with patch.object(
            SandboxManager,
            "_resolve_tunnels",
            new_callable=AsyncMock,
            return_value={},
        ):
            _cs, _ttyd, extra = await SandboxManager._resolve_and_setup_tunnels(
                sandbox,
                "sb-1",
                False,
                False,
                [3000],
                code_server_port=CODE_SERVER_PORT,
                ttyd_proxy_port=TTYD_PROXY_PORT,
            )

        assert extra is None
        write_text.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_does_not_write_file_for_only_reserved_ports(self):
        """code-server / ttyd URLs aren't extras; no file is written when those are the only ones."""
        sandbox, write_text = _mock_sandbox_with_filesystem()

        with patch.object(
            SandboxManager,
            "_resolve_tunnels",
            new_callable=AsyncMock,
            return_value={CODE_SERVER_PORT: "https://cs.example.com"},
        ):
            await SandboxManager._resolve_and_setup_tunnels(
                sandbox,
                "sb-1",
                True,
                False,
                [],
                code_server_port=CODE_SERVER_PORT,
                ttyd_proxy_port=TTYD_PROXY_PORT,
            )

        write_text.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_write_failure_does_not_block_return(self):
        sandbox, write_text = _mock_sandbox_with_filesystem()
        write_text.side_effect = Exception("boom")

        with (
            patch.object(
                SandboxManager,
                "_resolve_tunnels",
                new_callable=AsyncMock,
                return_value={3000: "https://tunnel-3000.example.com"},
            ),
            patch("src.sandbox.manager.log"),
        ):
            _cs, _ttyd, extra = await SandboxManager._resolve_and_setup_tunnels(
                sandbox,
                "sb-1",
                False,
                False,
                [3000],
                code_server_port=CODE_SERVER_PORT,
                ttyd_proxy_port=TTYD_PROXY_PORT,
            )

        assert extra == {3000: "https://tunnel-3000.example.com"}


class TestExpectedTunnelPortsEnvVar:
    """create_sandbox / restore_from_snapshot set EXPECTED_TUNNEL_PORTS env var."""

    @pytest.mark.asyncio
    async def test_create_sandbox_sets_env_var_when_tunnel_ports_configured(self, monkeypatch):
        captured: dict[str, dict[str, str]] = {}

        async def fake_create_aio(*args, **kwargs):
            captured["env"] = kwargs.get("env") or {}

            class FakeSandbox:
                object_id = "obj-1"
                stdout = None

            return FakeSandbox()

        fake_create_aio.aio = fake_create_aio
        monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", fake_create_aio)
        monkeypatch.setattr(
            SandboxManager,
            "_resolve_and_setup_tunnels",
            AsyncMock(return_value=(None, None, None)),
        )

        manager = SandboxManager()
        await manager.create_sandbox(
            SandboxConfig(
                repo_owner="acme",
                repo_name="repo",
                settings={"tunnelPorts": [3000, 5173]},
            )
        )

        assert captured["env"][EXPECTED_TUNNEL_PORTS_ENV_VAR] == "3000,5173"

    @pytest.mark.asyncio
    async def test_create_sandbox_omits_env_var_when_no_tunnel_ports(self, monkeypatch):
        captured: dict[str, dict[str, str]] = {}

        async def fake_create_aio(*args, **kwargs):
            captured["env"] = kwargs.get("env") or {}

            class FakeSandbox:
                object_id = "obj-1"
                stdout = None

            return FakeSandbox()

        fake_create_aio.aio = fake_create_aio
        monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", fake_create_aio)
        monkeypatch.setattr(
            SandboxManager,
            "_resolve_and_setup_tunnels",
            AsyncMock(return_value=(None, None, None)),
        )

        manager = SandboxManager()
        await manager.create_sandbox(SandboxConfig(repo_owner="acme", repo_name="repo"))

        assert EXPECTED_TUNNEL_PORTS_ENV_VAR not in captured["env"]

    @pytest.mark.asyncio
    async def test_restore_from_snapshot_sets_env_var_when_tunnel_ports_configured(
        self, monkeypatch
    ):
        captured: dict[str, dict[str, str]] = {}

        class FakeImage:
            object_id = "img-1"

        async def fake_create_aio(*args, **kwargs):
            captured["env"] = kwargs.get("env") or {}

            class FakeSandbox:
                object_id = "obj-1"
                stdout = None

            return FakeSandbox()

        fake_create_aio.aio = fake_create_aio
        monkeypatch.setattr(
            "src.sandbox.manager.modal.Image.from_id", lambda *_a, **_kw: FakeImage()
        )
        monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", fake_create_aio)
        monkeypatch.setattr(
            SandboxManager,
            "_resolve_and_setup_tunnels",
            AsyncMock(return_value=(None, None, None)),
        )

        manager = SandboxManager()
        await manager.restore_from_snapshot(
            snapshot_image_id="img-abc",
            session_config={"repo_owner": "acme", "repo_name": "repo"},
            settings={"tunnelPorts": [3000]},
        )

        assert captured["env"][EXPECTED_TUNNEL_PORTS_ENV_VAR] == "3000"


class TestCollectExposedPorts:
    """SandboxManager._collect_exposed_ports tests."""

    def test_no_ports_when_no_settings(self):
        exposed, tunnel = SandboxManager._collect_exposed_ports(
            False, False, None, CODE_SERVER_PORT, TTYD_PROXY_PORT
        )
        assert exposed == []
        assert tunnel == []

    def test_code_server_only(self):
        exposed, tunnel = SandboxManager._collect_exposed_ports(
            True, False, None, CODE_SERVER_PORT, TTYD_PROXY_PORT
        )
        assert exposed == [CODE_SERVER_PORT]
        assert tunnel == []

    def test_tunnel_ports_only(self):
        exposed, tunnel = SandboxManager._collect_exposed_ports(
            False, False, {"tunnelPorts": [3000, 5173]}, CODE_SERVER_PORT, TTYD_PROXY_PORT
        )
        assert exposed == [3000, 5173]
        assert tunnel == [3000, 5173]

    def test_combined_code_server_and_tunnels(self):
        exposed, tunnel = SandboxManager._collect_exposed_ports(
            True, False, {"tunnelPorts": [3000]}, CODE_SERVER_PORT, TTYD_PROXY_PORT
        )
        assert exposed == [CODE_SERVER_PORT, 3000]
        assert tunnel == [3000]

    def test_terminal_only(self):
        exposed, tunnel = SandboxManager._collect_exposed_ports(
            False, True, None, CODE_SERVER_PORT, TTYD_PROXY_PORT
        )
        assert exposed == [TTYD_PROXY_PORT]
        assert tunnel == []

    def test_deduplicates_ttyd_port_from_tunnels(self):
        exposed, tunnel = SandboxManager._collect_exposed_ports(
            False, True, {"tunnelPorts": [TTYD_PROXY_PORT, 3000]}, CODE_SERVER_PORT, TTYD_PROXY_PORT
        )
        assert exposed == [TTYD_PROXY_PORT, 3000]
        assert tunnel == [3000]

    def test_deduplicates_code_server_port_from_tunnels(self):
        exposed, tunnel = SandboxManager._collect_exposed_ports(
            True,
            False,
            {"tunnelPorts": [CODE_SERVER_PORT, 3000]},
            CODE_SERVER_PORT,
            TTYD_PROXY_PORT,
        )
        assert exposed == [CODE_SERVER_PORT, 3000]
        assert tunnel == [3000]

    def test_custom_code_server_port_frees_default_for_tunnel(self):
        # code-server moved to 8081 → the default 8080 is free as a user tunnel.
        exposed, tunnel = SandboxManager._collect_exposed_ports(
            True, False, {"tunnelPorts": [CODE_SERVER_PORT]}, 8081, TTYD_PROXY_PORT
        )
        assert exposed == [8081, CODE_SERVER_PORT]
        assert tunnel == [CODE_SERVER_PORT]

    def test_custom_terminal_port_frees_default_for_tunnel(self):
        exposed, tunnel = SandboxManager._collect_exposed_ports(
            False, True, {"tunnelPorts": [TTYD_PROXY_PORT, 3000]}, CODE_SERVER_PORT, 7000
        )
        assert exposed == [7000, TTYD_PROXY_PORT, 3000]
        assert tunnel == [TTYD_PROXY_PORT, 3000]


class TestValidatePorts:
    """SandboxManager._validate_ports tests."""

    def test_accepts_valid_ports(self):
        assert SandboxManager._validate_ports([80, 3000, 65535]) == [80, 3000, 65535]

    def test_rejects_out_of_range(self):
        assert SandboxManager._validate_ports([0, -1, 65536, 3000]) == [3000]

    def test_rejects_non_integers(self):
        assert SandboxManager._validate_ports(["3000", 3.5, None, 8080]) == [8080]

    def test_caps_at_ten(self):
        ports = list(range(1, 20))
        assert len(SandboxManager._validate_ports(ports)) == 10

    def test_empty_list(self):
        assert SandboxManager._validate_ports([]) == []


def _patch_sandbox_create(monkeypatch, captured: dict) -> None:
    """Stub modal.Sandbox.create + tunnel resolution; capture the env passed to create."""

    async def fake_create_aio(*args, **kwargs):
        captured["env"] = kwargs.get("env") or {}

        class FakeSandbox:
            object_id = "obj-1"
            stdout = None

        return FakeSandbox()

    fake_create_aio.aio = fake_create_aio
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", fake_create_aio)
    monkeypatch.setattr(
        SandboxManager,
        "_resolve_and_setup_tunnels",
        AsyncMock(return_value=(None, None, None)),
    )


class TestResolveServicePorts:
    """SandboxManager._resolve_service_ports tests."""

    def test_defaults_when_unset(self):
        assert SandboxManager._resolve_service_ports(None) == (CODE_SERVER_PORT, TTYD_PROXY_PORT)
        assert SandboxManager._resolve_service_ports({}) == (CODE_SERVER_PORT, TTYD_PROXY_PORT)

    def test_uses_configured_ports(self):
        assert SandboxManager._resolve_service_ports(
            {"codeServerPort": 9000, "terminalPort": 9001}
        ) == (9000, 9001)

    def test_falls_back_on_invalid(self):
        assert SandboxManager._resolve_service_ports(
            {"codeServerPort": 0, "terminalPort": 99999}
        ) == (CODE_SERVER_PORT, TTYD_PROXY_PORT)
        # strings and bools are not valid in-range ints
        assert SandboxManager._resolve_service_ports(
            {"codeServerPort": "8081", "terminalPort": True}
        ) == (CODE_SERVER_PORT, TTYD_PROXY_PORT)


class TestServicePortEnvVars:
    """create_sandbox sets CODE_SERVER_PORT / TTYD_PROXY_PORT env when features are enabled."""

    @pytest.mark.asyncio
    async def test_sets_code_server_port_env_when_enabled(self, monkeypatch):
        captured: dict[str, dict[str, str]] = {}
        _patch_sandbox_create(monkeypatch, captured)

        manager = SandboxManager()
        await manager.create_sandbox(
            SandboxConfig(
                repo_owner="acme",
                repo_name="repo",
                code_server_enabled=True,
                settings={"codeServerPort": 8081},
            )
        )

        assert captured["env"][CODE_SERVER_PORT_ENV_VAR] == "8081"

    @pytest.mark.asyncio
    async def test_omits_code_server_port_env_when_disabled(self, monkeypatch):
        captured: dict[str, dict[str, str]] = {}
        _patch_sandbox_create(monkeypatch, captured)

        manager = SandboxManager()
        await manager.create_sandbox(
            SandboxConfig(
                repo_owner="acme",
                repo_name="repo",
                code_server_enabled=False,
                settings={"codeServerPort": 8081},
            )
        )

        assert CODE_SERVER_PORT_ENV_VAR not in captured["env"]

    @pytest.mark.asyncio
    async def test_sets_terminal_port_env_when_terminal_enabled(self, monkeypatch):
        captured: dict[str, dict[str, str]] = {}
        _patch_sandbox_create(monkeypatch, captured)

        manager = SandboxManager()
        await manager.create_sandbox(
            SandboxConfig(
                repo_owner="acme",
                repo_name="repo",
                settings={"terminalEnabled": True, "terminalPort": 7000},
            )
        )

        assert captured["env"][TTYD_PROXY_PORT_ENV_VAR] == "7000"

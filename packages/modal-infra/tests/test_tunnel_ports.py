"""Tests for tunnel port features in SandboxManager."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.constants import (
    CODE_SERVER_PORT_ENV_VAR,
    EXPECTED_TUNNEL_PORTS_ENV_VAR,
    NOVNC_PORT,
    TTYD_PROXY_PORT,
    TTYD_PROXY_PORT_ENV_VAR,
    TUNNEL_ENV_FILE_PATH,
    TUNNEL_ENV_SANDBOX_ID_KEY,
)
from src.sandbox.manager import CODE_SERVER_PORT, SandboxConfig, SandboxManager
from src.sandbox.tunnels import SandboxTunnels, TunnelUrls


def _mock_sandbox_with_filesystem() -> tuple[MagicMock, AsyncMock]:
    """Return (sandbox, write_text) with sandbox.filesystem.write_text.aio mocked."""
    write_text = AsyncMock()
    sandbox = MagicMock()
    sandbox.filesystem = MagicMock()
    sandbox.filesystem.write_text = MagicMock()
    sandbox.filesystem.write_text.aio = write_text
    return sandbox, write_text


class TestResolveTunnels:
    """SandboxTunnels._resolve_tunnels tests."""

    @pytest.mark.asyncio
    async def test_resolves_all_ports(self):
        tunnel_3000 = MagicMock()
        tunnel_3000.url = "https://tunnel-3000.example.com"
        tunnel_3001 = MagicMock()
        tunnel_3001.url = "https://tunnel-3001.example.com"

        sandbox = MagicMock()
        sandbox.tunnels.return_value = {3000: tunnel_3000, 3001: tunnel_3001}

        result = await SandboxTunnels._resolve_tunnels(sandbox, "sb-1", [3000, 3001])
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

        with patch("src.sandbox.tunnels.asyncio.sleep", new_callable=AsyncMock):
            result = await SandboxTunnels._resolve_tunnels(
                sandbox, "sb-1", [3000, 3001], retries=2, backoff_seconds=0.0
            )
        assert result == {3000: "https://tunnel-3000.example.com"}

    @pytest.mark.asyncio
    async def test_returns_empty_on_exception_after_retries(self):
        sandbox = MagicMock()
        sandbox.tunnels.side_effect = Exception("tunnel unavailable")

        with patch("src.sandbox.tunnels.asyncio.sleep", new_callable=AsyncMock):
            result = await SandboxTunnels._resolve_tunnels(
                sandbox, "sb-1", [3000], retries=3, backoff_seconds=0.0
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

        with patch("src.sandbox.tunnels.asyncio.sleep", new_callable=AsyncMock):
            result = await SandboxTunnels._resolve_tunnels(
                sandbox, "sb-1", [3000, 3001], retries=3, backoff_seconds=0.0
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
        cs_url, vnc_url, ttyd_url, extra = await SandboxTunnels(
            code_server_enabled=False,
            vnc_enabled=False,
            settings={
                "terminalEnabled": False,
                "tunnelPorts": [],
                "codeServerPort": CODE_SERVER_PORT,
                "vncPort": NOVNC_PORT,
                "terminalPort": TTYD_PROXY_PORT,
            },
        ).resolve(sandbox, "sb-1")
        assert cs_url is None
        assert vnc_url is None
        assert ttyd_url is None
        assert extra is None

    @pytest.mark.asyncio
    async def test_resolves_extra_ports(self):
        tunnel_urls = {3000: "https://tunnel-3000.example.com"}

        sandbox, _write_text = _mock_sandbox_with_filesystem()
        with patch.object(
            SandboxTunnels,
            "_resolve_tunnels",
            new_callable=AsyncMock,
            return_value=tunnel_urls,
        ):
            cs_url, vnc_url, ttyd_url, extra = await SandboxTunnels(
                code_server_enabled=False,
                vnc_enabled=False,
                settings={
                    "terminalEnabled": False,
                    "tunnelPorts": [3000],
                    "codeServerPort": CODE_SERVER_PORT,
                    "vncPort": NOVNC_PORT,
                    "terminalPort": TTYD_PROXY_PORT,
                },
            ).resolve(sandbox, "sb-1")

        assert cs_url is None
        assert vnc_url is None
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
            SandboxTunnels,
            "_resolve_tunnels",
            new_callable=AsyncMock,
            return_value=resolved,
        ):
            cs_url, vnc_url, ttyd_url, extra = await SandboxTunnels(
                code_server_enabled=True,
                vnc_enabled=False,
                settings={
                    "terminalEnabled": False,
                    "tunnelPorts": [3000],
                    "codeServerPort": CODE_SERVER_PORT,
                    "vncPort": NOVNC_PORT,
                    "terminalPort": TTYD_PROXY_PORT,
                },
            ).resolve(sandbox, "sb-1")

        assert cs_url == "https://cs.example.com"
        assert vnc_url is None
        assert ttyd_url is None
        assert extra == {3000: "https://tunnel-3000.example.com"}

    @pytest.mark.asyncio
    async def test_keeps_code_server_port_tunnel_when_code_server_disabled(self):
        """Regression: a user's own 8080 tunnel is kept, not misrouted to code_server_url."""
        resolved = {CODE_SERVER_PORT: "https://my-app.example.com"}
        sandbox, _write_text = _mock_sandbox_with_filesystem()

        with patch.object(
            SandboxTunnels,
            "_resolve_tunnels",
            new_callable=AsyncMock,
            return_value=resolved,
        ):
            cs_url, vnc_url, ttyd_url, extra = await SandboxTunnels(
                code_server_enabled=False,
                vnc_enabled=False,
                settings={
                    "terminalEnabled": False,
                    "tunnelPorts": [CODE_SERVER_PORT],
                    "codeServerPort": CODE_SERVER_PORT,
                    "vncPort": NOVNC_PORT,
                    "terminalPort": TTYD_PROXY_PORT,
                },
            ).resolve(sandbox, "sb-1")

        assert cs_url is None
        assert vnc_url is None
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
            SandboxTunnels,
            "_resolve_tunnels",
            new_callable=AsyncMock,
            return_value=resolved,
        ):
            cs_url, _vnc_url, _ttyd_url, extra = await SandboxTunnels(
                code_server_enabled=True,
                vnc_enabled=False,
                settings={
                    "terminalEnabled": False,
                    "tunnelPorts": [CODE_SERVER_PORT],
                    "codeServerPort": 8081,
                    "vncPort": NOVNC_PORT,
                    "terminalPort": TTYD_PROXY_PORT,
                },
            ).resolve(sandbox, "sb-1")

        assert cs_url == "https://cs.example.com"
        assert extra == {CODE_SERVER_PORT: "https://my-app.example.com"}


class TestWriteTunnelEnvFile:
    """SandboxTunnels._write_tunnel_env_file tests."""

    @pytest.mark.asyncio
    async def test_writes_dotenv_format_to_expected_path(self):
        sandbox, write_text = _mock_sandbox_with_filesystem()

        await SandboxTunnels._write_tunnel_env_file(
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

        with patch("src.sandbox.tunnels.log") as mock_log:
            await SandboxTunnels._write_tunnel_env_file(
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
            SandboxTunnels,
            "_resolve_tunnels",
            new_callable=AsyncMock,
            return_value=tunnel_urls,
        ):
            await SandboxTunnels(
                code_server_enabled=False,
                vnc_enabled=False,
                settings={
                    "terminalEnabled": False,
                    "tunnelPorts": [3000],
                    "codeServerPort": CODE_SERVER_PORT,
                    "vncPort": NOVNC_PORT,
                    "terminalPort": TTYD_PROXY_PORT,
                },
            ).resolve(sandbox, "sb-1")

        write_text.assert_awaited_once()
        written = write_text.call_args[0][0]
        assert written.startswith(f"{TUNNEL_ENV_SANDBOX_ID_KEY}=sb-1\n")
        assert "TUNNEL_3000=https://tunnel-3000.example.com" in written

    @pytest.mark.asyncio
    async def test_does_not_write_file_when_no_extra_urls(self):
        sandbox, write_text = _mock_sandbox_with_filesystem()

        with patch.object(
            SandboxTunnels,
            "_resolve_tunnels",
            new_callable=AsyncMock,
            return_value={},
        ):
            _cs, _vnc, _ttyd, extra = await SandboxTunnels(
                code_server_enabled=False,
                vnc_enabled=False,
                settings={
                    "terminalEnabled": False,
                    "tunnelPorts": [3000],
                    "codeServerPort": CODE_SERVER_PORT,
                    "vncPort": NOVNC_PORT,
                    "terminalPort": TTYD_PROXY_PORT,
                },
            ).resolve(sandbox, "sb-1")

        assert extra is None
        write_text.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_does_not_write_file_for_only_reserved_ports(self):
        """code-server / ttyd URLs aren't extras; no file is written when those are the only ones."""
        sandbox, write_text = _mock_sandbox_with_filesystem()

        with patch.object(
            SandboxTunnels,
            "_resolve_tunnels",
            new_callable=AsyncMock,
            return_value={CODE_SERVER_PORT: "https://cs.example.com"},
        ):
            await SandboxTunnels(
                code_server_enabled=True,
                vnc_enabled=False,
                settings={
                    "terminalEnabled": False,
                    "tunnelPorts": [],
                    "codeServerPort": CODE_SERVER_PORT,
                    "vncPort": NOVNC_PORT,
                    "terminalPort": TTYD_PROXY_PORT,
                },
            ).resolve(sandbox, "sb-1")

        write_text.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_write_failure_does_not_block_return(self):
        sandbox, write_text = _mock_sandbox_with_filesystem()
        write_text.side_effect = Exception("boom")

        with (
            patch.object(
                SandboxTunnels,
                "_resolve_tunnels",
                new_callable=AsyncMock,
                return_value={3000: "https://tunnel-3000.example.com"},
            ),
            patch("src.sandbox.tunnels.log"),
        ):
            _cs, _vnc, _ttyd, extra = await SandboxTunnels(
                code_server_enabled=False,
                vnc_enabled=False,
                settings={
                    "terminalEnabled": False,
                    "tunnelPorts": [3000],
                    "codeServerPort": CODE_SERVER_PORT,
                    "vncPort": NOVNC_PORT,
                    "terminalPort": TTYD_PROXY_PORT,
                },
            ).resolve(sandbox, "sb-1")

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
        monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", fake_create_aio)
        monkeypatch.setattr(
            SandboxTunnels,
            "resolve",
            AsyncMock(return_value=TunnelUrls(None, None, None, None)),
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
        monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", fake_create_aio)
        monkeypatch.setattr(
            SandboxTunnels,
            "resolve",
            AsyncMock(return_value=TunnelUrls(None, None, None, None)),
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
            "src.sandbox.launch.modal.Image.from_id", lambda *_a, **_kw: FakeImage()
        )
        monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", fake_create_aio)
        monkeypatch.setattr(
            SandboxTunnels,
            "resolve",
            AsyncMock(return_value=TunnelUrls(None, None, None, None)),
        )

        manager = SandboxManager()
        await manager.restore_from_snapshot(
            snapshot_image_id="img-abc",
            session_config={"repo_owner": "acme", "repo_name": "repo"},
            settings={"tunnelPorts": [3000]},
        )

        assert captured["env"][EXPECTED_TUNNEL_PORTS_ENV_VAR] == "3000"


@pytest.mark.parametrize(
    "code_server, settings, exposed, expected_extras",
    [
        (False, None, [], None),
        (True, None, [CODE_SERVER_PORT], None),
        (False, {"tunnelPorts": [3000, 5173]}, [3000, 5173], "3000,5173"),
        (True, {"tunnelPorts": [3000]}, [CODE_SERVER_PORT, 3000], "3000"),
        (False, {"terminalEnabled": True}, [TTYD_PROXY_PORT], None),
        (
            False,
            {"terminalEnabled": True, "tunnelPorts": [TTYD_PROXY_PORT, 3000]},
            [TTYD_PROXY_PORT, 3000],
            "3000",
        ),
        (True, {"tunnelPorts": [CODE_SERVER_PORT, 3000]}, [CODE_SERVER_PORT, 3000], "3000"),
        (
            True,
            {"codeServerPort": 8081, "tunnelPorts": [CODE_SERVER_PORT]},
            [8081, CODE_SERVER_PORT],
            str(CODE_SERVER_PORT),
        ),
        (
            False,
            {"terminalEnabled": True, "terminalPort": 7000, "tunnelPorts": [TTYD_PROXY_PORT, 3000]},
            [7000, TTYD_PROXY_PORT, 3000],
            f"{TTYD_PROXY_PORT},3000",
        ),
    ],
)
def test_exposed_ports_and_runtime_expectations_agree(
    code_server, settings, exposed, expected_extras
):
    tunnels = SandboxTunnels(code_server_enabled=code_server, settings=settings)
    assert tunnels.exposed_ports == exposed
    assert tunnels.environment.get(EXPECTED_TUNNEL_PORTS_ENV_VAR) == expected_extras


class TestValidatePorts:
    """SandboxTunnels._validate_ports tests."""

    def test_accepts_valid_ports(self):
        assert SandboxTunnels._validate_ports([80, 3000, 65535]) == [80, 3000, 65535]

    def test_rejects_out_of_range(self):
        assert SandboxTunnels._validate_ports([0, -1, 65536, 3000]) == [3000]

    def test_rejects_non_integers(self):
        assert SandboxTunnels._validate_ports(["3000", 3.5, None, 8080]) == [8080]

    def test_caps_at_ten(self):
        ports = list(range(1, 20))
        assert len(SandboxTunnels._validate_ports(ports)) == 10

    def test_empty_list(self):
        assert SandboxTunnels._validate_ports([]) == []


def _patch_sandbox_create(monkeypatch, captured: dict) -> None:
    """Stub modal.Sandbox.create + tunnel resolution; capture the env passed to create."""

    async def fake_create_aio(*args, **kwargs):
        captured["env"] = kwargs.get("env") or {}

        class FakeSandbox:
            object_id = "obj-1"
            stdout = None

        return FakeSandbox()

    fake_create_aio.aio = fake_create_aio
    monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", fake_create_aio)
    monkeypatch.setattr(
        SandboxTunnels,
        "resolve",
        AsyncMock(return_value=TunnelUrls(None, None, None, None)),
    )


class TestResolveServicePorts:
    """SandboxTunnels._resolve_service_ports tests."""

    def test_defaults_when_unset(self):
        assert SandboxTunnels._resolve_service_ports(None) == (
            CODE_SERVER_PORT,
            NOVNC_PORT,
            TTYD_PROXY_PORT,
        )
        assert SandboxTunnels._resolve_service_ports({}) == (
            CODE_SERVER_PORT,
            NOVNC_PORT,
            TTYD_PROXY_PORT,
        )

    def test_uses_configured_ports(self):
        assert SandboxTunnels._resolve_service_ports(
            {"codeServerPort": 9000, "vncPort": 9001, "terminalPort": 9002}
        ) == (9000, 9001, 9002)

    def test_falls_back_on_invalid(self):
        assert SandboxTunnels._resolve_service_ports(
            {"codeServerPort": 0, "vncPort": -1, "terminalPort": 99999}
        ) == (CODE_SERVER_PORT, NOVNC_PORT, TTYD_PROXY_PORT)
        # strings and bools are not valid in-range ints
        assert SandboxTunnels._resolve_service_ports(
            {"codeServerPort": "8081", "vncPort": False, "terminalPort": True}
        ) == (CODE_SERVER_PORT, NOVNC_PORT, TTYD_PROXY_PORT)


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

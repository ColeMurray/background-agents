"""Tests for tunnel port features in SandboxManager."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.constants import TTYD_PROXY_PORT
from src.sandbox.manager import CODE_SERVER_PORT, TUNNEL_ENV_FILE_PATH, SandboxManager


def _mock_sandbox_with_open() -> tuple[MagicMock, AsyncMock]:
    """Return (sandbox, file_handle) with sandbox.open.aio returning the handle."""
    f = AsyncMock()
    sandbox = MagicMock()
    sandbox.open = MagicMock()
    sandbox.open.aio = AsyncMock(return_value=f)
    return sandbox, f


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
            sandbox, "sb-1", False, False, []
        )
        assert cs_url is None
        assert ttyd_url is None
        assert extra is None

    @pytest.mark.asyncio
    async def test_resolves_extra_ports(self):
        tunnel_urls = {3000: "https://tunnel-3000.example.com"}

        sandbox, _f = _mock_sandbox_with_open()
        with patch.object(
            SandboxManager,
            "_resolve_tunnels",
            new_callable=AsyncMock,
            return_value=tunnel_urls,
        ):
            cs_url, ttyd_url, extra = await SandboxManager._resolve_and_setup_tunnels(
                sandbox, "sb-1", False, False, [3000]
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

        sandbox, _f = _mock_sandbox_with_open()

        with patch.object(
            SandboxManager,
            "_resolve_tunnels",
            new_callable=AsyncMock,
            return_value=resolved,
        ):
            cs_url, ttyd_url, extra = await SandboxManager._resolve_and_setup_tunnels(
                sandbox, "sb-1", True, False, [3000]
            )

        assert cs_url == "https://cs.example.com"
        assert ttyd_url is None
        assert extra == {3000: "https://tunnel-3000.example.com"}


class TestWriteTunnelEnvFile:
    """SandboxManager._write_tunnel_env_file tests."""

    @pytest.mark.asyncio
    async def test_writes_dotenv_format_to_expected_path(self):
        sandbox, f = _mock_sandbox_with_open()

        await SandboxManager._write_tunnel_env_file(
            sandbox,
            "sb-1",
            {
                3001: "https://tunnel-3001.example.com",
                3000: "https://tunnel-3000.example.com",
            },
        )

        sandbox.open.aio.assert_awaited_once_with(TUNNEL_ENV_FILE_PATH, "w")
        f.write.aio.assert_awaited_once()
        written = f.write.aio.call_args[0][0]
        # Sorted by port, dotenv format, trailing newline.
        assert written == (
            "TUNNEL_3000=https://tunnel-3000.example.com\n"
            "TUNNEL_3001=https://tunnel-3001.example.com\n"
        )
        f.close.aio.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_closes_file_when_write_raises(self):
        sandbox, f = _mock_sandbox_with_open()
        f.write.aio = AsyncMock(side_effect=Exception("write failed"))

        with patch("src.sandbox.manager.log") as mock_log:
            await SandboxManager._write_tunnel_env_file(
                sandbox, "sb-1", {3000: "https://tunnel-3000.example.com"}
            )

        f.close.aio.assert_awaited_once()
        mock_log.warn.assert_called_once()
        assert mock_log.warn.call_args[0][0] == "tunnel.urls_write_failed"

    @pytest.mark.asyncio
    async def test_open_failure_does_not_raise(self):
        sandbox = MagicMock()
        sandbox.open = MagicMock()
        sandbox.open.aio = AsyncMock(side_effect=Exception("open failed"))

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
        sandbox, f = _mock_sandbox_with_open()
        tunnel_urls = {3000: "https://tunnel-3000.example.com"}

        with patch.object(
            SandboxManager,
            "_resolve_tunnels",
            new_callable=AsyncMock,
            return_value=tunnel_urls,
        ):
            await SandboxManager._resolve_and_setup_tunnels(sandbox, "sb-1", False, False, [3000])

        sandbox.open.aio.assert_awaited_once_with(TUNNEL_ENV_FILE_PATH, "w")
        written = f.write.aio.call_args[0][0]
        assert "TUNNEL_3000=https://tunnel-3000.example.com" in written

    @pytest.mark.asyncio
    async def test_does_not_write_file_when_no_extra_urls(self):
        sandbox, _f = _mock_sandbox_with_open()

        with patch.object(
            SandboxManager,
            "_resolve_tunnels",
            new_callable=AsyncMock,
            return_value={},
        ):
            _cs, _ttyd, extra = await SandboxManager._resolve_and_setup_tunnels(
                sandbox, "sb-1", False, False, [3000]
            )

        assert extra is None
        sandbox.open.aio.assert_not_called()

    @pytest.mark.asyncio
    async def test_does_not_write_file_for_only_reserved_ports(self):
        """code-server / ttyd URLs aren't extras; no file is written when those are the only ones."""
        sandbox, _f = _mock_sandbox_with_open()

        with patch.object(
            SandboxManager,
            "_resolve_tunnels",
            new_callable=AsyncMock,
            return_value={CODE_SERVER_PORT: "https://cs.example.com"},
        ):
            await SandboxManager._resolve_and_setup_tunnels(sandbox, "sb-1", True, False, [])

        sandbox.open.aio.assert_not_called()

    @pytest.mark.asyncio
    async def test_write_failure_does_not_block_return(self):
        sandbox = MagicMock()
        sandbox.open = MagicMock()
        sandbox.open.aio = AsyncMock(side_effect=Exception("boom"))

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
                sandbox, "sb-1", False, False, [3000]
            )

        assert extra == {3000: "https://tunnel-3000.example.com"}


class TestCollectExposedPorts:
    """SandboxManager._collect_exposed_ports tests."""

    def test_no_ports_when_no_settings(self):
        exposed, tunnel = SandboxManager._collect_exposed_ports(False, False, None)
        assert exposed == []
        assert tunnel == []

    def test_code_server_only(self):
        exposed, tunnel = SandboxManager._collect_exposed_ports(True, False, None)
        assert exposed == [CODE_SERVER_PORT]
        assert tunnel == []

    def test_tunnel_ports_only(self):
        exposed, tunnel = SandboxManager._collect_exposed_ports(
            False, False, {"tunnelPorts": [3000, 5173]}
        )
        assert exposed == [3000, 5173]
        assert tunnel == [3000, 5173]

    def test_combined_code_server_and_tunnels(self):
        exposed, tunnel = SandboxManager._collect_exposed_ports(
            True, False, {"tunnelPorts": [3000]}
        )
        assert exposed == [CODE_SERVER_PORT, 3000]
        assert tunnel == [3000]

    def test_terminal_only(self):
        exposed, tunnel = SandboxManager._collect_exposed_ports(False, True, None)
        assert exposed == [TTYD_PROXY_PORT]
        assert tunnel == []

    def test_deduplicates_ttyd_port_from_tunnels(self):
        exposed, tunnel = SandboxManager._collect_exposed_ports(
            False, True, {"tunnelPorts": [TTYD_PROXY_PORT, 3000]}
        )
        assert exposed == [TTYD_PROXY_PORT, 3000]
        assert tunnel == [3000]

    def test_deduplicates_code_server_port_from_tunnels(self):
        exposed, tunnel = SandboxManager._collect_exposed_ports(
            True, False, {"tunnelPorts": [CODE_SERVER_PORT, 3000]}
        )
        assert exposed == [CODE_SERVER_PORT, 3000]
        assert tunnel == [3000]


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

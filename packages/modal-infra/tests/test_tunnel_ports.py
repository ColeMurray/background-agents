"""Tests for tunnel port features in SandboxManager."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.sandbox.manager import CODE_SERVER_PORT, SandboxManager


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
    async def test_returns_none_none_for_no_ports(self):
        sandbox = MagicMock()
        cs_url, extra = await SandboxManager._resolve_and_setup_tunnels(
            sandbox, "sb-1", False, []
        )
        assert cs_url is None
        assert extra is None

    @pytest.mark.asyncio
    async def test_resolves_extra_ports(self):
        tunnel_urls = {3000: "https://tunnel-3000.example.com"}

        sandbox = MagicMock()
        with patch.object(
            SandboxManager,
            "_resolve_tunnels",
            new_callable=AsyncMock,
            return_value=tunnel_urls,
        ):
            cs_url, extra = await SandboxManager._resolve_and_setup_tunnels(
                sandbox, "sb-1", False, [3000]
            )

        assert cs_url is None
        assert extra == {3000: "https://tunnel-3000.example.com"}

    @pytest.mark.asyncio
    async def test_splits_code_server_from_extra_ports(self):
        resolved = {CODE_SERVER_PORT: "https://cs.example.com", 3000: "https://tunnel-3000.example.com"}

        sandbox = MagicMock()

        with patch.object(
            SandboxManager,
            "_resolve_tunnels",
            new_callable=AsyncMock,
            return_value=resolved,
        ):
            cs_url, extra = await SandboxManager._resolve_and_setup_tunnels(
                sandbox, "sb-1", True, [3000]
            )

        assert cs_url == "https://cs.example.com"
        assert extra == {3000: "https://tunnel-3000.example.com"}


class TestCollectExposedPorts:
    """SandboxManager._collect_exposed_ports tests."""

    def test_no_ports_when_no_settings(self):
        exposed, tunnel = SandboxManager._collect_exposed_ports(False, None)
        assert exposed == []
        assert tunnel == []

    def test_code_server_only(self):
        exposed, tunnel = SandboxManager._collect_exposed_ports(True, None)
        assert exposed == [CODE_SERVER_PORT]
        assert tunnel == []

    def test_tunnel_ports_only(self):
        exposed, tunnel = SandboxManager._collect_exposed_ports(
            False, {"tunnelPorts": [3000, 5173]}
        )
        assert exposed == [3000, 5173]
        assert tunnel == [3000, 5173]

    def test_combined_code_server_and_tunnels(self):
        exposed, tunnel = SandboxManager._collect_exposed_ports(
            True, {"tunnelPorts": [3000]}
        )
        assert exposed == [CODE_SERVER_PORT, 3000]
        assert tunnel == [3000]

"""Tests for configurable code-server / ttyd ports in the sandbox runtime."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.constants import CODE_SERVER_PORT, TTYD_PORT
from sandbox_runtime.entrypoint import SandboxSupervisor, _port_from_env


class TestPortFromEnv:
    def test_returns_default_when_unset(self):
        with patch.dict("os.environ", {}, clear=True):
            assert _port_from_env("X_TEST_PORT", 1234) == 1234

    def test_reads_override(self):
        with patch.dict("os.environ", {"X_TEST_PORT": "4321"}, clear=True):
            assert _port_from_env("X_TEST_PORT", 1234) == 4321

    def test_falls_back_on_non_numeric(self):
        with patch.dict("os.environ", {"X_TEST_PORT": "abc"}, clear=True):
            assert _port_from_env("X_TEST_PORT", 1234) == 1234

    def test_falls_back_on_out_of_range(self):
        with patch.dict("os.environ", {"X_TEST_PORT": "99999"}, clear=True):
            assert _port_from_env("X_TEST_PORT", 1234) == 1234


def _make_supervisor() -> SandboxSupervisor:
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


class TestStartCodeServerPort:
    @pytest.mark.asyncio
    async def test_binds_to_env_port(self):
        sup = _make_supervisor()
        sup._forward_code_server_logs = AsyncMock()
        proc = MagicMock()
        proc.stdout = None
        with (
            patch.dict(
                "os.environ",
                {"CODE_SERVER_PASSWORD": "pw", "CODE_SERVER_PORT": "9999"},
                clear=True,
            ),
            patch(
                "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
                new_callable=AsyncMock,
                return_value=proc,
            ) as mock_exec,
        ):
            await sup.start_code_server()

        assert "0.0.0.0:9999" in mock_exec.call_args[0]

    @pytest.mark.asyncio
    async def test_binds_to_default_when_unset(self):
        sup = _make_supervisor()
        sup._forward_code_server_logs = AsyncMock()
        proc = MagicMock()
        proc.stdout = None
        with (
            patch.dict("os.environ", {"CODE_SERVER_PASSWORD": "pw"}, clear=True),
            patch(
                "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
                new_callable=AsyncMock,
                return_value=proc,
            ) as mock_exec,
        ):
            await sup.start_code_server()

        assert f"0.0.0.0:{CODE_SERVER_PORT}" in mock_exec.call_args[0]


class TestStartTtydPort:
    @pytest.mark.asyncio
    async def test_binds_internal_ttyd_to_default(self):
        sup = _make_supervisor()
        sup._forward_ttyd_logs = AsyncMock()
        proc = MagicMock()
        proc.stdout = None
        with (
            patch.dict("os.environ", {"TERMINAL_ENABLED": "true"}, clear=True),
            patch(
                "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
                new_callable=AsyncMock,
                return_value=proc,
            ) as mock_exec,
        ):
            await sup.start_ttyd()

        assert str(TTYD_PORT) in mock_exec.call_args[0]

    @pytest.mark.asyncio
    async def test_ignores_ttyd_port_env_override(self):
        """The internal ttyd port is fixed — a TTYD_PORT env var must not move it."""
        sup = _make_supervisor()
        sup._forward_ttyd_logs = AsyncMock()
        proc = MagicMock()
        proc.stdout = None
        with (
            patch.dict(
                "os.environ",
                {"TERMINAL_ENABLED": "true", "TTYD_PORT": "9999"},
                clear=True,
            ),
            patch(
                "sandbox_runtime.entrypoint.asyncio.create_subprocess_exec",
                new_callable=AsyncMock,
                return_value=proc,
            ) as mock_exec,
        ):
            await sup.start_ttyd()

        assert str(TTYD_PORT) in mock_exec.call_args[0]
        assert "9999" not in mock_exec.call_args[0]

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from sandbox_runtime.code_server import CodeServer
from sandbox_runtime.constants import CODE_SERVER_PORT, TTYD_PORT
from sandbox_runtime.log_config import get_logger
from sandbox_runtime.service_ports import port_from_env
from sandbox_runtime.web_terminal import WebTerminal


class TestPortFromEnv:
    def test_returns_default_when_unset(self):
        with patch.dict("os.environ", {}, clear=True):
            assert port_from_env("X_TEST_PORT", 1234) == 1234

    def test_reads_override(self):
        with patch.dict("os.environ", {"X_TEST_PORT": "4321"}, clear=True):
            assert port_from_env("X_TEST_PORT", 1234) == 4321

    def test_falls_back_on_invalid_values(self):
        with patch.dict("os.environ", {"X_TEST_PORT": "99999"}, clear=True):
            assert port_from_env("X_TEST_PORT", 1234) == 1234
        with patch.dict("os.environ", {"X_TEST_PORT": "not-a-port"}, clear=True):
            assert port_from_env("X_TEST_PORT", 1234) == 1234


class TestCodeServerPort:
    async def test_binds_to_env_port(self):
        server = CodeServer(get_logger("test"))
        process = MagicMock(stdout=None)
        with (
            patch.dict(
                "os.environ", {"CODE_SERVER_PASSWORD": "pw", "CODE_SERVER_PORT": "9999"}, clear=True
            ),
            patch(
                "sandbox_runtime.code_server.asyncio.create_subprocess_exec",
                new_callable=AsyncMock,
                return_value=process,
            ) as execute,
        ):
            await server.start(Path("/workspace"))
        assert "0.0.0.0:9999" in execute.call_args.args

    async def test_binds_to_default_when_unset(self):
        server = CodeServer(get_logger("test"))
        process = MagicMock(stdout=None)
        with (
            patch.dict("os.environ", {"CODE_SERVER_PASSWORD": "pw"}, clear=True),
            patch(
                "sandbox_runtime.code_server.asyncio.create_subprocess_exec",
                new_callable=AsyncMock,
                return_value=process,
            ) as execute,
        ):
            await server.start(Path("/workspace"))
        assert f"0.0.0.0:{CODE_SERVER_PORT}" in execute.call_args.args


class TestWebTerminalPort:
    async def test_internal_ttyd_port_is_fixed(self):
        terminal = WebTerminal(get_logger("test"))
        terminal._wait_for_ttyd = AsyncMock(return_value=True)
        processes = [MagicMock(stdout=None, pid=1), MagicMock(stdout=None, pid=2)]
        with (
            patch.dict("os.environ", {"TERMINAL_ENABLED": "true", "TTYD_PORT": "9999"}, clear=True),
            patch(
                "sandbox_runtime.web_terminal.asyncio.create_subprocess_exec",
                new_callable=AsyncMock,
                side_effect=processes,
            ) as execute,
        ):
            await terminal.start(Path("/workspace"))
        assert str(TTYD_PORT) in execute.call_args_list[0].args
        assert "9999" not in execute.call_args_list[0].args

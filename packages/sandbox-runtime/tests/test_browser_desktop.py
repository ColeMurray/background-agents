"""Focused tests for the optional browser desktop stack."""

import asyncio
import os
import stat
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.browser_desktop import BrowserDesktop
from sandbox_runtime.constants import NOVNC_PORT, VNC_DISPLAY, VNC_PORT
from sandbox_runtime.entrypoint import build_supervisor
from tests.runtime_helpers import make_browser_desktop, make_supervisor

_ORIGINAL_ASYNCIO_SLEEP = asyncio.sleep


def _make_browser_desktop(vnc_password: str | None = None) -> BrowserDesktop:
    return make_browser_desktop(vnc_password)


def _make_lifecycle_supervisor():
    return make_supervisor(
        {
            "SANDBOX_ID": "test-sandbox",
            "CONTROL_PLANE_URL": "",
            "REPO_OWNER": "acme",
            "REPO_NAME": "app",
        }
    )


def _process(returncode=None) -> MagicMock:
    process = MagicMock()
    process.returncode = returncode
    process.stdout = None
    process.wait = AsyncMock()
    return process


async def _yielding_sleep(_delay: float) -> None:
    await _ORIGINAL_ASYNCIO_SLEEP(0)


async def _yielding_shutdown_wait(supervisor, _delay: float) -> bool:
    await _ORIGINAL_ASYNCIO_SLEEP(0)
    return supervisor.shutdown_event.is_set()


class TestStartVnc:
    def test_configures_display_for_workload_processes(self):
        with patch.dict(
            os.environ,
            {
                "VNC_PASSWORD": "secret",
                "SANDBOX_ID": "test-sandbox",
                "CONTROL_PLANE_URL": "https://cp.example.com",
                "SANDBOX_AUTH_TOKEN": "tok",
            },
            clear=True,
        ):
            supervisor = build_supervisor(asyncio.Event())
            assert os.environ["DISPLAY"] == VNC_DISPLAY
            assert "VNC_PASSWORD" not in os.environ
            assert supervisor.browser_desktop._password == "secret"
            assert not hasattr(supervisor.config, "vnc_password")

    @pytest.mark.asyncio
    async def test_skips_entire_stack_without_password(self, tmp_path):
        supervisor = _make_browser_desktop()
        password_path = tmp_path / "vnc-password"
        password_path.write_text("stale")
        with (
            patch.dict(os.environ, {}, clear=True),
            patch("sandbox_runtime.browser_desktop.VNC_PASSWORD_FILE_PATH", str(password_path)),
            patch(
                "sandbox_runtime.browser_desktop.asyncio.create_subprocess_exec",
                new_callable=AsyncMock,
            ) as create_process,
        ):
            await supervisor.start()

        create_process.assert_not_called()
        assert not password_path.exists()

    @pytest.mark.asyncio
    @pytest.mark.parametrize(("name", "level"), [("fluxbox", "debug"), ("xvfb", "info")])
    async def test_forwards_fluxbox_logs_at_debug_and_other_desktop_logs_at_info(self, name, level):
        log = MagicMock()
        desktop = BrowserDesktop(log, password="secret")
        process = _process()
        process.stdout = asyncio.StreamReader()
        process.stdout.feed_data(b"child output\n")
        process.stdout.feed_eof()

        await desktop._forward_logs(name, process)

        getattr(log, level).assert_called_once_with(f"{name}.stdout", line="child output")
        getattr(log, "info" if level == "debug" else "debug").assert_not_called()

    @pytest.mark.asyncio
    async def test_starts_dependencies_in_order_with_internal_raw_vnc(self, tmp_path):
        supervisor = _make_browser_desktop("secret12")
        events: list[str] = []
        processes = [_process() for _ in range(4)]
        process_index = 0

        async def create_process(*args, **kwargs):
            nonlocal process_index
            events.append(args[0])
            process = processes[process_index]
            process_index += 1
            return process

        async def wait_for_path(path, process, timeout_seconds=None):
            events.append("x-ready")
            return True

        async def wait_for_port(port, timeout_seconds=None):
            events.append(f"port-{port}-ready")
            return True

        password_path = tmp_path / "vnc-password"
        with (
            patch.dict(
                os.environ,
                {"NOVNC_PORT": "6099"},
                clear=True,
            ),
            patch(
                "sandbox_runtime.browser_desktop.VNC_PASSWORD_FILE_PATH",
                str(password_path),
            ),
            patch(
                "sandbox_runtime.browser_desktop.asyncio.create_subprocess_exec",
                side_effect=create_process,
            ) as create_process_mock,
            patch.object(supervisor, "_wait_for_path", side_effect=wait_for_path),
            patch.object(supervisor, "_wait_for_port", side_effect=wait_for_port),
        ):
            await supervisor.start()

        assert events == ["Xvfb", "x-ready", "fluxbox", "x11vnc", "port-5900-ready", "websockify"]
        xvfb_args = create_process_mock.call_args_list[0].args
        fluxbox_call = create_process_mock.call_args_list[1]
        x11vnc_args = create_process_mock.call_args_list[2].args
        novnc_call = create_process_mock.call_args_list[3]
        novnc_args = novnc_call.args

        assert xvfb_args == (
            "Xvfb",
            VNC_DISPLAY,
            "-screen",
            "0",
            "1280x720x24",
            "-nolisten",
            "tcp",
        )
        assert fluxbox_call.args == ("fluxbox",)
        assert fluxbox_call.kwargs["env"]["DISPLAY"] == VNC_DISPLAY
        assert all(
            "VNC_PASSWORD" not in call.kwargs["env"] for call in create_process_mock.call_args_list
        )
        assert x11vnc_args[3:5] == ("-rfbport", str(VNC_PORT))
        assert x11vnc_args[5:7] == ("-listen", "127.0.0.1")
        assert x11vnc_args[-2:] == ("-rfbauth", str(password_path))
        assert "secret12" not in x11vnc_args
        assert "0.0.0.0:6099" in novnc_args
        assert f"127.0.0.1:{VNC_PORT}" in novnc_args
        assert password_path.read_bytes() == bytes.fromhex("24b5ae4ce15503c6")
        assert b"secret12" not in password_path.read_bytes()
        assert stat.S_IMODE(password_path.stat().st_mode) == 0o600

    @pytest.mark.asyncio
    async def test_rejects_passwords_over_eight_bytes(self, tmp_path):
        supervisor = _make_browser_desktop("ninebytes")
        password_path = tmp_path / "vnc-password"
        with (
            patch.dict(os.environ, {}, clear=True),
            patch("sandbox_runtime.browser_desktop.VNC_PASSWORD_FILE_PATH", str(password_path)),
            patch(
                "sandbox_runtime.browser_desktop.asyncio.create_subprocess_exec",
                new_callable=AsyncMock,
            ) as create_process,
            pytest.raises(ValueError, match="must not exceed 8 bytes"),
        ):
            await supervisor.start()

        create_process.assert_not_called()
        assert not password_path.exists()

    @pytest.mark.asyncio
    async def test_replaces_symlink_without_writing_to_its_target(self, tmp_path):
        supervisor = _make_browser_desktop("secret12")
        password_path = tmp_path / "vnc-password"
        symlink_target = tmp_path / "attacker-target"
        symlink_target.write_text("unchanged")
        password_path.symlink_to(symlink_target)

        with (
            patch.dict(os.environ, {}, clear=True),
            patch("sandbox_runtime.browser_desktop.VNC_PASSWORD_FILE_PATH", str(password_path)),
            patch.object(supervisor, "_clear_display_artifacts"),
            patch(
                "sandbox_runtime.browser_desktop.asyncio.create_subprocess_exec",
                new_callable=AsyncMock,
                side_effect=RuntimeError("stop after password write"),
            ),
            pytest.raises(RuntimeError, match="stop after password write"),
        ):
            await supervisor.start()

        assert symlink_target.read_text() == "unchanged"
        assert not password_path.is_symlink()
        assert stat.S_IMODE(password_path.stat().st_mode) == 0o600

    @pytest.mark.asyncio
    async def test_uses_default_novnc_port(self, tmp_path):
        supervisor = _make_browser_desktop("pw")
        password_path = tmp_path / "vnc-password"
        with (
            patch.dict(os.environ, {}, clear=True),
            patch("sandbox_runtime.browser_desktop.VNC_PASSWORD_FILE_PATH", str(password_path)),
            patch.object(supervisor, "_wait_for_path", new_callable=AsyncMock, return_value=True),
            patch.object(supervisor, "_wait_for_port", new_callable=AsyncMock, return_value=True),
            patch(
                "sandbox_runtime.browser_desktop.asyncio.create_subprocess_exec",
                new_callable=AsyncMock,
                side_effect=[_process() for _ in range(4)],
            ) as create_process,
        ):
            await supervisor.start()

        assert f"0.0.0.0:{NOVNC_PORT}" in create_process.call_args_list[3].args


class TestVncLifecycle:
    @pytest.mark.asyncio
    async def test_run_starts_vnc_before_repository_hooks_without_initial_retries(self):
        supervisor = _make_lifecycle_supervisor()
        events: list[str] = []

        async def start_desktop():
            events.append("vnc")

        async def repository_boot(_boot_mode, _expected_tunnel_ports):
            events.append("repository")
            raise RuntimeError("stop after ordering assertion")

        supervisor.browser_desktop.start = AsyncMock(side_effect=start_desktop)
        supervisor.repository_boot.boot = AsyncMock(side_effect=repository_boot)
        supervisor._start_desktop_with_retries = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()

        with patch.dict(os.environ, {}, clear=True):
            await supervisor.run()

        assert events == ["vnc", "repository"]
        supervisor._start_desktop_with_retries.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_initial_vnc_failure_does_not_retry_or_block_repository_boot(self):
        supervisor = _make_lifecycle_supervisor()
        supervisor.browser_desktop.start = AsyncMock(side_effect=RuntimeError("not ready"))
        supervisor.browser_desktop.stop = AsyncMock()
        supervisor.repository_boot.boot = AsyncMock(side_effect=RuntimeError("stop after boot"))
        supervisor._start_desktop_with_retries = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()

        with patch.dict(os.environ, {}, clear=True):
            await supervisor.run()

        supervisor.browser_desktop.start.assert_awaited_once()
        supervisor.browser_desktop.stop.assert_awaited()
        supervisor.repository_boot.boot.assert_awaited_once()
        supervisor._start_desktop_with_retries.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_initial_start_retries_after_a_transient_failure(self):
        supervisor = _make_lifecycle_supervisor()
        supervisor.browser_desktop.start = AsyncMock(side_effect=[RuntimeError("not ready"), None])
        supervisor.browser_desktop.stop = AsyncMock()

        with patch.object(supervisor, "_wait_for_shutdown", AsyncMock(return_value=False)):
            assert await supervisor._start_desktop_with_retries()

        assert supervisor.browser_desktop.start.await_count == 2
        supervisor.browser_desktop.stop.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_component_crash_restarts_stack_non_fatally(self):
        supervisor = _make_lifecycle_supervisor()
        supervisor.opencode_server._opencode_process = _process()
        supervisor.agent_bridge._process = _process()
        supervisor.browser_desktop._x11vnc_process = _process(returncode=1)
        supervisor.browser_desktop.stop = AsyncMock()

        async def restart():
            supervisor.shutdown_event.set()

        supervisor.browser_desktop.start = AsyncMock(side_effect=restart)
        supervisor._report_fatal_error = AsyncMock()

        async def wait_for_shutdown(delay):
            return await _yielding_shutdown_wait(supervisor, delay)

        with patch.object(
            supervisor,
            "_wait_for_shutdown",
            AsyncMock(side_effect=wait_for_shutdown),
        ):
            await supervisor.monitor_processes()

        supervisor.browser_desktop.stop.assert_awaited_once()
        supervisor.browser_desktop.start.assert_awaited_once()
        supervisor._report_fatal_error.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_component_crash_stops_after_restart_budget(self):
        supervisor = _make_lifecycle_supervisor()
        supervisor.MAX_RESTARTS = 0
        supervisor.opencode_server._opencode_process = _process()
        supervisor.agent_bridge._process = _process()
        supervisor.browser_desktop._x11vnc_process = _process(returncode=1)

        async def stop():
            supervisor.browser_desktop._x11vnc_process = None
            supervisor.shutdown_event.set()

        supervisor.browser_desktop.stop = AsyncMock(side_effect=stop)
        supervisor._start_desktop_with_retries = AsyncMock()
        supervisor._report_fatal_error = AsyncMock()

        async def wait_for_shutdown(delay):
            return await _yielding_shutdown_wait(supervisor, delay)

        with patch.object(
            supervisor,
            "_wait_for_shutdown",
            AsyncMock(side_effect=wait_for_shutdown),
        ):
            await supervisor.monitor_processes()

        supervisor._start_desktop_with_retries.assert_not_awaited()
        supervisor._report_fatal_error.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_retries_after_a_restart_attempt_fails(self):
        supervisor = _make_lifecycle_supervisor()
        supervisor.opencode_server._opencode_process = _process()
        supervisor.agent_bridge._process = _process()
        supervisor.browser_desktop._x11vnc_process = _process(returncode=1)
        supervisor.browser_desktop.stop = AsyncMock()

        async def restart():
            if supervisor.browser_desktop.start.await_count == 1:
                raise RuntimeError("not ready")
            supervisor.shutdown_event.set()

        supervisor.browser_desktop.start = AsyncMock(side_effect=restart)
        supervisor._report_fatal_error = AsyncMock()

        async def wait_for_shutdown(delay):
            return await _yielding_shutdown_wait(supervisor, delay)

        with patch.object(
            supervisor,
            "_wait_for_shutdown",
            AsyncMock(side_effect=wait_for_shutdown),
        ):
            await supervisor.monitor_processes()

        assert supervisor.browser_desktop.start.await_count == 2
        assert supervisor.browser_desktop.stop.await_count == 2
        supervisor._report_fatal_error.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_initial_start_stops_retrying_when_shutdown_set_during_backoff(self):
        supervisor = _make_lifecycle_supervisor()
        supervisor.browser_desktop.start = AsyncMock(side_effect=RuntimeError("not ready"))
        supervisor.browser_desktop.stop = AsyncMock()

        with patch.object(supervisor, "_wait_for_shutdown", AsyncMock(return_value=True)):
            assert not await supervisor._start_desktop_with_retries()

        supervisor.browser_desktop.start.assert_awaited_once()
        supervisor.browser_desktop.stop.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_cleanup_continues_when_a_process_exits_before_terminate(self, tmp_path):
        supervisor = _make_browser_desktop()
        password_path = tmp_path / "vnc-password"
        password_path.write_text("secret")
        supervisor._novnc_process = _process()
        supervisor._novnc_process.terminate.side_effect = ProcessLookupError
        x11vnc_process = _process()
        supervisor._x11vnc_process = x11vnc_process

        with (
            patch("sandbox_runtime.browser_desktop.VNC_PASSWORD_FILE_PATH", str(password_path)),
            patch.object(supervisor, "_clear_display_artifacts"),
        ):
            await supervisor.stop()

        x11vnc_process.terminate.assert_called_once()
        assert not password_path.exists()

    @pytest.mark.asyncio
    async def test_cleanup_is_reverse_order_and_removes_password(self, tmp_path):
        supervisor = _make_browser_desktop()
        order: list[str] = []

        def tracked_process(name):
            process = _process()
            process.terminate.side_effect = lambda: order.append(name)
            return process

        supervisor._xvfb_process = tracked_process("xvfb")
        supervisor._fluxbox_process = tracked_process("fluxbox")
        supervisor._x11vnc_process = tracked_process("x11vnc")
        supervisor._novnc_process = tracked_process("novnc")
        password_path = tmp_path / "vnc-password"
        password_path.write_text("secret")

        with (
            patch("sandbox_runtime.browser_desktop.VNC_PASSWORD_FILE_PATH", str(password_path)),
            patch.object(supervisor, "_clear_display_artifacts") as clear_artifacts,
        ):
            await supervisor.stop()

        assert order == ["novnc", "x11vnc", "fluxbox", "xvfb"]
        assert not password_path.exists()
        assert supervisor._xvfb_process is None
        assert supervisor._fluxbox_process is None
        assert supervisor._x11vnc_process is None
        assert supervisor._novnc_process is None
        clear_artifacts.assert_called_once()

    def test_clears_snapshot_restored_display_lock_and_socket(self, tmp_path):
        supervisor = _make_browser_desktop()
        x11_dir = tmp_path / ".X11-unix"
        x11_dir.mkdir()
        lock_path = tmp_path / ".X1-lock"
        socket_path = x11_dir / "X1"
        lock_path.write_text("123")
        socket_path.write_text("")

        real_path = Path

        def remap_path(value):
            if value == "/tmp/.X1-lock":
                return lock_path
            if value == "/tmp/.X11-unix/X1":
                return socket_path
            return real_path(value)

        with patch("sandbox_runtime.browser_desktop.Path", side_effect=remap_path):
            supervisor._clear_display_artifacts()

        assert not lock_path.exists()
        assert not socket_path.exists()

"""Image-contract checks that do not require a running provider sandbox."""

import contextlib
import runpy
import socket
import sys
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock, Mock

import pytest

verification = runpy.run_path(str(Path(__file__).parents[1] / "verify/smoke_test.py"))


@pytest.mark.parametrize("command", ["install", "verify"])
def test_smoke_test_uses_exit_status_without_success_report(monkeypatch, capsys, command):
    main = verification["main"]
    inspect = Mock()
    monkeypatch.setitem(main.__globals__, "inspect_image", inspect)
    monkeypatch.setattr(sys, "argv", ["smoke_test.py", command])
    monkeypatch.setattr(
        Path,
        "read_text",
        Mock(
            side_effect=[
                '{"runtimeEnv": {}}',
                "{}",
                "{}",
            ]
        ),
    )

    main()

    inspect.assert_called_once_with({"runtimeEnv": {}}, {}, services=command == "verify")
    assert capsys.readouterr().out == ""


def test_smoke_test_preserves_failures(monkeypatch):
    main = verification["main"]
    monkeypatch.setitem(
        main.__globals__,
        "inspect_image",
        Mock(side_effect=RuntimeError("Image service readiness timeout: opencode")),
    )
    monkeypatch.setattr(sys, "argv", ["smoke_test.py", "verify"])
    monkeypatch.setattr(
        Path,
        "read_text",
        Mock(
            side_effect=[
                '{"runtimeEnv": {}}',
                "{}",
                "{}",
            ]
        ),
    )

    with pytest.raises(RuntimeError, match="Image service readiness timeout: opencode"):
        main()


@pytest.mark.parametrize(
    "command,output,expected",
    [
        ("node", "v24.20.0", "24.20.0"),
        ("agent-browser", "agent-browser 0.37.0", "0.37.0"),
        ("code-server", "4.109.5 commit with Code 1.109.0", "4.109.5"),
        (
            "code-server",
            "i18next: initialized {}\ninfo Wrote default config\n4.109.5 commit with Code 1.109.5",
            "4.109.5",
        ),
        ("ttyd", "ttyd version 1.7.7", "1.7.7"),
        ("ttyd", "ttyd version 1.7.7-40e79c7", "1.7.7"),
        ("google-chrome", "Google Chrome for Testing 152.0.7977.82", "152.0.7977.82"),
    ],
)
def test_records_normalized_observed_tool_versions(command, output, expected):
    assert verification["observed_tool_version"](command, expected, output) == expected


@pytest.mark.parametrize(
    "output", ["v24.20.00", "v24.20.0-rc1", "unexpected v24.20.0", "v24.20.0\nv24.20.00"]
)
def test_rejects_version_substrings_and_nonrelease_versions(output):
    with pytest.raises(RuntimeError, match="version mismatch"):
        verification["observed_tool_version"]("node", "24.20.0", output)


@pytest.mark.parametrize(
    "banner,security,valid",
    [
        (b"RFB 003.008\n", b"\x01\x01", True),
        (b"<html>noVNC</html>", b"\x01\x01", False),
        (b"RFB 003.008\n", b"\x00", False),
    ],
)
def test_desktop_requires_websocket_rfb_exchange(monkeypatch, banner, security, valid):
    connection = MagicMock()
    connection.recv.side_effect = [banner, security]
    connect = MagicMock()
    connect.return_value.__enter__.return_value = connection
    monkeypatch.setitem(sys.modules, "websockets.sync.client", Mock(connect=connect))
    if valid:
        verification["verify_rfb_proxy"](12345)
        connection.send.assert_called_once_with(banner)
        connect.assert_called_once_with(
            "ws://127.0.0.1:12345/websockify",
            subprotocols=["binary"],
            open_timeout=5,
            close_timeout=1,
            proxy=None,
        )
    else:
        with pytest.raises(RuntimeError, match="RFB"):
            verification["verify_rfb_proxy"](12345)


def _vnc_server(*, accept_delay_seconds: float, banner: bytes | None):
    """Listen on a local port and serve connections one at a time, each after a delay."""
    listener = socket.create_server(("127.0.0.1", 0))
    stopped = threading.Event()

    def serve() -> None:
        while not stopped.wait(accept_delay_seconds):
            try:
                connection, _ = listener.accept()
            except OSError:
                return
            with connection:
                if banner is None:
                    stopped.wait()
                    return
                # A client that already gave up has closed its end.
                with contextlib.suppress(OSError):
                    connection.sendall(banner)

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    return listener, stopped


@pytest.mark.parametrize("accept_delay_seconds", [0, 1.5])
def test_rfb_wait_survives_a_server_slow_to_accept(accept_delay_seconds):
    listener, stopped = _vnc_server(
        accept_delay_seconds=accept_delay_seconds, banner=b"RFB 003.008\n"
    )
    with listener:
        try:
            verification["wait_for_rfb"](
                listener.getsockname()[1], [], deadline=time.monotonic() + 10
            )
        finally:
            stopped.set()


def test_rfb_wait_times_out_when_no_banner_arrives():
    listener, stopped = _vnc_server(accept_delay_seconds=0, banner=None)
    with listener:
        try:
            with pytest.raises(RuntimeError, match="VNC readiness timeout"):
                verification["wait_for_rfb"](
                    listener.getsockname()[1], [], deadline=time.monotonic() + 0.5
                )
        finally:
            stopped.set()


def test_rfb_wait_rejects_a_server_that_does_not_speak_rfb():
    listener, stopped = _vnc_server(accept_delay_seconds=0, banner=b"HTTP/1.1 200\r\n")
    with listener:
        try:
            with pytest.raises(RuntimeError, match="did not speak RFB"):
                verification["wait_for_rfb"](
                    listener.getsockname()[1], [], deadline=time.monotonic() + 5
                )
        finally:
            stopped.set()


def test_rfb_wait_stops_when_a_desktop_process_exits():
    exited = Mock()
    exited.poll.return_value = 1
    with pytest.raises(RuntimeError, match="Desktop process exited"):
        verification["wait_for_rfb"](1, [exited], deadline=time.monotonic() + 5)

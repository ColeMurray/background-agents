"""Image-contract checks that do not require a running provider sandbox."""

import runpy
import sys
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
        ("node", "v22.23.2", "22.23.2"),
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
    "output", ["v22.23.20", "v22.23.2-rc1", "unexpected v22.23.2", "v22.23.2\nv22.23.20"]
)
def test_rejects_version_substrings_and_nonrelease_versions(output):
    with pytest.raises(RuntimeError, match="version mismatch"):
        verification["observed_tool_version"]("node", "22.23.2", output)


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

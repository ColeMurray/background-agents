"""Image-contract checks that do not require a running provider sandbox."""

import runpy
import sys
from pathlib import Path
from unittest.mock import MagicMock, Mock

import pytest

verification = runpy.run_path(str(Path(__file__).parents[1] / "verify/image.py"))


@pytest.mark.parametrize("os_family", ["debian", "amazon-linux"])
def test_package_inventory_is_independent_of_query_order(os_family):
    probe = Mock()
    probe.run.side_effect = ["zlib=1\nalpha=2", "alpha=2\nzlib=1"]
    collect = verification["installed_os_packages"]
    assert collect(probe, os_family) == collect(probe, os_family) == ["alpha=2", "zlib=1"]


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

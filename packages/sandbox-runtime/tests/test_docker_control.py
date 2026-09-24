import asyncio
import tempfile
from unittest.mock import AsyncMock, Mock

import pytest

from sandbox_runtime.docker_control import DockerControl, request


@pytest.fixture
def socket_path():
    with tempfile.TemporaryDirectory(prefix="oi-docker-", dir="/tmp") as directory:
        yield directory + "/control.sock"


@pytest.mark.asyncio
async def test_preparation_is_acknowledged_only_after_clean_stop(socket_path):
    service = Mock(prepare_for_snapshot=AsyncMock())
    # Short paths also work on macOS's small Unix-domain path limit.
    path = socket_path
    control = DockerControl(service, path)
    await control.start()
    try:
        with pytest.raises(RuntimeError, match="confirmed shutdown"):
            await request("status", path)
        await asyncio.gather(request("prepare", path), request("prepare", path))
        # A lost capture response may prepare the same retained VM again.
        await request("prepare", path)
        service.prepare_for_snapshot.assert_awaited_once()
        await request("status", path)
    finally:
        await control.stop()


@pytest.mark.asyncio
async def test_failed_preparation_never_acknowledges_capture(socket_path):
    service = Mock(prepare_for_snapshot=AsyncMock(side_effect=RuntimeError("stop failed")))
    path = socket_path
    control = DockerControl(service, path)
    await control.start()
    try:
        with pytest.raises(RuntimeError):
            await request("prepare", path)
        assert not control.prepared
        with pytest.raises(RuntimeError):
            await request("status", path)
    finally:
        await control.stop()

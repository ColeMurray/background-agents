import asyncio
import tempfile
from unittest.mock import AsyncMock, Mock

import pytest

from sandbox_runtime.docker_control import DockerControl, request
from sandbox_runtime.docker_service import DOCKER_START_TIMEOUT_SECONDS, DOCKER_STOP_TIMEOUT_SECONDS


@pytest.fixture
def socket_path():
    with tempfile.TemporaryDirectory(prefix="oi-docker-", dir="/tmp") as directory:
        yield directory + "/control.sock"


@pytest.mark.asyncio
async def test_preparation_is_acknowledged_only_after_clean_stop(socket_path):
    service = Mock(
        prepare_for_snapshot=AsyncMock(),
        start_timeout_seconds=DOCKER_START_TIMEOUT_SECONDS,
        stop_timeout_seconds=DOCKER_STOP_TIMEOUT_SECONDS,
    )
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
        service.log.info.assert_any_call("docker.prepare_started")
        service.log.info.assert_any_call(
            "docker.prepare_completed", duration_ms=pytest.approx(0, abs=1000)
        )
        await request("status", path)
    finally:
        await control.stop()


@pytest.mark.asyncio
async def test_failed_preparation_never_acknowledges_capture(socket_path):
    service = Mock(
        prepare_for_snapshot=AsyncMock(side_effect=RuntimeError("stop failed")),
        start_timeout_seconds=DOCKER_START_TIMEOUT_SECONDS,
        stop_timeout_seconds=DOCKER_STOP_TIMEOUT_SECONDS,
    )
    path = socket_path
    control = DockerControl(service, path)
    await control.start()
    try:
        with pytest.raises(RuntimeError):
            await request("prepare", path)
        assert not control.prepared
        service.log.error.assert_called_once_with(
            "docker.prepare_failed",
            error_type="RuntimeError",
            duration_ms=pytest.approx(0, abs=1000),
            acknowledgement="not_confirmed",
        )
        with pytest.raises(RuntimeError):
            await request("status", path)
    finally:
        await control.stop()


async def test_stop_closes_idle_control_connections(socket_path):
    service = Mock(
        start_timeout_seconds=DOCKER_START_TIMEOUT_SECONDS,
        stop_timeout_seconds=DOCKER_STOP_TIMEOUT_SECONDS,
    )
    control = DockerControl(service, socket_path)
    await control.start()
    reader, writer = await asyncio.open_unix_connection(socket_path)
    try:
        async with asyncio.timeout(1):
            while not control._handlers:
                await asyncio.sleep(0)
        await asyncio.wait_for(control.stop(), timeout=1)
        assert await asyncio.wait_for(reader.readline(), timeout=1) == b""
        service.log.debug.assert_called_once_with(
            "docker.control_cancelled",
            phase="read_command",
            error_type="CancelledError",
            duration_ms=pytest.approx(0, abs=1000),
            acknowledgement="not_confirmed",
        )
        service.log.warn.assert_not_called()
    finally:
        writer.close()
        await writer.wait_closed()


@pytest.mark.asyncio
@pytest.mark.parametrize("recovery_fails", [False, True])
async def test_failed_preparation_records_recovery_without_exception_text(
    socket_path, recovery_fails
):
    secret = "registry credential must stay private"
    service = Mock(
        prepare_for_snapshot=AsyncMock(side_effect=RuntimeError(secret)),
        start_timeout_seconds=DOCKER_START_TIMEOUT_SECONDS,
        stop_timeout_seconds=DOCKER_STOP_TIMEOUT_SECONDS,
    )
    recover = AsyncMock(side_effect=ValueError(secret) if recovery_fails else None)
    control = DockerControl(service, socket_path, recover)
    await control.start()
    try:
        with pytest.raises(RuntimeError):
            await request("prepare", socket_path)
        recover.assert_awaited_once()
        assert not control.prepared
        service.log.info.assert_any_call("docker.recovery_started")
        if recovery_fails:
            service.log.error.assert_any_call("docker.recovery_failed", error_type="ValueError")
            service.log.warn.assert_called_once_with(
                "docker.control_failed",
                phase="recover",
                error_type="ValueError",
                duration_ms=pytest.approx(0, abs=1000),
                acknowledgement="not_confirmed",
            )
        else:
            service.log.info.assert_any_call("docker.recovery_completed")
            service.log.info.assert_any_call(
                "docker.prepare_acknowledgement",
                acknowledgement="not_confirmed",
                duration_ms=pytest.approx(0, abs=1000),
            )
        assert secret not in str(service.log.mock_calls)
    finally:
        await control.stop()


@pytest.mark.asyncio
async def test_control_read_timeout_is_logged_without_changing_socket_cleanup():
    service = Mock()
    control = DockerControl(service)
    reader = Mock(readline=AsyncMock(side_effect=TimeoutError("private diagnostic")))
    writer = Mock(wait_closed=AsyncMock())

    await control._handle(reader, writer)

    writer.write.assert_not_called()
    writer.close.assert_called_once()
    writer.wait_closed.assert_awaited_once()
    assert not control._handlers
    service.log.warn.assert_called_once_with(
        "docker.control_failed",
        phase="read_command",
        error_type="TimeoutError",
        duration_ms=pytest.approx(0, abs=1000),
        acknowledgement="not_confirmed",
    )

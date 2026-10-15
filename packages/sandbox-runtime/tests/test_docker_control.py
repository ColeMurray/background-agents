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
    finally:
        writer.close()
        await writer.wait_closed()


@pytest.mark.parametrize("fence", ["prepared", "stopping", "shutdown"])
async def test_restart_refuses_preparation_and_teardown_fences(socket_path, fence):
    service = Mock(stop=AsyncMock(), start=AsyncMock())
    control = DockerControl(service, socket_path)
    shutdown_event = asyncio.Event()
    if fence == "shutdown":
        shutdown_event.set()
    else:
        setattr(control, fence, True)

    assert not await control.restart(shutdown_event)
    service.stop.assert_not_awaited()
    service.start.assert_not_awaited()


async def test_restart_waits_for_preparation_and_does_not_respawn(socket_path):
    prepare_entered = asyncio.Event()
    finish_prepare = asyncio.Event()

    async def prepare():
        prepare_entered.set()
        await finish_prepare.wait()

    service = Mock(
        running=True,
        prepare_for_snapshot=AsyncMock(side_effect=prepare),
        stop=AsyncMock(),
        start=AsyncMock(),
        start_timeout_seconds=DOCKER_START_TIMEOUT_SECONDS,
        stop_timeout_seconds=DOCKER_STOP_TIMEOUT_SECONDS,
    )
    control = DockerControl(service, socket_path)
    await control.start()
    try:
        preparing = asyncio.create_task(request("prepare", socket_path))
        await asyncio.wait_for(prepare_entered.wait(), timeout=1)
        restarting = asyncio.create_task(control.restart(asyncio.Event()))
        await asyncio.sleep(0)
        assert not restarting.done()
        finish_prepare.set()
        await asyncio.wait_for(preparing, timeout=1)
        assert not await asyncio.wait_for(restarting, timeout=1)
        service.stop.assert_not_awaited()
        service.start.assert_not_awaited()
    finally:
        finish_prepare.set()
        await control.stop()


async def test_failed_preparation_recovery_uses_public_restart_without_deadlock(socket_path):
    service = Mock(
        running=True,
        prepare_for_snapshot=AsyncMock(side_effect=RuntimeError("stop failed")),
        stop=AsyncMock(),
        start=AsyncMock(),
        start_timeout_seconds=DOCKER_START_TIMEOUT_SECONDS,
        stop_timeout_seconds=DOCKER_STOP_TIMEOUT_SECONDS,
    )
    control = DockerControl(service, socket_path)

    async def recover():
        assert await control.restart(asyncio.Event())

    control.recover = recover
    await control.start()
    try:
        with pytest.raises(RuntimeError, match="confirmed shutdown"):
            await asyncio.wait_for(request("prepare", socket_path), timeout=1)
        service.stop.assert_awaited_once()
        service.start.assert_awaited_once()
        assert not control.prepared
    finally:
        await control.stop()


async def test_newer_preparation_fences_delayed_recovery(socket_path):
    recovery_entered = asyncio.Event()
    finish_recovery = asyncio.Event()
    service = Mock(
        running=True,
        prepare_for_snapshot=AsyncMock(side_effect=[RuntimeError("stop failed"), None]),
        stop=AsyncMock(),
        start=AsyncMock(),
        start_timeout_seconds=DOCKER_START_TIMEOUT_SECONDS,
        stop_timeout_seconds=DOCKER_STOP_TIMEOUT_SECONDS,
    )
    control = DockerControl(service, socket_path)

    async def recover():
        recovery_entered.set()
        await finish_recovery.wait()
        assert not await control.restart(asyncio.Event())

    control.recover = recover
    await control.start()
    try:
        failed_prepare = asyncio.create_task(request("prepare", socket_path))
        await asyncio.wait_for(recovery_entered.wait(), timeout=1)
        await asyncio.wait_for(request("prepare", socket_path), timeout=1)
        finish_recovery.set()
        with pytest.raises(RuntimeError, match="confirmed shutdown"):
            await failed_prepare
        await request("status", socket_path)
        assert control.prepared
        service.stop.assert_not_awaited()
        service.start.assert_not_awaited()
    finally:
        finish_recovery.set()
        await control.stop()


async def test_stop_fences_restart_before_draining_watcher(socket_path):
    service = Mock(stop=AsyncMock(), start=AsyncMock())
    control = DockerControl(service, socket_path)

    async def stop_watch():
        assert control.stopping
        assert not await control.restart(asyncio.Event())

    await control.stop(stop_watch)
    service.stop.assert_not_awaited()
    service.start.assert_not_awaited()


async def test_restart_serializes_watcher_handover_with_preparation(socket_path):
    watch_stop_entered = asyncio.Event()
    finish_watch_stop = asyncio.Event()
    service = Mock(
        running=True,
        prepare_for_snapshot=AsyncMock(),
        stop=AsyncMock(),
        start=AsyncMock(),
        start_timeout_seconds=DOCKER_START_TIMEOUT_SECONDS,
        stop_timeout_seconds=DOCKER_STOP_TIMEOUT_SECONDS,
    )
    control = DockerControl(service, socket_path)

    async def stop_watch():
        watch_stop_entered.set()
        await finish_watch_stop.wait()

    await control.start()
    try:
        restarting = asyncio.create_task(control.restart(asyncio.Event(), stop_watch=stop_watch))
        await asyncio.wait_for(watch_stop_entered.wait(), timeout=1)
        preparing = asyncio.create_task(request("prepare", socket_path))
        await asyncio.sleep(0)
        service.prepare_for_snapshot.assert_not_awaited()
        finish_watch_stop.set()
        assert await asyncio.wait_for(restarting, timeout=1)
        await asyncio.wait_for(preparing, timeout=1)
        assert control.prepared
        service.stop.assert_awaited_once()
        service.start.assert_awaited_once()
        service.prepare_for_snapshot.assert_awaited_once()
    finally:
        finish_watch_stop.set()
        await control.stop()

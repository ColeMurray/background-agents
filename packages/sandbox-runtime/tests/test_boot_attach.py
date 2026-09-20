"""BootAttach's lifecycle and command policy without an AgentBridge or WebSocket."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.boot_attach import BootAttach
from sandbox_runtime.event_forwarder import BufferedEventForwarder
from sandbox_runtime.git_signing import GitSigningError
from sandbox_runtime.harness import HarnessStartError
from tests.conftest import ScriptedHarness


@pytest.fixture
def coordinator():
    def build(*, early_connect=True, harness=None):
        shutdown = asyncio.Event()
        log = MagicMock()

        async def end_run():
            shutdown.set()

        return BootAttach(
            early_connect=early_connect,
            harness=harness,
            harness_factory=MagicMock(return_value=ScriptedHarness()),
            git_signing=MagicMock(initialize=AsyncMock()),
            event_forwarder=BufferedEventForwarder(sandbox_id="sandbox-1", log=log),
            shutdown_event=shutdown,
            log=log,
            load_session_id=AsyncMock(),
            build_ready_event=lambda: {"type": "ready"},
            send_event=AsyncMock(return_value=False),
            end_run=end_run,
            record_fatal_error=MagicMock(),
        )

    return build


def complete_boot(attach):
    attach.boot_relay.path.write_text(
        json.dumps({"seq": 1, "kind": "phase", "phase": "harness", "status": "completed"}) + "\n"
    )


async def test_early_start_defers_work_and_releases_waiters_only_after_ready(coordinator):
    attach = coordinator()
    calls = []
    harness = attach._harness_factory.return_value
    harness.open = AsyncMock(side_effect=lambda: calls.append("open"))
    attach._load_session_id.side_effect = lambda h: calls.append("resume")
    attach.git_signing.initialize.side_effect = lambda author: calls.append("signing")
    sending_ready = asyncio.Event()
    release_ready = asyncio.Event()

    async def send_ready(event):
        assert event["type"] == "ready"
        assert attach.harness is harness
        assert attach.booting
        calls.append("ready")
        sending_ready.set()
        await release_ready.wait()
        return False

    attach._send_event.side_effect = send_ready
    await attach.start()
    waiter = asyncio.create_task(
        attach.wait_until_ready("message-1", asyncio.get_running_loop().time() + 1)
    )
    try:
        await attach.before_connect()
        await asyncio.sleep(0)
        attach._harness_factory.assert_not_called()
        attach._load_session_id.assert_not_awaited()
        attach.git_signing.initialize.assert_not_awaited()
        assert not waiter.done()

        complete_boot(attach)
        await asyncio.wait_for(sending_ready.wait(), timeout=1)
        assert not waiter.done()
        release_ready.set()
        await asyncio.wait_for(waiter, timeout=1)

        assert calls == ["open", "resume", "signing", "ready"]
        assert not attach.booting
        # A further pass and connection attempt must not attach or sign again.
        await attach._relay_boot_events_once()
        await attach.before_connect()
        attach._harness_factory.assert_called_once()
        attach.git_signing.initialize.assert_awaited_once_with(None)
        assert calls == ["open", "resume", "signing", "ready"]
    finally:
        waiter.cancel()
        await attach.stop()


async def test_legacy_mode_opens_before_connect_and_retries_signing_without_reopening(coordinator):
    harness = ScriptedHarness()
    harness.open = AsyncMock(wraps=harness.open)
    attach = coordinator(early_connect=False, harness=harness)
    assert attach.harness is harness
    assert not attach.booting
    attach._harness_factory.assert_not_called()
    complete_boot(attach)
    warning = {"seq": 2, "kind": "warning", "scope": "sync", "message": "stale checkout"}
    with attach.boot_relay.path.open("a") as handle:
        handle.write(json.dumps(warning) + "\n")
    attach.git_signing.initialize.side_effect = [
        GitSigningError("unavailable", retryable=True),
        None,
    ]

    await attach.start()
    try:
        assert harness.opened
        attach._load_session_id.assert_awaited_once_with(harness)
        attach.git_signing.initialize.assert_not_awaited()
        with pytest.raises(GitSigningError, match="unavailable"):
            await attach.before_connect()
        await attach.before_connect()
        await attach.before_connect()
        assert attach.git_signing.initialize.await_count == 2
        harness.open.assert_awaited_once()
        attach._load_session_id.assert_awaited_once()

        # Run the task scheduled by start(), not the relay method directly.
        await asyncio.wait_for(attach._boot_relay_task, timeout=1)
        attach._send_event.assert_awaited_once_with(
            {"type": "warning", "scope": "sync", "message": "stale checkout"}
        )
        attach._send_event.reset_mock()

        await attach.wait_until_ready("message-1", asyncio.get_running_loop().time())
        await attach.on_connect()
        await attach.on_connect()
        assert [c.args[0] for c in attach._send_event.await_args_list] == [
            {"type": "ready"},
            {"type": "ready"},
        ]
    finally:
        await attach.stop()


@pytest.mark.parametrize("early_connect", [True, False])
@pytest.mark.parametrize(
    "command", ["prompt", "stop", "shutdown", "git_sync_complete", "ack", "unknown"]
)
async def test_other_commands_are_left_to_the_bridge(coordinator, early_connect, command):
    attach = coordinator(early_connect=early_connect)
    assert not await attach.handle_command({"type": command})
    attach._send_event.assert_not_awaited()


@pytest.mark.parametrize("early_connect", [True, False])
@pytest.mark.parametrize("command", ["snapshot", "refresh_diff", "push"])
async def test_command_gate_is_inert_in_legacy_mode(coordinator, early_connect, command):
    attach = coordinator(early_connect=early_connect)
    assert await attach.handle_command({"type": command}) is early_connect
    if early_connect and command == "push":
        event = attach._send_event.await_args.args[0]
        assert event["type"] == "push_error"
        assert event["branchName"] == ""
        assert "booting" in event["error"]
    else:
        attach._send_event.assert_not_awaited()


async def test_stopping_during_attach_closes_the_unpublished_harness(coordinator):
    attach = coordinator()
    harness = attach._harness_factory.return_value
    signing_started = asyncio.Event()

    async def sign(author):
        signing_started.set()
        await asyncio.Event().wait()

    attach.git_signing.initialize.side_effect = sign
    complete_boot(attach)
    await attach.start()
    try:
        await asyncio.wait_for(signing_started.wait(), timeout=1)
    finally:
        await attach.stop()

    assert harness.opened
    assert harness.closed
    assert attach.harness is None
    assert attach.booting
    assert attach.failure is None
    assert attach.outcome is None
    attach._send_event.assert_not_awaited()


@pytest.mark.parametrize(
    ("failure_stage", "error", "outcome"),
    [
        ("open", HarnessStartError("denied"), "harness_start_failed"),
        ("signing", GitSigningError("denied"), "fatal_error"),
        ("open", RuntimeError("unavailable"), "harness_attach_failed"),
    ],
)
async def test_attach_failure_records_outcome_and_ends_run(
    coordinator, failure_stage, error, outcome
):
    attach = coordinator()
    harness = attach._harness_factory.return_value
    if failure_stage == "open":
        harness.open = AsyncMock(side_effect=error)
    else:
        attach.git_signing.initialize.side_effect = error
    complete_boot(attach)
    await attach.start()
    try:
        await asyncio.wait_for(attach.shutdown_event.wait(), timeout=1)
    finally:
        await attach.stop()

    assert attach.failure is error
    assert attach.outcome == outcome
    assert attach.booting
    assert attach.harness is None
    attach._send_event.assert_not_awaited()
    if outcome in ("harness_start_failed", "fatal_error"):
        attach._record_fatal_error.assert_called_once_with(str(error))
    else:
        attach._record_fatal_error.assert_not_called()
    if failure_stage == "signing":
        assert harness.closed

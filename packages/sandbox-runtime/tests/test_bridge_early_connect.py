"""Bridge behaviour in early-connect mode.

The bridge connects before the repository boots, relays the supervisor's boot
phases, holds prompts until the supervisor reports the harness phase complete,
attaches its harness at that point, and only then sends ``ready``.
"""

import asyncio
import json
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from websockets import State

from sandbox_runtime import bridge as bridge_module
from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.git_signing import GitSigningError
from sandbox_runtime.harness import HarnessStartError
from tests.conftest import ScriptedHarness


def _events_path() -> Path:
    return Path(bridge_module.BOOT_EVENTS_FILE_PATH)


def _write_lines(*entries: dict) -> None:
    with _events_path().open("a") as handle:
        for entry in entries:
            handle.write(json.dumps(entry) + "\n")


def _phase(seq: int, phase: str, status: str, **extra) -> dict:
    return {
        "seq": seq,
        "kind": "phase",
        "phase": phase,
        "status": status,
        "at": float(seq),
        **extra,
    }


HARNESS_COMPLETED = _phase(9, "harness", "completed", elapsedMs=2100)


class FakeWs:
    def __init__(self):
        self.state = State.OPEN
        self.sent: list[dict] = []
        self.close_code = 1000

    async def send(self, data: str) -> None:
        self.sent.append(json.loads(data))

    def __aiter__(self):
        return self

    async def __anext__(self):
        raise StopAsyncIteration


class BlockingWs(FakeWs):
    """A quiet control plane: nothing inbound until the bridge closes the socket."""

    def __init__(self):
        super().__init__()
        self.closed = asyncio.Event()

    async def close(self, *_args, **_kwargs):
        self.closed.set()

    async def __anext__(self):
        await self.closed.wait()
        raise StopAsyncIteration


def _connect_quiet(bridge, monkeypatch) -> BlockingWs:
    ws = BlockingWs()
    monkeypatch.setattr(
        "sandbox_runtime.bridge.websockets.connect",
        lambda *_args, **_kwargs: ConnectionContext(ws),
    )
    return ws


class ConnectionContext:
    def __init__(self, ws):
        self.ws = ws

    async def __aenter__(self):
        return self.ws

    async def __aexit__(self, *_args):
        return False


def _run_complete(bridge) -> tuple[str, int]:
    """(outcome, connection_count) of the run_complete log line."""
    call = next(c for c in bridge.log.info.call_args_list if c.args == ("bridge.run_complete",))
    return call.kwargs["outcome"], call.kwargs["connection_count"]


class OpeningHarness(ScriptedHarness):
    """Records the attach sequence the bridge runs through it."""

    def __init__(self, calls: list[str], *, open_error: Exception | None = None):
        super().__init__(session_id=None)
        self.calls = calls
        self.open_error = open_error

    async def open(self) -> None:
        if self.open_error is not None:
            raise self.open_error
        self.calls.append("open")
        self.opened = True

    async def resume_session(self, persisted_id: str) -> bool:
        self.calls.append(f"resume:{persisted_id}")
        self.session_id = persisted_id
        return True


def _bridge(tmp_path, monkeypatch, *, factory=None, early_connect=True) -> AgentBridge:
    bridge = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
        early_connect=early_connect,
        harness_factory=factory,
    )
    bridge.session_id_file = tmp_path / "agent-session-id"
    bridge.legacy_session_id_file = tmp_path / "legacy-session-id"
    bridge.repo_manifest_path = tmp_path / "manifest.json"
    bridge.repo_manifest_path.write_text(json.dumps({"repositories": []}))
    bridge.git_signing.initialize = AsyncMock()
    bridge.log = MagicMock()
    return bridge


class TestHarnessAttach:
    async def test_no_harness_exists_before_the_harness_phase_completes(
        self, tmp_path, monkeypatch
    ):
        factory = MagicMock(side_effect=lambda: ScriptedHarness())
        bridge = _bridge(tmp_path, monkeypatch, factory=factory)
        bridge.event_forwarder.send = AsyncMock()
        _write_lines(
            _phase(1, "sync", "started"),
            _phase(2, "setup", "started", repoOwner="acme", repoName="api"),
        )

        await bridge._relay_boot_events_once()

        assert bridge.harness is None
        factory.assert_not_called()
        assert not bridge._boot_ready.is_set()
        assert bridge.agent_session_id is None

    async def test_harness_completed_attaches_in_order_then_sends_ready(
        self, tmp_path, monkeypatch
    ):
        calls: list[str] = []
        harness = OpeningHarness(calls)
        bridge = _bridge(tmp_path, monkeypatch, factory=lambda: harness)
        bridge.session_id_file.write_text("oc-persisted")
        bridge.git_signing.initialize = AsyncMock(
            side_effect=lambda _author: calls.append("signing")
        )
        bridge._send_event = AsyncMock(side_effect=lambda event: calls.append(event["type"]))
        _write_lines(_phase(1, "sync", "started"), HARNESS_COMPLETED)

        await bridge._relay_boot_events()

        assert calls == ["open", "resume:oc-persisted", "signing", "ready"]
        assert bridge.harness is harness
        assert bridge._boot_ready.is_set()
        ready = bridge._send_event.await_args.args[0]
        assert ready["opencodeSessionId"] == "oc-persisted"
        assert ready["harness"] == "opencode"
        assert bridge.session_id_file.read_text() == "oc-persisted"

    async def test_registry_harness_is_built_only_at_attach(self, tmp_path, monkeypatch):
        build = MagicMock(return_value=ScriptedHarness())
        monkeypatch.setattr("sandbox_runtime.bridge.build_agent_harness", build)
        bridge = _bridge(tmp_path, monkeypatch)
        bridge._send_event = AsyncMock()
        build.assert_not_called()
        _write_lines(_phase(1, "sync", "started"))
        await bridge._relay_boot_events_once()
        build.assert_not_called()

        _write_lines(HARNESS_COMPLETED)
        await bridge._relay_boot_events_once()

        build.assert_called_once()
        assert build.call_args.args[0] == bridge._harness_id

    async def test_deterministic_open_failure_records_the_cause_and_ends_the_run(
        self, tmp_path, monkeypatch
    ):
        fatal_path = tmp_path / "fatal.txt"
        monkeypatch.setattr("sandbox_runtime.bridge.BRIDGE_FATAL_ERROR_FILE_PATH", str(fatal_path))
        harness = OpeningHarness([], open_error=HarnessStartError("credential denied"))
        bridge = _bridge(tmp_path, monkeypatch, factory=lambda: harness)
        bridge._send_event = AsyncMock()
        ws = _connect_quiet(bridge, monkeypatch)
        _write_lines(HARNESS_COMPLETED)

        with pytest.raises(HarnessStartError, match="credential denied"):
            await asyncio.wait_for(bridge.run(), timeout=2)

        assert ws.closed.is_set()
        assert fatal_path.read_text() == "credential denied"
        assert bridge.harness is None
        assert not bridge._boot_ready.is_set()
        assert _run_complete(bridge) == ("harness_start_failed", 1)

    async def test_transient_open_failure_propagates_so_the_supervisor_restarts(
        self, tmp_path, monkeypatch
    ):
        harness = OpeningHarness([], open_error=RuntimeError("credential unavailable"))
        bridge = _bridge(tmp_path, monkeypatch, factory=lambda: harness)
        _connect_quiet(bridge, monkeypatch)
        _write_lines(HARNESS_COMPLETED)

        with pytest.raises(RuntimeError, match="credential unavailable"):
            await asyncio.wait_for(bridge.run(), timeout=2)

    async def test_retryable_signing_failure_is_retried_before_ready(self, tmp_path, monkeypatch):
        calls: list[str] = []
        harness = OpeningHarness(calls)
        bridge = _bridge(tmp_path, monkeypatch, factory=lambda: harness)
        bridge.git_signing.initialize = AsyncMock(
            side_effect=[
                GitSigningError("Commit signing configuration unavailable", retryable=True),
                None,
            ]
        )
        bridge._send_event = AsyncMock()
        sleep = AsyncMock()
        monkeypatch.setattr("sandbox_runtime.bridge.asyncio.sleep", sleep)
        _write_lines(HARNESS_COMPLETED)

        await bridge._relay_boot_events()

        assert bridge.git_signing.initialize.await_count == 2
        sleep.assert_awaited_once_with(bridge.RECONNECT_BACKOFF_BASE)
        assert bridge._boot_ready.is_set()

    async def test_non_retryable_signing_failure_ends_the_run_gracefully(
        self, tmp_path, monkeypatch
    ):
        harness = OpeningHarness([])
        bridge = _bridge(tmp_path, monkeypatch, factory=lambda: harness)
        bridge.git_signing.initialize = AsyncMock(
            side_effect=GitSigningError("Commit signing configuration unavailable", status_code=403)
        )
        bridge._send_event = AsyncMock()
        _connect_quiet(bridge, monkeypatch)
        _write_lines(HARNESS_COMPLETED)

        await asyncio.wait_for(bridge.run(), timeout=2)

        assert bridge.shutdown_event.is_set()
        assert not bridge._boot_ready.is_set()
        assert harness.closed is True
        assert _run_complete(bridge) == ("fatal_error", 1)


class TestConnectSnapshot:
    def _connect(self, bridge, monkeypatch) -> FakeWs:
        ws = FakeWs()
        monkeypatch.setattr(
            "sandbox_runtime.bridge.websockets.connect",
            lambda *_args, **_kwargs: ConnectionContext(ws),
        )
        return ws

    async def test_first_connect_without_phases_reports_starting(self, tmp_path, monkeypatch):
        bridge = _bridge(tmp_path, monkeypatch)
        ws = self._connect(bridge, monkeypatch)

        await bridge._connect_and_run()

        assert [event["type"] for event in ws.sent] == ["boot_progress"]
        assert ws.sent[0]["phase"] == "starting"
        assert ws.sent[0]["bootSeq"] == 0
        assert ws.sent[0]["sandboxId"] == "test-sandbox"

    async def test_reconnect_resends_only_the_latest_phase(self, tmp_path, monkeypatch):
        bridge = _bridge(tmp_path, monkeypatch)
        bridge.event_forwarder.send = AsyncMock()
        _write_lines(
            _phase(1, "sync", "started"),
            _phase(2, "sync", "completed"),
            _phase(3, "setup", "started", repoOwner="acme", repoName="api"),
        )
        await bridge._relay_boot_events_once()
        bridge.event_forwarder.send = bridge.event_forwarder.__class__.send.__get__(
            bridge.event_forwarder
        )
        ws = self._connect(bridge, monkeypatch)

        await bridge._connect_and_run()

        assert [(event["type"], event["bootSeq"]) for event in ws.sent] == [("boot_progress", 3)]
        assert ws.sent[0]["repoName"] == "api"

    async def test_connect_after_attach_sends_ready_and_no_phase(self, tmp_path, monkeypatch):
        harness = OpeningHarness([])
        bridge = _bridge(tmp_path, monkeypatch, factory=lambda: harness)
        _write_lines(HARNESS_COMPLETED)
        bridge.event_forwarder.send = AsyncMock()
        await bridge._relay_boot_events()
        bridge.event_forwarder.send = bridge.event_forwarder.__class__.send.__get__(
            bridge.event_forwarder
        )
        ws = self._connect(bridge, monkeypatch)

        await bridge._connect_and_run()

        assert [event["type"] for event in ws.sent] == ["ready"]

    async def test_phases_are_never_buffered_but_warnings_are(self, tmp_path, monkeypatch):
        bridge = _bridge(tmp_path, monkeypatch)
        _write_lines(
            _phase(1, "sync", "started"),
            {"seq": 2, "kind": "warning", "scope": "sync", "message": "stale checkout", "at": 2.0},
            _phase(3, "sync", "completed", warning=True),
        )

        await bridge._relay_boot_events_once()

        buffered = [event["type"] for event in bridge.event_forwarder._event_buffer]
        assert buffered == ["warning"]

    async def test_heartbeat_reports_booting_until_attached(self, tmp_path, monkeypatch):
        harness = OpeningHarness([])
        bridge = _bridge(tmp_path, monkeypatch, factory=lambda: harness)
        bridge._send_event = AsyncMock()

        assert bridge._heartbeat_event()["status"] == "booting"
        _write_lines(HARNESS_COMPLETED)
        await bridge._relay_boot_events()

        assert bridge._heartbeat_event()["status"] == "ready"


class TestCommandsWhileBooting:
    async def test_prompt_is_held_until_the_harness_attaches(self, tmp_path, monkeypatch):
        harness = OpeningHarness([])
        bridge = _bridge(tmp_path, monkeypatch, factory=lambda: harness)
        bridge._send_event = AsyncMock()
        bridge.git_signing.refresh = AsyncMock()
        prompt = asyncio.create_task(
            bridge._handle_prompt(
                {
                    "type": "prompt",
                    "messageId": "msg-1",
                    "content": "hi",
                    "author": {"gitIdentity": {"mode": "agent-only"}},
                }
            )
        )
        await asyncio.sleep(0)
        assert harness.prompts == []
        assert not prompt.done()

        _write_lines(HARNESS_COMPLETED)
        await bridge._relay_boot_events()
        await asyncio.wait_for(prompt, timeout=1)

        assert [p.message_id for p in harness.prompts] == ["msg-1"]
        terminal = bridge._send_event.await_args.args[0]
        assert terminal["type"] == "execution_complete"
        assert terminal["messageId"] == "msg-1"

    async def test_held_prompt_fails_when_the_hold_expires(self, tmp_path, monkeypatch):
        bridge = _bridge(tmp_path, monkeypatch)
        bridge._send_event = AsyncMock()
        bridge.prompt_limits = replace(bridge.prompt_limits, prompt_max_duration_seconds=0.01)

        seen_timeouts = []

        async def expire(coro, timeout):
            seen_timeouts.append(timeout)
            coro.close()
            raise TimeoutError

        monkeypatch.setattr("sandbox_runtime.bridge.asyncio.wait_for", expire)

        await bridge._handle_prompt({"type": "prompt", "messageId": "msg-1", "content": "hi"})

        terminal = bridge._send_event.await_args.args[0]
        assert terminal["type"] == "execution_complete"
        assert terminal["success"] is False
        assert "did not become ready" in terminal["error"]
        assert seen_timeouts == [0.01]

    async def test_stop_cancels_a_held_prompt(self, tmp_path, monkeypatch):
        bridge = _bridge(tmp_path, monkeypatch)
        bridge._send_event = AsyncMock()

        await bridge._handle_command({"type": "prompt", "messageId": "msg-1", "content": "hi"})
        task = bridge._current_prompt_task
        await asyncio.sleep(0)
        await bridge._handle_command({"type": "stop"})
        await asyncio.wait_for(task, timeout=1)

        terminals = [
            call.args[0]
            for call in bridge._send_event.await_args_list
            if call.args[0]["type"] == "execution_complete"
        ]
        assert terminals[0]["success"] is False
        assert terminals[0]["error"] == "Task was cancelled"

    async def test_shutdown_ends_the_bridge_while_booting(self, tmp_path, monkeypatch):
        bridge = _bridge(tmp_path, monkeypatch)

        await bridge._handle_command({"type": "shutdown"})

        assert bridge.shutdown_event.is_set()

    async def test_push_replies_push_error_without_running_git(self, tmp_path, monkeypatch):
        bridge = _bridge(tmp_path, monkeypatch)
        bridge._send_event = AsyncMock()
        monkeypatch.setattr(
            "sandbox_runtime.bridge.PushOperation",
            MagicMock(side_effect=AssertionError("push must not run while booting")),
        )

        await bridge._handle_command(
            {
                "type": "push",
                "pushSpec": {
                    "targetBranch": "open-inspect/sess-1",
                    "repoOwner": "acme",
                    "repoName": "api",
                    "refspec": "HEAD:refs/heads/open-inspect/sess-1",
                    "remoteUrl": "https://x@github.com/acme/api.git",
                    "redactedRemoteUrl": "https://github.com/acme/api.git",
                    "force": False,
                },
            }
        )

        event = bridge._send_event.await_args.args[0]
        assert event["type"] == "push_error"
        assert event["branchName"] == "open-inspect/sess-1"
        assert event["repoOwner"] == "acme"
        assert event["repoName"] == "api"
        assert "booting" in event["error"]

    async def test_snapshot_and_diff_refresh_are_dropped(self, tmp_path, monkeypatch):
        bridge = _bridge(tmp_path, monkeypatch)
        bridge._send_event = AsyncMock()
        bridge.diff_refresh.request = MagicMock()

        await bridge._handle_command({"type": "snapshot"})
        await bridge._handle_command({"type": "refresh_diff"})

        bridge._send_event.assert_not_awaited()
        bridge.diff_refresh.request.assert_not_called()
        assert bridge.log.warn.call_count == 2


class TestBridgeRestart:
    async def test_restarted_bridge_attaches_without_replaying_relayed_warnings(
        self, tmp_path, monkeypatch
    ):
        first = _bridge(tmp_path, monkeypatch)
        first.event_forwarder.send = AsyncMock()
        _write_lines(
            _phase(1, "sync", "started"),
            {"seq": 2, "kind": "warning", "scope": "sync", "message": "stale", "at": 2.0},
        )
        await first._relay_boot_events_once()
        assert [c.args[0]["type"] for c in first.event_forwarder.send.await_args_list] == [
            "boot_progress",
            "warning",
        ]

        harness = OpeningHarness([])
        restarted = _bridge(tmp_path, monkeypatch, factory=lambda: harness)
        restarted.event_forwarder.send = AsyncMock()
        _write_lines(
            {"seq": 3, "kind": "warning", "scope": "setup", "message": "new", "at": 3.0},
            HARNESS_COMPLETED,
        )
        await restarted._relay_boot_events()

        sent = [c.args[0] for c in restarted.event_forwarder.send.await_args_list]
        assert [(e["type"], e.get("message")) for e in sent] == [
            ("warning", "new"),
            ("boot_progress", None),
            ("ready", None),
        ]
        assert restarted.harness is harness


class TestClassicMode:
    async def test_warnings_are_relayed_but_phases_are_not(self, tmp_path, monkeypatch):
        bridge = _bridge(
            tmp_path, monkeypatch, factory=lambda: ScriptedHarness(), early_connect=False
        )
        bridge.event_forwarder.send = AsyncMock()
        _write_lines(
            _phase(1, "sync", "started"),
            {"seq": 2, "kind": "warning", "scope": "sync", "message": "stale", "at": 2.0},
            HARNESS_COMPLETED,
        )

        await bridge._relay_boot_events()

        sent = [call.args[0]["type"] for call in bridge.event_forwarder.send.await_args_list]
        assert sent == ["warning"]

    async def test_classic_bridge_has_its_harness_from_construction(self, tmp_path, monkeypatch):
        harness = ScriptedHarness()
        bridge = _bridge(tmp_path, monkeypatch, factory=lambda: harness, early_connect=False)

        assert bridge.harness is harness
        assert bridge._heartbeat_event()["status"] == "ready"

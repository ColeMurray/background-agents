"""Bridge startup, cleanup and session-identity contract at the harness seam."""

from __future__ import annotations

from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.harness import HarnessId, HarnessStartError, TurnOutcome, parse_harness_id
from tests.conftest import ScriptedHarness

if TYPE_CHECKING:
    from pathlib import Path


def _bridge(harness: ScriptedHarness) -> AgentBridge:
    bridge = AgentBridge(
        sandbox_id="sandbox-1",
        session_id="session-1",
        control_plane_url="https://control.example.com",
        auth_token="sandbox-token",
        harness=harness,
    )
    bridge.log = MagicMock()
    bridge.git_signing.initialize = AsyncMock()
    bridge.diff_refresh.close = AsyncMock()
    return bridge


class FailingOpenHarness(ScriptedHarness):
    def __init__(self, error: Exception, *, close_error: Exception | None = None) -> None:
        super().__init__(session_id=None)
        self._error = error
        self._close_error = close_error

    async def open(self) -> None:
        raise self._error

    async def close(self) -> None:
        self.closed = True
        if self._close_error is not None:
            raise self._close_error


class TestStartupLifecycle:
    @pytest.mark.asyncio
    async def test_start_error_is_recorded_and_reaches_main_even_when_close_fails(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fatal_path = tmp_path / "fatal.txt"
        monkeypatch.setattr("sandbox_runtime.bridge.BRIDGE_FATAL_ERROR_FILE_PATH", str(fatal_path))
        harness = FailingOpenHarness(
            HarnessStartError("credential denied"), close_error=RuntimeError("close blew up")
        )
        bridge = _bridge(harness)
        diff_close_error = RuntimeError("diff flush blew up")
        bridge.diff_refresh.close = AsyncMock(side_effect=diff_close_error)

        with pytest.raises(HarnessStartError, match="credential denied"):
            await bridge.run()

        assert harness.closed is True
        assert fatal_path.read_text() == "credential denied"
        bridge.log.error.assert_any_call("bridge.diff_refresh_close_failed", exc=diff_close_error)
        bridge.log.error.assert_any_call("bridge.harness_close_failed", exc=harness._close_error)

    @pytest.mark.asyncio
    async def test_any_open_failure_still_closes_the_harness(self) -> None:
        harness = FailingOpenHarness(RuntimeError("transient"))
        bridge = _bridge(harness)

        with pytest.raises(RuntimeError, match="transient"):
            await bridge.run()

        assert harness.closed is True
        bridge.log.info.assert_any_call(
            "bridge.run_complete",
            outcome="harness_start_failed",
            connection_count=0,
            reconnect_count=0,
            reconnect_attempt_count=0,
            total_connected_duration_seconds=0.0,
        )


class TestSessionIdentity:
    @pytest.mark.asyncio
    async def test_invalid_persisted_id_does_not_create_a_session_at_startup(
        self, tmp_path: Path
    ) -> None:
        harness = ScriptedHarness(session_id=None)
        harness.resume_session = AsyncMock(return_value=False)  # type: ignore[method-assign]
        harness.create_session = AsyncMock()  # type: ignore[method-assign]
        bridge = _bridge(harness)
        bridge.session_id_file = tmp_path / "agent-session-id"
        bridge.legacy_session_id_file = tmp_path / "opencode-session-id"
        bridge.legacy_session_id_file.write_text("oc-gone")

        await bridge._load_session_id()

        harness.resume_session.assert_awaited_once_with("oc-gone")
        harness.create_session.assert_not_awaited()
        assert bridge.agent_session_id is None
        assert not bridge.session_id_file.exists()

    @pytest.mark.asyncio
    async def test_resumed_id_is_persisted_under_the_current_file_name(
        self, tmp_path: Path
    ) -> None:
        harness = ScriptedHarness(session_id=None)
        bridge = _bridge(harness)
        bridge.session_id_file = tmp_path / "agent-session-id"
        bridge.legacy_session_id_file = tmp_path / "opencode-session-id"
        bridge.legacy_session_id_file.write_text("oc-live")

        await bridge._load_session_id()

        assert harness.session_id == "oc-live"
        assert bridge.session_id_file.read_text() == "oc-live"

    @pytest.mark.asyncio
    async def test_first_prompt_creates_the_session_the_harness_owns(self, tmp_path: Path) -> None:
        harness = ScriptedHarness(session_id=None)
        bridge = _bridge(harness)
        bridge.session_id_file = tmp_path / "agent-session-id"

        await bridge._ensure_agent_session()
        await bridge._ensure_agent_session()

        assert bridge.agent_session_id == harness.session_id == "oc-session-new"
        assert bridge.session_id_file.read_text() == "oc-session-new"


class TestHarnessContracts:
    def test_only_deployable_harness_ids_parse(self) -> None:
        assert parse_harness_id(None) is HarnessId.OPENCODE
        assert parse_harness_id("opencode") is HarnessId.OPENCODE
        assert parse_harness_id("claude") is HarnessId.CLAUDE
        with pytest.raises(ValueError, match="Unsupported harness: 'codex'"):
            parse_harness_id("codex")

    def test_turn_outcome_rejects_contradictions(self) -> None:
        with pytest.raises(ValueError, match="cancelled"):
            TurnOutcome(success=True, cancelled=True)
        with pytest.raises(ValueError, match="error message"):
            TurnOutcome(success=False)
        assert TurnOutcome.failed("boom", message_cost_usd=0.1).message_cost_usd == 0.1

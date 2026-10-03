"""
Focused regressions for step replay, cumulative cost, model variants, and IDs.

Note: Message tracking and correlation tests are in test_bridge_sse.py,
which tests the parentID-based correlation mechanism used for attributing
events to the correct prompt.
"""

from unittest.mock import MagicMock

import pytest

from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.harness.opencode_stream import _PromptState
from sandbox_runtime.opencode_identifier import OpenCodeIdentifier
from tests.conftest import wire_opencode_transport


@pytest.fixture
def bridge() -> AgentBridge:
    """Create a bridge instance for testing."""
    bridge = AgentBridge(
        sandbox_id="test-sandbox",
        session_id="test-session",
        control_plane_url="http://localhost:8787",
        auth_token="test-token",
    )
    bridge.harness.session_id = "oc-session-123"
    wire_opencode_transport(bridge, MagicMock())
    return bridge


def make_state(message_id: str) -> _PromptState:
    """Per-prompt state as stream_prompt would build it."""
    return _PromptState(
        opencode_session_id="oc-session-123",
        message_id=message_id,
        opencode_message_id="msg_test",
        start_time=0.0,
    )


class TestHandlePartTranslation:
    """Step correlation and cumulative-cost corrections survive replay."""

    def test_step_ids_match_start_parts_across_steps_and_replay(self, bridge: AgentBridge):
        stream = bridge.harness.prompt_stream
        state = make_state("cp-message-123")
        first_start = stream._handle_part(
            state, {"type": "step-start", "id": "start-1", "messageID": "assistant-1"}, None
        )[0]
        first_finish = stream._handle_part(
            state, {"type": "step-finish", "id": "finish-1", "messageID": "assistant-1"}, None
        )[0]
        second_start = stream._handle_part(
            state, {"type": "step-start", "id": "start-2", "messageID": "assistant-1"}, None
        )[0]
        interleaved_replay = stream._handle_part(
            state, {"type": "step-start", "id": "start-1", "messageID": "assistant-1"}, None
        )[0]
        corrected_finish = stream._handle_part(
            state, {"type": "step-finish", "id": "finish-1", "messageID": "assistant-1"}, None
        )[0]
        second_finish = stream._handle_part(
            state, {"type": "step-finish", "id": "finish-2", "messageID": "assistant-1"}, None
        )[0]

        assert first_start["stepId"] == first_finish["stepId"] == "start-1"
        assert interleaved_replay["stepId"] == first_start["stepId"]
        assert corrected_finish["stepId"] == first_start["stepId"]
        assert second_start["stepId"] == second_finish["stepId"] == "start-2"
        assert first_start["stepId"] != second_start["stepId"]
        replayed_start = stream._handle_part(
            state,
            {"type": "step-start", "id": "start-1", "messageID": "assistant-1"},
            None,
        )[0]
        assert replayed_start["stepId"] == first_finish["stepId"]
        replayed_finish = stream._handle_part(
            state, {"type": "step-finish", "id": "finish-1", "messageID": "assistant-1"}, None
        )[0]
        unmatched_finish = stream._handle_part(
            state, {"type": "step-finish", "id": "finish-3", "messageID": "assistant-1"}, None
        )[0]
        assert replayed_finish["stepId"] == first_start["stepId"]
        assert unmatched_finish["stepId"] == "finish-3"

    def test_step_finish_reports_cumulative_turn_cost(self, bridge: AgentBridge):
        """Each step carries the turn total; a re-emitted part replaces its own cost."""
        stream = bridge.harness.prompt_stream
        state = make_state("cp-message-123")

        first = stream._handle_part(state, {"type": "step-finish", "id": "s1", "cost": 0.5}, None)
        second = stream._handle_part(state, {"type": "step-finish", "id": "s2", "cost": 0.25}, None)
        corrected = stream._handle_part(
            state, {"type": "step-finish", "id": "s1", "cost": 0.75}, None
        )
        unpriced = stream._handle_part(state, {"type": "step-finish", "id": "s3"}, None)

        assert first[0]["messageCostUsd"] == 0.5
        assert second[0]["messageCostUsd"] == 0.75
        assert corrected[0]["messageCostUsd"] == 1.0
        assert unpriced[0]["messageCostUsd"] == 1.0


class TestBuildPromptRequestBody:
    """Tests for _build_prompt_request_body method."""

    @pytest.mark.parametrize(
        "model,effort",
        [
            ("claude-haiku-4-5", "high"),
            ("anthropic/claude-opus-5", "xhigh"),
            ("openai/gpt-5.6-sol", "none"),
        ],
    )
    def test_reasoning_effort_uses_variant(self, bridge: AgentBridge, model: str, effort: str):
        body = bridge.harness.prompt_stream._build_prompt_request_body(
            "Hello", model, reasoning_effort=effort
        )
        assert body["variant"] == effort
        assert set(body["model"]) == {"providerID", "modelID"}

    def test_no_effort_preserves_opencode_default(self, bridge: AgentBridge):
        body = bridge.harness.prompt_stream._build_prompt_request_body(
            "Hello", "openai/gpt-5.6-sol"
        )
        assert "variant" not in body
        assert "options" not in body["model"]


class TestOpenCodeIdentifier:
    """Tests for OpenCode-compatible ascending ID generation."""

    def test_ascending_generates_msg_prefix(self):
        """Ascending message IDs should start with 'msg_'."""
        msg_id = OpenCodeIdentifier.ascending("message")
        assert msg_id.startswith("msg_")

    def test_ascending_generates_unique_ids(self):
        """Each call should generate a unique ID."""
        ids = [OpenCodeIdentifier.ascending("message") for _ in range(100)]
        assert len(set(ids)) == 100  # All unique

    def test_ascending_ids_increase_within_one_rollover_window(self, monkeypatch):
        """Consecutive IDs increase — but only inside a rollover window.

        The encoded value is truncated to 48 bits and wraps roughly every 795
        days, so this is not an ordering guarantee callers may rely on: nothing
        may compare these IDs to order messages. The clock is pinned inside one
        window so the assertion cannot straddle a rollover, and it ticks once so
        both the same-millisecond counter and the millisecond advance are
        covered.
        """
        pinned_epoch_seconds = 1_754_000_000.0
        next_millisecond = pinned_epoch_seconds + 0.5
        ticks = iter([pinned_epoch_seconds, pinned_epoch_seconds, next_millisecond])
        monkeypatch.setattr(
            "sandbox_runtime.opencode_identifier.time.time",
            lambda: next(ticks, next_millisecond),
        )

        id1 = OpenCodeIdentifier.ascending("message")
        id2 = OpenCodeIdentifier.ascending("message")
        id3 = OpenCodeIdentifier.ascending("message")

        assert id1 < id2 < id3

    def test_ascending_generates_correct_format(self):
        """IDs should have format: prefix_timestamphex(12)random(14)."""
        msg_id = OpenCodeIdentifier.ascending("message")

        # Format: msg_XXXXXXXXXXXX... (prefix + underscore + 26 chars)
        assert msg_id.startswith("msg_")
        suffix = msg_id[4:]  # After "msg_"

        # First 12 chars should be hex (timestamp)
        timestamp_hex = suffix[:12]
        assert all(c in "0123456789abcdef" for c in timestamp_hex)

        # Next 14 chars should be base62 (random)
        random_part = suffix[12:]
        assert len(random_part) == 14
        base62_chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
        assert all(c in base62_chars for c in random_part)

    def test_ascending_supports_session_prefix(self):
        """Should support 'session' prefix."""
        ses_id = OpenCodeIdentifier.ascending("session")
        assert ses_id.startswith("ses_")

    def test_ascending_supports_part_prefix(self):
        """Should support 'part' prefix."""
        part_id = OpenCodeIdentifier.ascending("part")
        assert part_id.startswith("prt_")

    def test_ascending_rejects_unknown_prefix(self):
        """Should raise ValueError for unknown prefixes."""
        with pytest.raises(ValueError, match="Unknown prefix"):
            OpenCodeIdentifier.ascending("unknown")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

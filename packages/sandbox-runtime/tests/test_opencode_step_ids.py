"""OpenCode step ID correlation without SSE event translation."""

from sandbox_runtime.harness.opencode_step_ids import StepIdTracker


def test_completed_start_replay_preserves_newer_active_step():
    tracker = StepIdTracker()
    assert tracker.start("msg", "start-1") == "start-1"
    assert tracker.finish("msg", "finish-1") == "start-1"
    assert tracker.start("msg", "start-2") == "start-2"
    assert tracker.start("msg", "start-1") == "start-1"
    assert tracker.finish("msg", "finish-1") == "start-1"
    assert tracker.finish("msg", "finish-2") == "start-2"


def test_replayed_finish_leaves_no_active_step_for_later_unmatched_finish():
    tracker = StepIdTracker()
    tracker.start("msg", "start-1")
    tracker.finish("msg", "finish-1")
    tracker.start("msg", "start-1")
    assert tracker.finish("msg", "finish-1") == "start-1"
    assert tracker.finish("msg", "finish-2") == "finish-2"

from sandbox_runtime.child_activity import (
    MAX_PENDING_CHILD_ACTIVITY,
    ChildActivityCorrelator,
    MessageDisposition,
    PendingChildError,
    PendingChildMessage,
)


def test_correlates_messages_and_preserves_ownership_after_close():
    correlator = ChildActivityCorrelator()
    correlator.track("child-1")

    assert (
        correlator.authorize_or_queue_message("child-1", "message-1") is MessageDisposition.QUEUED
    )
    correlator.associate("child-1", "task-1")
    assert correlator.release("child-1") == [PendingChildMessage("child-1", "message-1", True)]
    correlator.close("task-1")

    assert correlator.task_for_message("message-1") == "task-1"


def test_correlates_message_first_seen_after_close_to_completed_task():
    correlator = ChildActivityCorrelator()
    correlator.associate("child-1", "task-1")
    correlator.close("task-1")

    assert (
        correlator.authorize_or_queue_message("child-1", "late-message")
        is MessageDisposition.AUTHORIZED
    )
    assert correlator.task_for_message("late-message") == "task-1"


def test_resume_replaces_completed_task_for_new_messages_without_changing_old_ownership():
    correlator = ChildActivityCorrelator()
    correlator.associate("child-1", "task-1")
    correlator.close("task-1")
    correlator.authorize_or_queue_message("child-1", "late-message")

    correlator.associate("child-1", "task-2")

    assert (
        correlator.authorize_or_queue_message("child-1", "resumed-message")
        is MessageDisposition.AUTHORIZED
    )
    assert (
        correlator.authorize_or_queue_message("child-1", "late-message")
        is MessageDisposition.AUTHORIZED
    )
    assert correlator.task_for_message("late-message") == "task-1"
    assert correlator.task_for_message("resumed-message") == "task-2"


def test_ambiguous_activity_is_not_reassigned_to_a_resumed_task():
    correlator = ChildActivityCorrelator()
    correlator.associate("child-1", "task-1")
    correlator.close("task-1")
    correlator.queue_error("child-1", "late error")
    correlator.associate("child-1", "task-2")

    assert correlator.release("child-1") == []
    pending = correlator.flush()
    assert pending == [PendingChildError("child-1", "late error", False)]
    assert correlator.task_for_pending(pending[0]) is None


def test_pending_activity_is_bounded_and_drop_logging_is_one_shot():
    correlator = ChildActivityCorrelator()

    for index in range(MAX_PENDING_CHILD_ACTIVITY):
        assert correlator.queue_error("child-1", f"error-{index}") is True

    assert correlator.queue_error("child-1", "overflow") is False
    assert correlator.should_log_drop() is True
    assert correlator.should_log_drop() is False

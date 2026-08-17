from sandbox_runtime.message_attribution import (
    AssistantMessageDisposition,
    MessageAttribution,
)
from tests.conftest import oc_message_id

PROMPT_TS_MS = 1_754_000_000_000
PROMPT_MESSAGE_ID = oc_message_id(PROMPT_TS_MS, 2, "p")

# OpenCode truncates its encoded message IDs to 48 bits, so the encoding rolls
# over every 2**36 ms and IDs minted after a rollover sort below every ID from
# the window before it. This is the rollover that broke pre-existing sessions.
ROLLOVER_TS_MS = 26 * 2**36
ONE_HOUR_MS = 60 * 60 * 1000


def _attribution(
    message_id: str = PROMPT_MESSAGE_ID, started_epoch_ms: int = PROMPT_TS_MS
) -> MessageAttribution:
    return MessageAttribution(message_id, started_epoch_ms)


def test_direct_parent_message_is_accepted_and_tracked():
    attribution = _attribution()

    disposition = attribution.assistant_disposition(
        "assistant-message", PROMPT_MESSAGE_ID, is_summary=False, created_epoch_ms=None
    )

    assert disposition is AssistantMessageDisposition.OUTPUT
    assert attribution.is_assistant_allowed("assistant-message")


def test_discovered_user_message_can_parent_output():
    attribution = _attribution()
    attribution.add_user_message("server-generated-user-message")

    disposition = attribution.assistant_disposition(
        "assistant-message",
        "server-generated-user-message",
        is_summary=False,
        created_epoch_ms=None,
    )

    assert disposition is AssistantMessageDisposition.OUTPUT


def test_correlated_summary_is_error_only_and_remains_correlated():
    attribution = _attribution()

    first = attribution.assistant_disposition(
        "summary-message", PROMPT_MESSAGE_ID, is_summary=True, created_epoch_ms=PROMPT_TS_MS
    )
    repeated = attribution.assistant_disposition(
        "summary-message", "", is_summary=False, created_epoch_ms=PROMPT_TS_MS
    )

    assert first is AssistantMessageDisposition.ERROR_ONLY
    assert repeated is AssistantMessageDisposition.ERROR_ONLY
    assert not attribution.is_assistant_allowed("summary-message")


def test_tracked_message_is_accepted_during_reconciliation():
    attribution = _attribution()
    attribution.allow_assistant("assistant-message")

    disposition = attribution.assistant_disposition(
        "assistant-message", "unknown-parent", is_summary=False, created_epoch_ms=None
    )

    assert disposition is AssistantMessageDisposition.OUTPUT


def test_compaction_fallback_only_accepts_messages_created_after_the_prompt():
    attribution = _attribution()

    assert (
        attribution.assistant_disposition(
            "after-prompt", "unknown", is_summary=False, created_epoch_ms=PROMPT_TS_MS + 1
        )
        is AssistantMessageDisposition.REJECT
    )

    attribution.mark_compacted()

    assert (
        attribution.assistant_disposition(
            "before-prompt", "unknown", is_summary=False, created_epoch_ms=PROMPT_TS_MS - 1
        )
        is AssistantMessageDisposition.REJECT
    )
    assert (
        attribution.assistant_disposition(
            "after-prompt", "unknown", is_summary=False, created_epoch_ms=PROMPT_TS_MS + 1
        )
        is AssistantMessageDisposition.OUTPUT
    )


def test_compaction_fallback_rejects_the_boundary_millisecond():
    """The boundary is truncated to whole milliseconds, so a prior turn's
    message created earlier within it must not be claimed. Nothing this prompt
    produces shares that millisecond."""
    attribution = _attribution()
    attribution.mark_compacted()

    disposition = attribution.assistant_disposition(
        "same-millisecond", "unknown", is_summary=False, created_epoch_ms=PROMPT_TS_MS
    )

    assert disposition is AssistantMessageDisposition.REJECT


def test_compaction_fallback_ignores_id_order_across_a_rollover():
    """An earlier turn's message outranks ours by ID after a rollover."""
    prompt_ts_ms = ROLLOVER_TS_MS + ONE_HOUR_MS
    stale_ts_ms = ROLLOVER_TS_MS - ONE_HOUR_MS
    prompt_message_id = oc_message_id(prompt_ts_ms, 2, "p")
    stale_message_id = oc_message_id(stale_ts_ms, 1, "s")
    fresh_message_id = oc_message_id(prompt_ts_ms, 3, "f")

    # Guards the premise: ordering by ID would claim the earlier turn's message
    # and drop ours, which is exactly backwards.
    assert stale_message_id > prompt_message_id
    assert fresh_message_id < stale_message_id

    attribution = _attribution(prompt_message_id, prompt_ts_ms)
    attribution.mark_compacted()

    assert (
        attribution.assistant_disposition(
            stale_message_id, "unknown", is_summary=False, created_epoch_ms=stale_ts_ms
        )
        is AssistantMessageDisposition.REJECT
    )
    assert (
        attribution.assistant_disposition(
            fresh_message_id, "unknown", is_summary=False, created_epoch_ms=prompt_ts_ms + 1
        )
        is AssistantMessageDisposition.OUTPUT
    )


def test_compaction_fallback_rejects_a_message_without_a_creation_time():
    attribution = _attribution()
    attribution.mark_compacted()

    disposition = attribution.assistant_disposition(
        "untimed-message", "unknown", is_summary=False, created_epoch_ms=None
    )

    assert disposition is AssistantMessageDisposition.REJECT


def test_compaction_summary_is_never_accepted_as_output():
    attribution = _attribution()
    attribution.mark_compacted()

    disposition = attribution.assistant_disposition(
        "summary-message", "unknown", is_summary=True, created_epoch_ms=PROMPT_TS_MS
    )

    assert disposition is AssistantMessageDisposition.REJECT

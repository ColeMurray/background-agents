from sandbox_runtime.message_attribution import (
    AssistantMessageDisposition,
    MessageAttribution,
)
from tests.conftest import oc_message_id

PROMPT_TS_MS = 1_754_000_000_000
PROMPT_MESSAGE_ID = oc_message_id(PROMPT_TS_MS, 2, "p")


def test_direct_parent_message_is_accepted_and_tracked():
    attribution = MessageAttribution(PROMPT_MESSAGE_ID)

    disposition = attribution.assistant_disposition(
        "assistant-message", PROMPT_MESSAGE_ID, is_summary=False
    )

    assert disposition is AssistantMessageDisposition.OUTPUT
    assert attribution.is_assistant_allowed("assistant-message")


def test_discovered_user_message_can_parent_output():
    attribution = MessageAttribution(PROMPT_MESSAGE_ID)
    attribution.add_user_message("server-generated-user-message")

    disposition = attribution.assistant_disposition(
        "assistant-message", "server-generated-user-message", is_summary=False
    )

    assert disposition is AssistantMessageDisposition.OUTPUT


def test_correlated_summary_is_error_only_and_remains_correlated():
    attribution = MessageAttribution(PROMPT_MESSAGE_ID)

    first = attribution.assistant_disposition("summary-message", PROMPT_MESSAGE_ID, is_summary=True)
    repeated = attribution.assistant_disposition("summary-message", "", is_summary=False)

    assert first is AssistantMessageDisposition.ERROR_ONLY
    assert repeated is AssistantMessageDisposition.ERROR_ONLY
    assert not attribution.is_assistant_allowed("summary-message")


def test_tracked_message_is_accepted_during_reconciliation():
    attribution = MessageAttribution(PROMPT_MESSAGE_ID)
    attribution.allow_assistant("assistant-message")

    disposition = attribution.assistant_disposition(
        "assistant-message", "unknown-parent", is_summary=False
    )

    assert disposition is AssistantMessageDisposition.OUTPUT


def test_compaction_fallback_only_accepts_messages_after_prompt_boundary():
    attribution = MessageAttribution(PROMPT_MESSAGE_ID)
    before_prompt = oc_message_id(PROMPT_TS_MS, 1, "b")
    after_prompt = oc_message_id(PROMPT_TS_MS, 3, "a")

    assert (
        attribution.assistant_disposition(after_prompt, "unknown", is_summary=False)
        is AssistantMessageDisposition.REJECT
    )

    attribution.mark_compacted()

    assert (
        attribution.assistant_disposition(before_prompt, "unknown", is_summary=False)
        is AssistantMessageDisposition.REJECT
    )
    assert (
        attribution.assistant_disposition(after_prompt, "unknown", is_summary=False)
        is AssistantMessageDisposition.OUTPUT
    )


def test_compaction_summary_is_never_accepted_as_output():
    attribution = MessageAttribution(PROMPT_MESSAGE_ID)
    attribution.mark_compacted()
    after_prompt = oc_message_id(PROMPT_TS_MS, 3, "s")

    disposition = attribution.assistant_disposition(after_prompt, "unknown", is_summary=True)

    assert disposition is AssistantMessageDisposition.REJECT

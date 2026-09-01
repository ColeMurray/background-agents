# Research: Slack Initial Mention Images

**Date:** 2026-09-01 **Status:** Research only **Scope:** Trace image handling for Slack mentions
that create a session and compare it with image handling on follow-up mentions.

This document is intentionally research-only. It does not include recommendations, implementation
plans, proposed code/API/schema changes, task breakdowns, estimates, or rollout steps.

## Summary

Initial mentions and follow-up mentions use the same image download, session upload,
prompt-reference, and sandbox hydration pipeline. Their relevant difference occurs when the Slack
bot recovers file metadata that is absent from an `app_mention` event: top-level mentions use
`conversations.history`, while thread replies use `conversations.replies`.

The top-level lookup can return a successful result containing no files when its response does not
contain the exact target timestamp. The mention handler then sends the user's text as a text-only
prompt. Because no candidate image reaches image preparation, this condition does not produce an
attachment-drop notice. This behavior is consistent with the reported first-message symptom.

A separate metadata-loss path exists when an event contains a nonempty but partial `files` array.
The event array takes precedence over lookup results as a whole. The inbound schema permits file
objects without a MIME type or private download URL, and image normalization silently excludes
objects without a supported MIME type.

## Research Questions

1. How are Slack image files recovered and delivered on the first mention?
2. How does the follow-up path differ from the first-mention path?
3. Which existing tests cover these workflows, and which reported scenario is not covered?

## Current Behavior

Every `app_mention` is validated with optional `files` and `attachments` arrays. The handler strips
the bot mention and attempts a one-message Slack API lookup when either array is absent or empty.

For a top-level mention, `getMessageDetails` requests `conversations.history` with
`latest=<message ts>`, `inclusive=true`, and `limit=1`. For a reply, it requests
`conversations.replies` with the thread timestamp, `oldest=<message ts>`, `inclusive=true`, and
`limit=2`. Both responses are searched for an exact timestamp match.

When the Slack API call itself fails, the failure result reaches the mention handler and produces a
`slack.attachment.file_lookup_failed` warning. When the API call succeeds but the exact message is
absent, `getMessageDetails` returns `{ ok: true, files: [], attachments: [] }`. The handler treats
that result as a message with no files and emits no lookup warning.

When text remains after mention stripping, an empty recovered file list does not stop processing.
The classifier receives the text, a session can be created, and the prompt is delivered without an
`attachments` property. Attachment-drop reporting does not run because no file entered image
preparation or upload.

When file metadata is available, only supported image MIME types with trusted Slack-hosted private
URLs become image attachments. The bot downloads those files before initial session creation,
uploads the bytes to the created session, and sends attachment references with the prompt.

## Relevant Workflows

### Initial top-level mention

1. The events route validates optional file metadata and dispatches `app_mention`.
2. The mention handler calls `getMessageDetails` if event file or attachment metadata is missing.
3. `getMessageDetails` uses `conversations.history` for the top-level message.
4. Valid Slack-hosted image metadata is normalized and passed into session launch.
5. Session launch downloads images, creates the session, uploads prepared bytes, and includes the
   resulting references in the first prompt.

### Follow-up mention

1. The same event and mention handling applies.
2. File recovery for a thread reply uses `conversations.replies`.
3. If the thread already maps to a session, the handler downloads and uploads images directly to
   that session.
4. The same `deliverPrompt` function used by initial session launch adds attachment references to
   the follow-up prompt.

### Agent delivery

The control plane stores and resolves prompt attachment references. The sandbox runtime downloads
the stored bytes, base64-encodes them, and constructs OpenCode `file` parts. No initial-versus-
follow-up branch is present in this downstream path.

## Existing Patterns

- Both new-session and existing-session prompt paths converge on `deliverPrompt`.
- Images are downloaded before initial session creation so an image-only request cannot create an
  unprompted session when every known image fails.
- Known download and upload failures are accumulated and can produce a Slack notice.
- Slack API envelope failures are represented separately from successful API responses.
- A Slack channel `message` event that mentions the bot is suppressed because the corresponding
  `app_mention` path is authoritative.

## Constraints and Invariants

- Only supported image MIME types enter the attachment pipeline.
- Download URLs must use HTTPS and a `slack.com` host; external-mode files are excluded.
- The bot token is used to download private Slack files.
- Prompt JSON omits `attachments` when there are no uploaded references.
- A separately delivered channel-message event cannot recover an image omitted by the mention path
  because bot mentions are filtered from channel-trigger processing.

## Known Gaps and Risks

- A successful one-message lookup that does not contain the target timestamp is indistinguishable
  from a target message that contains no files.
- A text-bearing mention continues as text-only when lookup returns no candidate files, so the user
  receives no indication that an expected image was absent.
- A nonempty event `files` array wins over lookup files as a complete collection. Partial event file
  objects can therefore displace richer lookup objects.
- The event schema makes every field within a Slack file object optional. A file object without
  `mimetype` is silently ignored by image normalization; an otherwise supported image without a
  private URL is logged as an untrusted URL and ignored.
- Slack-bot integration coverage includes follow-up images carried by an event and follow-up images
  recovered through `conversations.replies`, but not a new top-level text-and-image mention.
- Shared-client coverage explicitly records the current not-found behavior as a successful empty
  result.
- The session-launcher image test mocks both image preparation and prompt delivery, so it verifies
  orchestration rather than the complete first-message path.

## Open Questions

- Production logs would show whether affected mentions have a successful empty history response, an
  API failure warning, partial event metadata, or a later download/upload failure.
- The repository does not establish what Slack returned for the affected production events, so the
  precise trigger among the observed loss paths remains an inference.

## Evidence

- `packages/slack-bot/src/events/payload.ts:20-40`: inbound Slack events accept optional file and
  attachment arrays.
- `packages/shared/src/slack/client.ts:552-562`: every retained Slack file field is optional.
- `packages/slack-bot/src/events/message-handler.ts:368-411`: event metadata precedence, message
  lookup, logging, and image normalization for mentions.
- `packages/shared/src/slack/client.ts:627-658`: top-level and reply lookup endpoints and successful
  empty return when the target timestamp is absent.
- `packages/slack-bot/src/attachments.ts:109-137`: MIME and trusted-URL filtering.
- `packages/slack-bot/src/events/message-handler.ts:176-218`: existing-session follow-up delivery.
- `packages/slack-bot/src/events/message-handler.ts:306-328`: new-session launch receives normalized
  images.
- `packages/slack-bot/src/sessions/session-launcher.ts:59-133`: initial image preparation, session
  creation, and shared prompt delivery.
- `packages/slack-bot/src/sessions/prompt-delivery.ts:47-90`: common upload-then-prompt sequence.
- `packages/slack-bot/src/sessions/control-plane-client.ts:121-145`: empty attachment references are
  omitted from prompt JSON.
- `packages/slack-bot/src/dm-utils.ts:75-95`: channel messages mentioning the bot are suppressed.
- `packages/sandbox-runtime/src/sandbox_runtime/attachment_processor.py:107-197`: stored session
  images become OpenCode file parts.
- `packages/slack-bot/src/index.test.ts:1078-1211`: follow-up image coverage.
- `packages/shared/src/slack/client.test.ts:825-909`: endpoint selection and successful-empty lookup
  coverage.
- `packages/slack-bot/src/sessions/session-launcher.test.ts:306-347`: mocked initial image
  orchestration coverage.
- `packages/slack-bot/src/routes/events.test.ts:123-158`: partial file metadata is accepted at the
  event boundary.

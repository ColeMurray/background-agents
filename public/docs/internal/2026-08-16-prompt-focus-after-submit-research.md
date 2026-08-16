# Research: Prompt focus after submission

**Date:** 2026-08-16 **Status:** Research only **Scope:** The web session prompt composer's focus
behavior during Command/Ctrl+Enter submission.

This document is intentionally research-only. It does not include recommendations, implementation
plans, proposed code/API/schema changes, task breakdowns, estimates, or rollout steps.

## Summary

Command/Ctrl+Enter uses the same asynchronous submission handler as the form. An accepted submission
immediately sets `isSubmitting` to `true`; the session page includes that state in `draftLocked`,
and the composer applies `draftLocked` to the textarea's native `disabled` attribute. Disabling the
focused textarea causes it to lose focus. The textarea remains mounted and is later re-enabled after
prompt acknowledgement, rejection, disconnection, or timeout, but the ordinary submission path
contains no focus-restoration operation.

The repository already restores textarea focus explicitly when a removed queued prompt is put back
into an empty composer. Other transient UI flows also return focus explicitly after their state
transition. Current composer tests do not exercise the keyboard submission flow, the `isSubmitting`
lock transition, or active-element behavior.

The behavior predates prompt queueing. Before queueing, users could type a follow-up while an agent
was processing, but the submit button and submission handler both prevented sending it. The queueing
change removed those processing restrictions while retaining the transient native textarea disable
around each accepted submission.

## Research Questions

1. How does Command/Ctrl+Enter reach prompt submission?
2. Which state and rendering changes occur while submission is pending?
3. Where does focus management already exist, and what coverage exists for this behavior?

## Current Behavior

`usePromptInput.handleKeyDown` handles Enter when either Meta or Control is pressed and Shift and
Alt are not pressed. It prevents the key event's default behavior and directly calls `handleSubmit`.
IME composition bypasses this shortcut.

`handleSubmit` rejects invalid or duplicate attempts before changing state. For an accepted
submission, it sets `submitInFlightRef.current` and `isSubmitting` before uploading attachments and
awaiting `sendPrompt`. The session page derives the composer lock from `!ready`, `isSubmitting`, or
attachment upload activity.

`SessionPromptComposer` passes that lock to the textarea as `disabled={prompt.draftLocked}`. The
textarea is not conditionally rendered or assigned a changing key. Its layout effect only updates
its height. The native disabled transition is therefore the focus-removing event.

`sendPrompt` remains pending while it waits for subscription readiness and a correlated
`prompt_queued` response. Its failure paths include rejection, disconnection, and timeout. The
submission handler's `finally` block clears `isSubmitting`, which re-enables the textarea, but no
call to `focus()` follows that transition.

On success, the prompt and attachment draft are cleared before the composer unlocks. On failure, the
draft remains and an inline error is displayed before the composer unlocks. Both outcomes leave the
textarea unfocused.

## Relevant Workflows

The form submit button and Command/Ctrl+Enter both enter `handleSubmit`. The shortcut itself does
not contain a blur operation and is not a separate state path.

The submission lock keeps prompt text, attachments, model selection, reasoning selection, and the
send action stable while attachment upload or server acknowledgement is pending. The textarea,
attachment controls, model controls, reasoning controls, and submit button all consume this lock.

The home-page composer has a parallel mechanism: creation state disables its textarea. Its normal
success path navigates to the newly created session, while a failed creation re-enables the same
textarea without an explicit focus transition.

## Historical Behavior

The session page and extracted composer were introduced together in commit `315347f`. In that
version, an accepted submission set `isSubmitting`, and `isSubmitting` contributed to `draftLocked`.
The composer applied `draftLocked` to the textarea's `disabled` attribute. This is the same
focus-removing transition present today.

Processing state was separate from the textarea lock. While the agent was processing:

- The textarea remained enabled and displayed `Type your next message...`.
- The send button was disabled by `prompt.isProcessing`.
- `handleSubmit` returned immediately when `isProcessing` was true, including for the keyboard
  shortcut.
- Model and reasoning controls were disabled by `prompt.isProcessing`.
- Entered follow-up text remained in the textarea with a `Waiting...` label until processing ended.

Commit `fc4aab1` introduced web follow-up queueing. It removed `isProcessing` from both the submit
button's disabled calculation and the `handleSubmit` guard. It also changed the processing-state
presentation to `Add a follow-up...` and a `Queue` action. The commit retained
`draftLocked: !ready || isSubmitting || sessionAttachments.isUploading` and retained
`disabled={prompt.draftLocked}` on the textarea.

The acknowledgement contract added by the same queueing change made the duration of `isSubmitting`
explicitly cover the correlated server response. The focus loss therefore began with the original
submission lock, while queueing changed the post-submit workflow from “type but wait to send” to
“type and queue another prompt.”

## Existing Patterns

`restoreQueuedPrompt` restores text only when the current composer and attachments are empty. It
then calls `input?.focus()`. This helper is invoked by the queued-prompt removal flow and has a unit
test that verifies focus.

The session details overlay explicitly focuses its close control when opened and returns focus to
the visible trigger when closed. The changes panel and combobox use deferred focus after newly
rendered UI becomes available. Session rename inputs use `autoFocus` or a deferred focus/select
operation.

These patterns make focus ownership explicit at state-transition boundaries. There is no equivalent
operation at the end of ordinary prompt submission.

## Constraints and Invariants

- The draft remains locked until attachment processing and the correlated server response finish.
- A native disabled textarea cannot remain the active element during the lock.
- Removing the disabled state does not itself return focus to the textarea.
- The same `handleSubmit` function serves keyboard and form submission.
- `inputRef` remains attached to the textarea across the submission state transition.
- Prompt acknowledgement can be delayed relative to the initiating keyboard event.
- Processing status no longer prevents follow-up submission; only the per-submission lock does.

## Known Gaps and Risks

The composer test harness supplies mocked submit and keydown handlers, so it cannot observe the real
shortcut or submission-state lifecycle. Existing tests cover disabled controls, processing
presentation, textarea resizing, and inline errors, but contain no active-element assertion for
submission.

Socket tests establish that prompt submission remains pending until acknowledgement, but do not
integrate that pending state with composer focus. There is no session-page or `usePromptInput` test
for focus after successful or failed submission.

Because `!ready` also contributes to `draftLocked`, readiness transitions can produce the same
native focus loss independently of an explicit submission.

## Open Questions

- Does the desired focus behavior cover unsuccessful submissions and attachment-upload failures as
  well as acknowledged submissions?
- Does the desired behavior apply when submission begins from the send button rather than the
  keyboard shortcut?
- During the acknowledgement interval, is continued draft editing expected, or only automatic focus
  return after the current lock ends?
- When session readiness is lost, is automatic focus return desirable after readiness recovers?

## Evidence

- `packages/web/src/app/(app)/session/[id]/page.tsx:732-809`: submission state lifecycle and
  Command/Ctrl+Enter handling.
- `packages/web/src/app/(app)/session/[id]/page.tsx:350-369`: `draftLocked` combines readiness,
  submission, and attachment-upload state.
- `packages/web/src/components/session-prompt-composer.tsx:53-87`: lock derivation and the
  resize-only textarea layout effect.
- `packages/web/src/components/session-prompt-composer.tsx:119-133`: persistent textarea rendering
  and native disabled binding.
- `packages/web/src/hooks/use-session-socket.ts:269-340`: prompt acknowledgement lifecycle.
- `packages/web/src/lib/restore-queued-prompt.ts:1-18`: existing explicit textarea focus restore.
- `packages/web/src/components/session-prompt-composer.test.tsx:39-174`: composer harness and
  current component-level coverage.
- Git history `315347f`, `fc4aab1`, and `acaeab6`: introduction of the submission lock, extension
  through acknowledgement, removal of the processing-time submission prohibition, and explicit focus
  restoration for removed queued prompts.

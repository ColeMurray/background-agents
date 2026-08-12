# Queued Web Prompts

## Status

Implemented

## Summary

The control plane already has a durable, per-session FIFO prompt queue. It accepts a prompt while
another prompt is processing, stores it as `pending`, and dispatches it after the current message
becomes terminal. The web application is the part that prevents this behavior: the composer and
submit handler both reject submission while `isProcessing` is true.

This design exposes the existing queue in the web chat. The first release will:

- allow a user to submit a follow-up while the current prompt is running;
- acknowledge only after the follow-up is durably stored;
- show authoritative running and queued states across tabs, participants, reconnects, and reloads;
- use a client-generated request ID to make acknowledgement retries idempotent;
- enforce a limit of 10 unfinished prompts per session;
- retain FIFO execution and existing model, reasoning, attachment, and author behavior;
- keep Stop scoped to the running prompt and make that scope explicit.

The first release will not support editing, reordering, or individually cancelling queued prompts.
Those operations require additional authorization, attachment lifecycle, conflict, and audit
semantics and are not necessary to solve the immediate inability to leave the chat after submitting
a follow-up.

## Research Questions

The design was informed by five parallel codebase investigations.

### 1. Where is prompt submission blocked, and what path does a prompt follow?

The web page sends a `prompt` message through `useSessionSocket`, waits for `prompt_queued`, and
only then clears the draft. The session Durable Object persists a `pending` message and a
`user_message` event before acknowledging it. The same queue later sends the ordinary prompt command
to the sandbox runtime.

Submission during active work is blocked only by web policy:

- `packages/web/src/components/session-prompt-composer.tsx` includes `isProcessing` in
  `sendDisabled` and displays "Waiting...".
- `packages/web/src/app/(app)/session/[id]/page.tsx` returns from `handleSubmit` when `isProcessing`
  is true.

The control plane does not reject a prompt because another message is processing.

### 2. What can be reused from parent-to-child queued messaging?

Parent-to-child follow-ups reuse the child's ordinary Durable Object message queue. They persist
before acknowledging, leave active work uninterrupted, restore a sandbox if needed, and dispatch the
next prompt after completion. This validates the core architecture for queued follow-ups.

Reusable principles are:

- one queue and execution path for every prompt source;
- persistence before acknowledgement;
- explicit promptability checks at the authoritative Durable Object;
- bounded unfinished work;
- completion-driven FIFO draining;
- separate acceptance from eventual result retrieval.

Child-specific lineage checks, admission leases, forced child-owner attribution, and the restricted
content-only request do not apply to same-session web prompts.

### 3. What is the authoritative lifecycle and concurrency model?

Each session Durable Object and its SQLite database are authoritative. Session status is not a busy
lock. A session can be `active` without processing a prompt, while `completed` and `failed` sessions
can accept a new prompt. The relevant message states are:

```text
pending -> processing -> completed | failed
```

The queue may dispatch when the session is promptable, no message is `processing`, a `pending`
message exists, and a sandbox WebSocket is connected. If no sandbox is connected, the message stays
pending while the sandbox is spawned or restored.

The authoritative turn boundary is a matching `execution_complete` event. The control plane marks
the current message terminal and calls `processMessageQueue()` to start the next pending message.

### 4. What web state and UX must change?

The textarea already remains editable during processing, but Send and the model controls are
disabled. User messages are not optimistically inserted; the server-broadcast persisted
`user_message` event supplies the canonical timeline entry. Reconnect restores timeline and
`isProcessing`, but the snapshot does not expose pending queue entries or positions.

The minimum usable behavior is to enable Send during processing and label it Queue. A durable and
honest experience also needs queue state in the session snapshot so that the UI does not lose status
on reload or show different state in another tab.

### 5. What persistence, security, testing, and deployment work is needed?

Prompt bodies should remain in session Durable Object SQLite; D1 is not needed for queue
correctness. The current acknowledgement has no request correlation, so a lost acknowledgement can
leave a persisted user message while the draft remains available for accidental resubmission.
Idempotent enqueue addresses that ambiguity.

The feature also needs a server-side queue limit, consistent prompt validation, participant-aware
authorization under the product's chosen session visibility policy, structured queue telemetry, and
tests covering active enqueue, FIFO dispatch, reconnect, acknowledgement loss, and limits.

## Current Architecture

### Prompt acceptance

The web client sends:

```ts
{
  type: "prompt",
  content,
  model?,
  reasoningEffort?,
  attachments?,
}
```

`SessionMessageQueue.handlePromptMessage()` resolves the participant and calls the common enqueue
core with source `web`. Enqueue atomically claims attachments and inserts a message with status
`pending`, transitions the session to `active`, stores and broadcasts a `user_message`, and returns
a message ID and queue position. The originating socket receives:

```ts
{
  type: "prompt_queued",
  messageId,
  position,
}
```

The client correlates this acknowledgement to the submitted draft and returns a structured result.

### Dispatch

`processMessageQueue()` returns if another message is `processing`. Otherwise it selects the oldest
pending message by `created_at, rowid`, marks it processing, and sends it to the connected sandbox.
Completion terminalizes the message and invokes queue processing again.

### Synchronization

ADR 0003 establishes the session Durable Object's canonical snapshot as the synchronization source
of truth. Every subscribe or reconnect receives an authoritative snapshot followed by semantic live
messages. Queue UI state should follow that model rather than introduce a separate retained delta
log or reconstruct queue state from timeline events.

## Goals

- Let a user durably submit one or more follow-ups while the agent is running and then leave the
  page.
- Preserve strict per-session FIFO execution and the one-processing-message invariant.
- Make acceptance, running state, and queued state understandable in the chat.
- Converge correctly after reload, reconnect, multiple tabs, and multiple participants.
- Avoid duplicate prompts when acknowledgement delivery is ambiguous.
- Preserve per-prompt author, model, reasoning effort, and attachment settings.
- Keep the current prompt execution and sandbox protocol unchanged.
- Bound queue growth and expose useful operational signals.

## Non-Goals

- Parallel execution of prompts within one session.
- Interrupting the current prompt when a follow-up is queued.
- Editing or reordering queued prompts in the first release.
- Individually cancelling queued prompts in the first release.
- Persisting unsent local drafts across reloads.
- Projecting prompt content or the full queue into D1.
- Changing parent-to-child follow-up semantics.
- Adding sandbox command acknowledgement or general execution retry in this feature. Those are
  related reliability improvements but are not required to expose already-supported queueing.

## Proposed Design

### 1. Keep the existing Durable Object queue

There will be no second queue and no new data-plane command. Web, HTTP integration, and child
follow-up prompts continue to create ordinary message rows and use the same FIFO dispatcher. The
session Durable Object remains the only authority for promptability, queue ordering, and current
processing state.

The relevant predicates remain separate:

```text
canAcceptPrompt = session.status in {created, active, completed, failed}
hasRunningPrompt = a message has status processing
hasQueuedPrompts = one or more messages have status pending
```

The web must not use `isProcessing` as an admission predicate.

### 2. Add idempotent, correlated submission

Extend the web prompt message with a required client-generated UUID for new web clients:

```ts
{
  type: "prompt",
  clientRequestId: string,
  content: string,
  model?: string,
  reasoningEffort?: ReasoningEffort,
  attachments?: PromptAttachmentReference[],
}
```

Echo it in the acknowledgement:

```ts
{
  type: "prompt_queued",
  clientRequestId?: string,
  messageId: string,
  position: number,
}
```

`clientRequestId` is initially optional in the server acknowledgement for rolling compatibility with
old queued messages and clients, but the updated web client requires it for its own requests.

Add nullable `client_request_id` and `request_fingerprint` columns to the Durable Object `messages`
table, with a unique partial index on `client_request_id`. Since a Durable Object stores one
session, the key is already session-scoped. The fingerprint is a SHA-256 digest of the participant
identity and canonical prompt payload: content, model, reasoning effort, and ordered attachment IDs.

Enqueue behavior becomes:

1. Look up `clientRequestId` before claiming attachments.
2. If it belongs to the same participant and has the same fingerprint, return the existing message
   ID and its current derived position without writing another event.
3. If it belongs to another participant or the payload differs, reject with a conflict error.
4. Otherwise claim attachments and create the message and user event once.

The client retains the same request ID when retrying an acknowledgement timeout or reconnect. This
eliminates the current accepted-but-unacknowledged duplicate risk.

Compatibility requirements:

- Existing WebSocket clients may omit `clientRequestId`; those requests retain current
  non-idempotent behavior during rollout.
- Existing HTTP and bot callers are unchanged by this release.
- The server must not silently retry through a second transport without the same request ID.

### 3. Expose an authoritative queue summary

Add a bounded `promptQueue` field to the canonical session snapshot. It contains unfinished prompts
only, ordered with the processing message first and pending messages in FIFO order:

```ts
type PromptQueueItem = {
  messageId: string;
  content: string;
  status: "pending" | "processing";
};
```

The projection intentionally contains only the fields needed to join timeline messages, render a
fallback when the original event is outside replay, and display running/queued state. The queued
message still preserves its author, attachments, model, and reasoning settings for execution.

Queue entries are bounded by the same server-side unfinished-prompt limit, so including them in the
snapshot does not create unbounded reconnect payloads.

For live convergence, add a `prompt_queue_updated` server message carrying the complete bounded
unfinished queue. The Durable Object broadcasts it after queue-affecting transitions:

- successful first-time enqueue;
- pending to processing;
- processing to completed or failed;
- session cancellation terminalizes unfinished prompts;
- any future individual queued-prompt cancellation.

Sending the complete small queue avoids client-side position arithmetic and follows ADR 0003's
preference for a narrow semantic message over a retained revision log. A full snapshot remains
authoritative on reconnect.

Queue updates use capability negotiation because clients validate a strict server-message union.
Updated clients include `prompt_queue_updates` in the subscribe message, and the control plane emits
the new message only to those clients. The capability is persisted in `ws_client_mapping` so it
survives Durable Object hibernation. Separately, the control plane advertises
`correlated_prompt_enqueue` in the subscribed response when it supports idempotent request IDs and
correlated acknowledgements. The updated web requires that server capability before enabling prompt
submission; `prompt_queue_updates` does not imply enqueue support. Snapshot `promptQueue` defaults
to an empty list when absent so the updated web can connect read-only to an older control plane
during rollout.

An alternative is to add queue data only to `subscribed` for the first release and derive live
changes from known prompt and completion events, but that leaves multiplayer and some failure
transitions stale. An explicit queue update is preferred.

### 4. Bound and validate queued work

Introduce shared named constants for:

- maximum web prompt characters;
- maximum unfinished prompts per session, set to 10.

The unfinished count includes `pending` and `processing`, matching parent-to-child queue semantics.
There is no separate per-user limit in the first release. The implementation must define the session
limit once and not duplicate the literal across packages. A full queue is rejected before attachment
claims and message creation with a stable error code such as `PROMPT_QUEUE_FULL` and retryable
status semantics.

Use one shared strict web prompt schema across WebSocket and HTTP boundaries. It must reject
whitespace-only content when no attachments are present and preserve attachment-only prompts. The
existing model, reasoning, and attachment validation remains intact.

Queue limits must be enforced server-side. Composer disablement is advisory because bots, direct API
callers, and concurrent tabs bypass it.

### 5. Preserve the current authorization model

WebSocket subscription already yields an authenticated participant used for prompt attribution.
Queued prompts continue to derive author identity from that socket; the body cannot select an author
or source.

Retain the existing authenticated collaboration behavior: an authenticated tenant user who can
access a known session may become a participant and submit prompts. Private-session membership and
invitations are outside this feature. The server-side session queue limit and existing attribution
provide the initial abuse controls; telemetry should inform whether a later per-user or rate limit
is needed.

### 6. Update the composer behavior

The composer remains usable while a prompt is processing.

Required changes:

- remove `isProcessing` from `sendDisabled`;
- remove `isProcessing` from the page submit guard;
- allow model and reasoning selection for the queued prompt while another prompt runs;
- retain locking while attachments upload and while the current submission awaits its matching
  durable acknowledgement;
- change the processing-state action label and title from Wait to Queue;
- use copy such as "Add a follow-up..." and "Runs after the current prompt";
- keep Stop visible and label/help text clear that it affects only the running prompt;
- disable prompt submission for `archived` and `cancelled` sessions using shared promptability
  semantics;
- show an inline submission error while retaining the draft and attachments on rejection.

The client may continue allowing only one unacknowledged submission from a composer at a time. Once
the matching `prompt_queued` arrives, it clears and unlocks immediately, allowing another follow-up
to be queued. This solves the user need without introducing a local multi-draft outbox.

`sendPrompt` should return a structured result instead of `boolean`:

```ts
type QueuePromptResult =
  | { ok: true; clientRequestId: string; messageId: string; position: number | null }
  | { ok: false; reason: "rejected" | "disconnected" | "timeout"; message?: string };
```

The page clears the draft only for `ok: true`. On timeout, it retains the request ID and uploaded
attachment references while the page remains mounted, so a retry deduplicates instead of creating a
second prompt. A retry after the prompt has already completed returns `position: null` because it is
no longer in the unfinished queue. Persisting unsent drafts across a full reload remains a non-goal.

### 7. Display pending prompts above the composer

The persisted `user_message` event remains the canonical chat entry; do not add a second optimistic
user bubble. While its authoritative `promptQueue` item has `pending` status, hide that event from
the timeline and render the projection in a FIFO stack directly above the composer. When its status
changes to `processing`, remove it from the stack and reveal the ordinary timeline message without a
running-status label.

The stack contains only pending prompts, is bounded and scrollable, and preserves queue order. It
also renders pending prompts whose canonical event is outside the bounded initial replay. Queue
changes do not trigger timeline scrolling because the stack is outside the timeline scroll region.

The first release does not include individual queue management actions. A future responsive Queue
sheet can be added if those actions are introduced.

### 8. Preserve stop, cancel, archive, and terminal semantics

The first release keeps existing backend semantics:

- Stop fails/stops only the current processing prompt and then continues with the next pending
  prompt.
- Cancel session terminalizes the current and all pending prompts and prevents new prompts.
- Archive is rejected while unfinished work exists.
- Completed and failed sessions accept a new prompt and transition to active.

The UI must explain the first rule because users may otherwise expect Stop to clear the queue. The
control plane must advance the queue deterministically after the current prompt is confirmed stopped
rather than relying on an incidental late sandbox event. A separate "Cancel queued prompts" action
is deferred until individual/bulk queue cancellation has a defined status, authorization policy, and
audit representation.

Stop confirmation state uses a nullable `stop_confirmation_deadline` column on the processing
message. It must not be encoded in `error_message`: stopping may fail the message with a
human-readable error while independently awaiting sandbox confirmation, so `error_message` remains
preserved for history and diagnostics.

## Data Model Changes

Append a new immutable Durable Object schema migration and update the fresh schema in
`packages/control-plane/src/session/schema.ts`:

```sql
ALTER TABLE messages ADD COLUMN client_request_id TEXT;
ALTER TABLE messages ADD COLUMN request_fingerprint TEXT;
ALTER TABLE messages ADD COLUMN stop_confirmation_deadline INTEGER;

CREATE UNIQUE INDEX idx_messages_client_request_id
ON messages(client_request_id)
WHERE client_request_id IS NOT NULL;
```

The repository message type and create/read methods gain these fields. The public historical message
API does not need to expose either field.

No D1 migration is required. If the dashboard later needs a queue count without opening the session
Durable Object, add an eventually consistent D1 summary in a separate change; never use it for queue
admission or dispatch.

## Protocol Changes

### Client to server

- Add optional `clientRequestId` to the shared WebSocket prompt schema for rollout.
- Updated web clients always send it.
- Validate it as a UUID or bounded opaque identifier.
- Updated clients advertise the `prompt_queue_updates` subscribe capability.

### Server to client

- Add optional `clientRequestId` to `prompt_queued` for rollout.
- Advertise `correlated_prompt_enqueue` in the subscribed response when request correlation is
  supported.
- Add `promptQueue` to the session snapshot/subscribed contract with an empty default for rollout.
- Add `prompt_queue_updated` with the full bounded unfinished queue.
- Add stable prompt rejection error codes, including queue full, request conflict, invalid prompt,
  and session not promptable.

The acknowledgement remains origin-only. Queue updates are broadcast to authenticated session
clients.

## Failure Handling

### Lost acknowledgement

The client retains the draft and request ID. On reconnect or explicit retry, resubmission returns
the existing message and does not duplicate the timeline event or attachment claims.

### Socket disconnect after enqueue

The prompt remains durable. On reconnect, `promptQueue` and the persisted user event restore the
accepted state. If the acknowledgement was lost, an idempotent retry resolves ambiguity.

### Queue full

The server rejects before mutation. The composer retains the draft and displays the queue limit
error. It may re-enable after an authoritative queue update removes an item.

### Sandbox unavailable

The prompt remains pending and visible while existing lifecycle logic spawns or restores the
sandbox. `isProcessing` may be false in this state, so the queue UI must use prompt queue state
rather than infer emptiness from `isProcessing`.

### Dispatch send failure

The existing control plane marks a message processing before sending and can leave it processing
until timeout if the synchronous WebSocket send fails. This is an existing reliability weakness. The
queued web prompt implementation should at least requeue a message when send definitively returns
false and clear its processing timestamp, with tests proving later queue items are not blocked by a
known-unsent message.

A full `dispatching` state, sandbox receipt acknowledgement, attempt IDs, and retry protocol are
valuable follow-up work but require compatible sandbox-runtime rollout and duplicate-execution
protection. They are outside this feature's scope.

## Observability

Extend structured prompt lifecycle logs without logging prompt content:

- `prompt.enqueue`: source, content length, queue depth before/after, returned position,
  deduplicated flag, outcome, and rejection reason;
- `prompt.dispatch`: queue wait duration, remaining depth, sandbox availability, and send result;
- `prompt.complete`: existing execution duration plus queue depth remaining;
- `prompt.queue_rejected`: queue depth, configured limit, source, and stable reason;
- `prompt.idempotency_conflict`: hashed/truncated request identifier and conflict category.

Track queue depth, oldest pending age, enqueue-to-dispatch latency, queue-full rejection rate,
deduplication rate, known send failures, and messages stuck processing. Do not log content,
attachment payloads, credentials, callback context, or full client request IDs.

## Testing Strategy

### Shared

- prompt schema accepts valid content, attachments, model, reasoning, and request ID;
- blank and oversized prompts are rejected consistently;
- new snapshot, acknowledgement, queue item, and queue-update messages parse;
- compatibility cases without optional request IDs still parse during rollout.
- subscribed responses parse the server-advertised `correlated_prompt_enqueue` capability.

### Control plane unit

- enqueue behind a processing prompt creates a pending row and reports position;
- equal timestamps preserve FIFO through the existing row ID tie-breaker;
- duplicate request ID and identical payload returns one message and one user event;
- duplicate request ID with another author or payload returns conflict;
- duplicate attachment request does not reclaim or duplicate attachments;
- queue depth is enforced before mutation under concurrent requests;
- queue updates broadcast after enqueue, dispatch, completion, and cancellation;
- a definitive sandbox send failure requeues rather than strands the message;
- a confirmed stop dispatches the next pending prompt exactly once;
- stop confirmation deadlines are stored separately without overwriting `error_message`;
- archived and cancelled sessions reject before participant/message mutation.

### Control plane integration

- prompt one processes while prompts two and three are accepted and persist pending;
- successive completion events dispatch two and three in FIFO order exactly once;
- reconnect snapshot contains the authoritative unfinished queue;
- a lost-ack retry with the same request ID does not duplicate work;
- two clients see the same queue updates;
- pending work survives Durable Object hibernation and sandbox reconnect;
- completed/failed sessions resume, while cancelled/archived sessions reject;
- stop affects the processing prompt and preserves the pending queue;
- session cancellation terminalizes all unfinished prompts;
- queue limits and authorization policy hold under concurrent requests.

### Web

- the composer Send/Queue action remains enabled while `isProcessing`;
- model/reasoning controls remain editable for a queued prompt;
- one submission is locked only until its matching acknowledgement;
- acknowledgement correlation ignores unrelated server errors and out-of-order messages;
- success clears the draft and attachments; rejection retains them and displays an error;
- timeout retry reuses the request ID;
- snapshot and live queue updates decorate the correct user messages;
- reload and reconnect restore running/queued state;
- archived/cancelled sessions cannot submit;
- mobile composer layout remains usable with Queue and Stop visible.

### Regression

Run shared build first, then control-plane and web typechecks/tests. Run bot tests if shared prompt
or response contracts change, and sandbox-runtime tests only if prompt command behavior is modified.

## Rollout Plan

### Phase 1: protocol and persistence

- Add shared optional request correlation and queue contracts.
- Add the Durable Object migration and idempotent repository/enqueue behavior.
- Add queue bounds, validation, queue snapshots, capability-gated broadcasts, and telemetry.
- Keep the existing web processing gate in place.

### Phase 2: compatible web client

- Deploy a web client that understands queue snapshots/updates, advertises the queue capability, and
  sends client request IDs only when the server advertises `correlated_prompt_enqueue`.
- Render queue status but keep submission disabled until the server advertises
  `correlated_prompt_enqueue`.

### Phase 3: enable queue submission

- Remove the web `isProcessing` submit gates.
- Change composer copy and surface acknowledgement/rejection states.
- Monitor queue depth, wait time, deduplication, rejection, and stuck-processing metrics.

### Phase 4: cleanup and follow-ups

- Make request correlation required after old clients have aged out, if desired.
- Evaluate individual queued-prompt cancellation based on usage.
- Evaluate a Queue sheet only if users need management beyond timeline status.
- Address sandbox dispatch acknowledgement separately if reliability metrics justify it.

## Likely Files

### Shared

- `packages/shared/src/types/websocket.ts`
- `packages/shared/src/types/server-messages.ts`
- `packages/shared/src/types/sessions.ts`
- shared boundary and protocol tests

### Control plane

- `packages/control-plane/src/session/schema.ts`
- `packages/control-plane/src/session/types.ts`
- `packages/control-plane/src/session/repository.ts`
- `packages/control-plane/src/session/message-queue.ts`
- `packages/control-plane/src/session/durable-object.ts`
- `packages/control-plane/src/session/sandbox-events.ts`
- queue, schema, repository, WebSocket, lifecycle, and integration tests

### Web

- `packages/web/src/app/(app)/session/[id]/page.tsx`
- `packages/web/src/components/session-prompt-composer.tsx`
- `packages/web/src/components/session-timeline.tsx`
- `packages/web/src/hooks/use-session-socket.ts`
- `packages/web/src/lib/session-socket/reducer.ts`
- corresponding component, hook, and reducer tests

## Deferred Queue Management

Individual cancellation should be the first management capability considered after launch. It must
atomically transition only a `pending` message, race safely with dispatch, recompute queue state,
reconcile session status, and enforce author/owner permissions. A true `cancelled` message status is
preferable but affects shared schemas, callbacks, history rendering, and compatibility.

Editing is more complex because the message row and persisted `user_message` event must change
atomically, attachment claims need add/remove behavior, model fields need exposure, and concurrent
tabs need conflict detection. Reordering additionally requires a durable sequence and conflict
semantics. Neither should be included in the initial queued-send feature.

## Product Decisions

1. A session may have at most 10 unfinished prompts, including the processing prompt. There is no
   separate per-user limit initially.
2. The feature preserves the current authenticated tenant-wide collaboration model. Private session
   membership is a separate product decision.
3. Queue cards show only running/queued state and position. They do not display model or reasoning
   effort, although each queued prompt preserves those execution settings.
4. Stop affects only the processing prompt. After that prompt is confirmed stopped, the next queued
   prompt starts automatically. Session cancellation remains the operation that terminalizes all
   unfinished prompts.

## Acceptance Criteria

- While a prompt is running, a user can submit a follow-up and receive durable confirmation without
  waiting for the running prompt to finish.
- The user can close or reload the page and later see the follow-up as queued or completed.
- Multiple queued prompts execute once each in FIFO order.
- A lost acknowledgement and retry do not create a duplicate prompt.
- All connected participants converge on the same running and queued state.
- The composer clearly distinguishes Queue from Stop and retains the draft on rejection.
- Queue limits and non-promptable session statuses are enforced by the control plane.
- Existing web, bot, parent-to-child, attachment, sandbox restoration, stop, cancellation, and
  completion flows remain compatible.

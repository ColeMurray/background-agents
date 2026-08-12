# Task Activity Nesting

## Problem

OpenCode Task tool calls and the tools executed by their child sessions currently appear as
unrelated rows in the session timeline. This makes concurrent or tool-heavy tasks difficult to
follow and can also cause parent and child calls with the same `callId` to overwrite each other in
the web client's deduplication pass.

The sandbox runtime already detects direct OpenCode child sessions and marks their events with
`isSubtask`. However, `tool_call` and `error` do not declare that field in the shared event schema,
so Zod removes it at the control-plane boundary. The runtime also consumes, but does not forward,
the Task part's `state.metadata.sessionId`, leaving the UI without a reliable Task-to-child
correlation key.

Chronological inference is not sufficient. Parent tools and parallel Tasks may interleave, and a
resumed Task may reuse an existing child session.

## Scope

This change nests activity from direct OpenCode child sessions beneath the Task tool call that owns
the child session. It covers child tool calls and child errors, which are the child activity
currently forwarded to the session event stream. Child text remains intentionally suppressed by the
runtime, and grandchildren remain outside the current direct-child streaming scope.

No database migration is required because session event payloads are stored as JSON.

## Event Contract

Add these optional fields to subtask-capable shared event variants:

- `isSubtask`: distinguishes child-session activity from parent-session activity.
- `childSessionId`: identifies the OpenCode child session and scopes child tool-call identity.
- `taskCallId`: identifies the parent Task tool invocation that owns the child activity.

The parent Task `tool_call` carries `childSessionId` when OpenCode supplies
`state.metadata.sessionId`. Child tool, step, and error events carry `childSessionId` and
`taskCallId` after the runtime observes the Task metadata. Only `taskCallId` defines ownership;
`childSessionId` scopes child tool identity and supports diagnostics, but cannot identify an
invocation because resumed Tasks reuse sessions.

All fields are optional so historical events continue to parse and render unchanged.

## Runtime Changes

1. Track the relationship in both directions for each prompt: `childSessionId -> taskCallId` and
   `taskCallId -> childSessionId`.
2. Record the relationship whenever a parent Task part includes `state.metadata.sessionId`,
   including resumed `task_id` calls.
3. Add `childSessionId` to the parent Task event, retaining it on later snapshots even if a snapshot
   omits metadata.
4. Buffer child tools, steps, and errors until Task metadata establishes ownership, then release
   them with both correlation fields. If metadata never arrives, flush them with `childSessionId`
   and `isSubtask` at prompt completion so they remain visible inline rather than being dropped.
5. Re-emit a same-status Task snapshot when correlation metadata first appears, making relationship
   discovery observable even when an earlier snapshot had no metadata.
6. Clear the active child-to-Task relation when the Task terminates, but retain the completed owner
   for delayed child events. Replace that completed owner when a later resume begins so new activity
   cannot inherit stale ownership.

## Control-Plane Persistence

Persist every tool snapshot through a deterministic upsert keyed by message, parent/child scope, and
`callId`. Updates replace event data while preserving the first `created_at`. This gives live and
replayed timelines the same Task invocation order while retaining only the latest tool state. It
also removes the need for the UI to synthesize a Task position from child completion order. Events
also receive a monotonic `timeline_sequence`, used as the pagination and replay tie-breaker when
multiple events share the same millisecond.

## Web Grouping

The timeline grouping pass will:

1. Deduplicate parent tools by `callId` and child tools by `(childSessionId, callId)` so
   session-scoped ID collisions do not remove events.
2. Index Task events by `(messageId, callId)`.
3. Associate child events only through `(messageId, taskCallId)`.
4. Keep each Task at its own stable persisted position.
5. Apply the existing consecutive same-tool grouping inside each Task.
6. Render Task groups expanded initially, with a left guide and nested activity. Users can collapse
   a Task to reduce noise or expand its existing arguments/output details.

Legacy and malformed correlations degrade safely: an event without a matching Task remains in the
normal top-level flow.

## Testing

- Shared schema test: correlation fields survive parsing on Task, child tool, and child error
  events.
- Runtime tests: parent Task and child tool/error events carry both IDs, including metadata
  discovered before or after `session.created` and repeated Task snapshots.
- Timeline grouping tests: child events nest under the correct Task, parallel/interleaved Tasks
  remain separate, orphan activity remains top-level, replay ordering is stable, and parent/child
  `callId` collisions are retained.
- Component test: Task activity renders beneath an expandable Task row.
- Run shared build first, then focused shared, sandbox-runtime, and web tests plus TypeScript and
  Python lint/type checks for touched packages.

## Rollout And Compatibility

The control plane validates, broadcasts, and replays the shared event shape, and now upserts tool
snapshots without moving their original timeline positions. Older runtimes produce events without
the optional fields and continue to render inline. New runtimes used with an older control plane
will have unknown fields stripped, preserving the current behavior until the shared/control-plane
deployment is updated.

## Out Of Scope

- Forwarding child assistant text.
- Recursively streaming or rendering grandchildren.
- Backfilling correlations into historical persisted events.
- Changing the separate control-plane child-session tree used for spawned coding sessions.

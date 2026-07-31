# Parent-to-Child Follow-Up Prompts

## Status

Proposed implementation plan.

## Goal

Give a parent agent a tool that can send another prompt to one of its existing child sessions. The
follow-up must enter the child's normal durable prompt queue so that it preserves the child's
conversation and workspace, queues safely behind current work, and restores an idle child sandbox
from a compatible snapshot when necessary.

This capability is for steering an existing child. It should not create a new child, grant the
parent direct access to the child's sandbox credential, or introduce a second agent transport.

## Current Architecture

### Session state and prompt execution

Each Open-Inspect session has two persistence boundaries:

| Boundary                      | Responsibility                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| D1 `sessions` index           | Cross-session discovery, parent/child lineage, projected status, settings, and metrics                         |
| Session Durable Object SQLite | Authoritative session aggregate, participants, messages, events, artifacts, sandbox state, and WebSocket state |

All existing prompt entry points eventually call `SessionMessageQueue.enqueuePromptCore()` in
`packages/control-plane/src/session/message-queue.ts`. Enqueueing a prompt:

1. Persists a `pending` message and its `user_message` event.
2. Transitions the session to `active`.
3. Dispatches immediately if a sandbox is connected and no message is processing.
4. Leaves the prompt pending and asynchronously spawns or restores a sandbox otherwise.
5. Processes multiple prompts one at a time, ordered by creation time.

`getNextPendingMessage()` currently orders only by millisecond `created_at`. The implementation
should add a stable insertion-order tie-breaker so the FIFO guarantee also holds for prompts created
in the same millisecond.

The sandbox bridge receives the normal `prompt` command over its existing WebSocket and submits it
to the existing OpenCode session. No Modal or bridge protocol change is needed for a parent
follow-up.

### Child session creation and control

`spawn-child` calls `POST /sessions/:parentId/children` with the parent's session-specific sandbox
token. `handleSpawnChild()` in `packages/control-plane/src/routes/session-child-spawn.ts` creates a
separate indexed session and Durable Object, records `parent_session_id`, copies the owner's
identity and SCM credentials, and enqueues the initial prompt with source `agent`.

The parent currently has three child operations:

| Tool               | Parent-scoped API                                   |
| ------------------ | --------------------------------------------------- |
| `spawn-child`      | `POST /sessions/:parentId/children`                 |
| `get-child-status` | `GET /sessions/:parentId/children[/:childId]`       |
| `cancel-child`     | `POST /sessions/:parentId/children/:childId/cancel` |

`SessionIndexStore.isChildOf()` verifies direct lineage for child detail and cancellation. Child
status transitions are projected back to D1 and broadcast to the parent Durable Object as
`child_session_update` messages.

### Missing capability

The ordinary `POST /sessions/:childId/prompt` route cannot be called by the parent sandbox:

- The parent's sandbox token is scoped to the parent session ID.
- The ordinary prompt route does not accept sandbox authentication.
- Giving the parent the child's token would break session credential isolation.
- No parent-scoped child prompt route or installed tool exists.

## Proposed Interface

### Agent tool

Add an installed OpenCode tool named `send-child-prompt`:

```ts
{
  childId: string;
  prompt: string;
}
```

The tool description must make these semantics explicit:

- `childId` must identify a direct child created by the current session.
- The prompt is queued after any currently running or pending child prompts; it does not interrupt
  the active turn.
- A completed or failed child can be resumed.
- A cancelled or archived child cannot be resumed through this tool.
- The child continues independently, and the parent uses `get-child-status` when it needs the new
  result.

The tool calls the control plane through the existing `bridgeFetch()` helper:

```text
POST /sessions/:parentId/children/:childId/prompt
Authorization: Bearer <parent sandbox token>
Content-Type: application/json

{"content":"..."}
```

On success it returns the child ID, queued message ID, and a statement that the prompt was queued. A
successful response means the message is durable, not that execution has started or finished.

### Shared HTTP contract

Add a strict request schema in `packages/shared/src/types/session-api.ts`:

```ts
const childFollowUpPromptRequestSchema = z.strictObject({
  content: z.string().min(1).max(MAX_CHILD_FOLLOW_UP_PROMPT_CHARS),
});
```

The final schema should also reject whitespace-only content without altering meaningful prompt
whitespace. Define `MAX_CHILD_FOLLOW_UP_PROMPT_CHARS` once in shared; v1 should use a 64,000
character limit. Reuse `sendPromptResponseSchema` for the response:

```ts
{
  messageId: string;
  status?: "queued";
}
```

Do not reuse the full `sendPromptRequestSchema`. Parent follow-ups must not accept caller-controlled
`source`, callbacks, attachment references, or identity fields. Per-message model and reasoning
overrides are also omitted from v1; the child keeps its configured model behavior.

### Control-plane route

Add:

```text
POST /sessions/:parentId/children/:childId/prompt
```

This route should be sandbox-auth-only, not merely sandbox-auth-capable. The router must validate
the bearer token against `parentId`, producing a sandbox principal for that exact parent. A browser
or service that wants to prompt the child can continue using the ordinary child session prompt route
with its own verified identity. Open-Inspect is currently single-tenant: ordinary authenticated
users and services are not subject to per-session ownership authorization. This new route narrows
the authority of a sandbox token; it does not introduce a broader session ACL model.

The endpoint is SCM-independent and must be included in `isScmAgnosticRoute()` so GitLab deployments
do not reject it with `501` before route handling.

The route flow is:

1. Parse the strict shared request schema.
2. Verify `SessionIndexStore.isChildOf(childId, parentId)` and return `404` for a mismatch.
3. Forward `{ parentSessionId: parentId, content }` to a dedicated internal endpoint on the child
   Durable Object.
4. Return the child's standard queued-prompt response.
5. Best-effort touch the child's D1 `updated_at`, matching the ordinary prompt route.

Use direct-child semantics, consistent with child detail and cancellation. Do not allow a parent to
address arbitrary descendants in v1.

### Child Durable Object ingress

Add a dedicated internal endpoint such as:

```text
POST /internal/parent-prompt
```

Do not have the public route call `/internal/prompt` with a body-derived author. The child endpoint
should own the security-sensitive and lifecycle-sensitive decisions:

1. Parse a control-plane-local strict contract containing `parentSessionId` and `content`.
2. Read the authoritative child session row from Durable Object SQLite.
3. Confirm its `parent_session_id` equals the supplied parent ID. Return `404` on mismatch. This is
   defense in depth against D1 drift or an incorrect router call.
4. Reject `cancelled` and `archived` sessions with `409`.
5. Find the child's `owner` participant locally. Return a server error if the invariant is broken.
6. Reject with `429` when the child already has 10 pending or processing prompts.
7. For a `completed` or `failed` child, apply the existing direct-child concurrent limit before
   reactivation, excluding this child from the count.
8. Enqueue through the existing message service/queue with the owner's `user_id`, canonical user ID,
   and source `agent`.

Resolving the owner inside the child avoids returning the broad `SpawnContext`, which includes
encrypted SCM credentials, merely to recover prompt attribution. It also keeps the status check and
message insertion in the authoritative session aggregate.

The queue limit is intentionally local and small. Define the value once as a named control-plane
constant. It bounds persistent storage and future model executions available to a compromised or
looping parent sandbox without requiring a new distributed rate-limiting service.

### Prompt lifecycle hardening

The current generic queue can reactivate a cancelled or archived session because every enqueue
unconditionally transitions to `active`. The new child endpoint cannot safely promise terminal-state
behavior unless the queue and lifecycle handlers enforce the same invariant.

As part of this feature:

1. Make `SessionMessageQueue.enqueuePromptCore()` reject `cancelled` and `archived` sessions with a
   typed error before inserting a message. Map that error to `409` in HTTP and WebSocket handlers.
2. Make `processMessageQueue()` refuse to dispatch while the session is `cancelled` or `archived`.
   This is a defense-in-depth check for lifecycle races.
3. Make cancellation fail pending messages as well as the processing message before setting the
   session to `cancelled`.
4. Make archival return `409` while messages are pending or processing. An enqueue that wins the
   race becomes visible before its first asynchronous status projection; an archive that wins sets
   local status before the promptability check.
5. Make unarchive valid only from `archived`, preventing it from reviving a cancelled session.

These are general prompt-lifecycle corrections rather than special cases in the parent route. They
keep ordinary API, WebSocket, automation, and parent follow-up behavior consistent.

## Lifecycle Semantics

| Child state | Follow-up behavior                                                                          |
| ----------- | ------------------------------------------------------------------------------------------- |
| `created`   | Accept and append after the initial prompt if it is still pending                           |
| `active`    | Accept and append to the existing FIFO queue                                                |
| `completed` | Accept, transition to `active`, and restore/spawn the sandbox through the normal queue path |
| `failed`    | Accept, transition to `active`, and allow the parent to provide recovery instructions       |
| `cancelled` | Reject with `409`; cancellation remains terminal                                            |
| `archived`  | Reject with `409`; explicit unarchive is required through normal session management         |

The child Durable Object, rather than the D1 projection, enforces this table. D1 status can lag an
authoritative transition.

When a completed or failed child becomes active, the existing `SessionStatusService` updates D1 and
notifies the parent. When an already active child receives another queued prompt, no new child
status notification is required.

`get-child-status(includeResponse: true)` currently reports the latest terminal message. While a new
follow-up is active it may still expose the previous terminal response; after completion it exposes
the follow-up response. The tool description and tests should not imply that the returned final
response is permanently tied to the original spawn prompt. Update the formatter to label this as
`Latest completed response (newer prompt queued or running)` when the child has a pending or
processing message. This is more precise than inferring work from session status alone.

### Concurrent-child admission

Reactivating a `completed` or `failed` child makes it non-terminal again and must honor the same
`maxConcurrentChildSessions` setting used at spawn. The authoritative child handler should read its
inherited sandbox setting and query D1 for the parent's non-terminal direct children, excluding the
child being resumed. Return `429` when the configured limit has been reached.

This remains a best-effort guardrail. Existing child spawn admission is also a count-then-create
operation, so simultaneous requests can exceed the configured count. V1 should preserve that
consistency rather than introduce a parent reservation Durable Object or a D1 lease schema only for
follow-ups. If the count becomes a hard billing or capacity boundary, both spawn and resume should
move together to one atomic reservation design.

## Authorization and Attribution

The authorization chain should be:

```text
parent sandbox token
  -> verified against parent Durable Object
  -> parent sandbox principal
  -> D1 direct-child check
  -> child Durable Object parent ID check
  -> child-local owner attribution
  -> normal child prompt queue
```

This preserves these invariants:

- A sandbox can act only through its own parent session route.
- A parent can prompt only its direct children.
- A session ID without valid user, service, or session-scoped sandbox authentication does not grant
  write access.
- Parent and child sandbox credentials remain isolated.
- The caller cannot forge a human author or message source.
- Follow-up commits retain the same owner attribution used by the child's initial prompt.

Authenticated users and services retain the repository's existing single-tenant ability to use the
ordinary prompt API. Per-session human/service authorization is outside this feature.

The persisted message source should be `agent`. No new `MessageSource` value is necessary.

## Implementation Plan

### 1. Shared contracts

- Add `childFollowUpPromptRequestSchema` and its inferred type to
  `packages/shared/src/types/session-api.ts`.
- Export the contract through the existing shared type barrel.
- Build `@open-inspect/shared` before validating control-plane consumers.

### 2. Child Durable Object endpoint

- Add `parentPrompt` to `SessionInternalPaths` in `packages/control-plane/src/session/contracts.ts`.
- Wire the endpoint through `packages/control-plane/src/session/http/routes.ts` and
  `packages/control-plane/src/session/durable-object.ts`.
- Add the local internal request schema and handler alongside the child session handlers, or in a
  new method on the existing child session handler.
- Inject the existing `MessageService` or `SessionMessageQueue`; do not duplicate queue, sandbox, or
  event logic.
- Enforce local parent ID, child status, owner, queue-depth, and resume-admission invariants before
  enqueueing.
- Add a D1 count helper that excludes the child being resumed.

### 3. Parent-scoped route and authentication

- Add `handlePromptChild()` to `packages/control-plane/src/routes/session-children.ts`.
- Register `POST /sessions/:id/children/:childId/prompt` with `sessionRoute()`.
- Add the exact route to `SANDBOX_AUTH_ONLY_ROUTES` in `packages/control-plane/src/router.ts` so
  authentication is always performed against the parent path segment.
- Add the route to `isScmAgnosticRoute()`.
- Validate direct lineage using `SessionIndexStore.isChildOf()` before calling the child runtime.
- Touch the child D1 index timestamp after a successful enqueue.
- Add structured logs with `parent_id`, `child_id`, `message_id`, `request_id`, and `trace_id`. Do
  not log prompt content.

### 4. Prompt lifecycle and ordering

- Add a shared promptability check to `SessionMessageQueue` and map its typed state error to `409`
  at all enqueue boundaries.
- Guard dispatch against cancelled and archived session states.
- Fail pending messages during cancellation, reject archival with queued work, and restrict
  unarchive to archived sessions.
- Change pending selection in `SessionRepository.getNextPendingMessage()` to a deterministic order,
  such as `ORDER BY created_at ASC, rowid ASC`.
- Update `get-child-status-format.js` so an earlier terminal result is not labeled as the current
  final response while a resumed child is active.

### 5. Sandbox tool

- Add `packages/sandbox-runtime/src/sandbox_runtime/tools/send-child-prompt.js`.
- Use `encodeURIComponent(childId)` and `bridgeFetch()` to preserve current parent scoping and token
  handling.
- Return actionable messages for `400`, `404`, `409`, `429`, and authentication/server failures.
- Rely on the existing `_install_tools()` directory copy; no new sandbox environment variable or
  Modal request field is needed.
- Update tool installation and runtime-file exclusion tests where fixtures enumerate installed
  tools.

### 6. Documentation

- Add `send-child-prompt` to the child sessions section of `README.md`.
- Document queued, non-interrupting behavior and terminal-state rules in `docs/HOW_IT_WORKS.md`.
- Keep the shared protocol boundary rule from ADR 0002: the external request schema belongs in
  `@open-inspect/shared`; the trusted Durable Object-only envelope remains in control-plane.

## Test Plan

### Shared contract tests

- Accept a non-empty content string.
- Accept content at the documented maximum size.
- Reject missing, empty, whitespace-only, oversized, extra, identity, source, attachment, callback,
  and model fields.

### Control-plane integration tests

Extend `packages/control-plane/test/integration/child-session-ops.test.ts`:

- A valid parent sandbox token queues a prompt in its direct child.
- The child message has `source = agent` and is attributed to the child owner.
- The response includes the persisted child message ID and `queued` status.
- A prompt sent while the initial prompt is pending is ordered after it.
- A completed child transitions to active and accepts the prompt.
- A failed child transitions to active and accepts the prompt.
- Reactivating a terminal child returns `429` when the parent's concurrent-child limit is reached.
- A cancelled child returns `409` and stores no message.
- An archived child returns `409` and stores no message.
- A child with 10 pending or processing prompts returns `429` and stores no additional message.
- A child belonging to another parent returns `404` and stores no message.
- A grandparent cannot prompt a grandchild through the direct-child route.
- A missing, invalid, or child-owned sandbox token cannot authorize the parent route.
- A correctly signed user/service request is rejected by the sandbox-auth-only route.
- A parent sandbox token succeeds on a GitLab-configured router, proving the route is SCM-agnostic.
- Extra request fields and whitespace-only content return `400`.

Add focused Durable Object handler tests for authoritative parent ID mismatch, missing owner, and
status rejection. Test fixtures must initialize `parent_session_id` and status in the child Durable
Object, not only in D1. Add queue/lifecycle tests for enqueue-versus-cancel, enqueue-versus-archive,
pending-message cancellation, invalid unarchive, dispatch state guards, and equal-timestamp FIFO
ordering. Keep existing sandbox lifecycle tests as the primary coverage for snapshot restoration.

### Sandbox runtime tests

- Verify `send-child-prompt.js` is installed with the other runtime tools.
- Verify child IDs are URL encoded and the request body contains only `content` if a lightweight
  tool fetch test harness is added.
- Verify user-facing error text distinguishes not found, terminal child, and transport failure.
- Verify an active resumed child labels an earlier result as the latest completed response rather
  than the current final response.

### Verification commands

```bash
npm run build -w @open-inspect/shared
npm test -w @open-inspect/shared
npm test -w @open-inspect/control-plane
npm run test:integration -w @open-inspect/control-plane
npm run typecheck
cd packages/sandbox-runtime && pytest tests/test_tool_installation.py -v
```

Run the broader sandbox-runtime test suite if shared installation or exclusion behavior changes.

## Rollout and Compatibility

This feature requires no D1 migration, Durable Object SQLite migration, Modal API change, sandbox
environment change, or WebSocket protocol change.

The sandbox runtime is captured inside session snapshots. A parent restored from a snapshot created
before this tool shipped will still contain the old runtime and will not gain `send-child-prompt`.
V1 should document that the tool is available to parent sandboxes created from a post-deployment
runtime. Existing sessions gain it only after a fresh sandbox is created from the new runtime; a
future runtime-overlay or snapshot-version policy can improve this without blocking the API.

The route and internal endpoint can deploy before the runtime tool. The reverse order is also safe:
the tool will return a normal `404` until the control-plane route is available. Deploying the
control plane first provides the cleaner rollout.

Useful operational signals are:

- Count of accepted parent follow-ups.
- Rejections grouped by relationship, state, validation, and authentication.
- Queue position and time from enqueue to dispatch using the existing prompt logs.
- Sandbox restore/spawn failures after accepted follow-ups using existing lifecycle logs.

An accepted response guarantees durable enqueue, not eventual execution. The existing sandbox
lifecycle can leave a pending message in an active session after a restore or spawn failure. The
child detail still exposes the failed sandbox state, and another prompt attempt can trigger another
spawn. Changing global spawn-failure retry and message-failure semantics is existing platform debt
and is not bundled into this feature; track it separately and avoid describing `queued` as `running`
in tool output.

## Non-Goals and Deferred Work

- Interrupting or modifying the child's currently executing prompt. V1 is FIFO; use cancellation for
  terminal stop behavior. A true interrupt-and-steer operation needs separate semantics.
- Sending attachments across sessions. Attachment IDs and claims are owned by one session Durable
  Object; cross-session copying needs a separate storage and authorization design.
- Prompting arbitrary descendants. V1 follows the existing direct-child authorization model.
- Streaming child output into the parent's current model turn. The parent continues to use
  `get-child-status`; child updates remain asynchronous status notifications.
- Automatically cancelling children when a parent completes.
- Idempotency keys. Existing prompt APIs do not deduplicate ambiguous client retries. If tool or
  network retry behavior later causes duplicate follow-ups, add a caller-generated request ID and a
  uniqueness constraint in the child message store as a separate protocol change.
- Atomic concurrent-child reservations. Spawn and resume retain the same best-effort admission
  semantics until both can move to one shared reservation mechanism.
- Global sandbox spawn/restore retry and pending-message failure semantics.
- Per-follow-up model, reasoning, callback, or attachment overrides.

## Acceptance Criteria

- A parent agent can call `send-child-prompt` with a direct child ID and text.
- The follow-up is durably visible in the child session and uses the normal FIFO execution path.
- Running children queue the follow-up; completed and failed children resume normally.
- Resume and queue-depth guardrails reject excess work with `429`.
- Cancelled and archived children remain terminal through this API.
- Wrong-parent, descendant, and forged-identity attempts cannot enqueue a child message.
- No child sandbox token or encrypted credential is exposed to the parent.
- Normal browser, bot, sandbox bridge, and child spawn behavior remains unchanged; attempts to
  prompt cancelled or archived sessions are consistently rejected instead of implicitly reactivating
  them.

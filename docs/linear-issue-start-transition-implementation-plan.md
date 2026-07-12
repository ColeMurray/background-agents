# Linear Issue Start Transition — Implementation Plan

**Date:** 2026-07-12

**Status:** Implemented and validated

**Scope:** Move eligible Linear issues to the team's first `started` workflow state when the first
Open-Inspect prompt is successfully dispatched to a live sandbox

**Repository basis:** `public/main@4efd73f4`

**Target repository:** `public/`, followed by the normal public-to-prod sync

## 1. Outcome

When a human starts a new Linear agent session and Open-Inspect actually dispatches that session's
first prompt to a live sandbox, the Linear issue moves from an unstarted workflow category to the
team's first `started` workflow state.

The transition is standards-based rather than workspace-specific:

- determine human initiation from `agentSession.creatorId` on the `created` webhook;
- do not opt automation- or agent-initiated sessions into the transition;
- resolve the destination from the issue's team workflow states, filtered to `type: started` and
  ordered by the lowest `position`;
- leave issues already in `started`, `completed`, or `canceled` unchanged;
- never delay or fail agent execution because Linear could not update the issue.

This implements Linear's published agent interaction recommendation without adding a status-name or
status-ID setting.

## 2. Goals

- Make Linear issue state reflect that the coding agent has genuinely begun work.
- Transition only after a prompt is accepted by a live sandbox WebSocket, not while it is merely
  queued or while the sandbox is still spawning.
- Apply the behavior only to the initial prompt of a human-initiated AgentSession.
- Preserve custom Linear workflows by resolving status through workflow type and position.
- Make callback delivery and the Linear mutation safe to retry.
- Keep Linear-specific workflow policy inside `linear-bot`.
- Reuse the existing signed control-plane-to-bot callback boundary.
- Preserve the immediate AgentActivity `thought` acknowledgement required by Linear.
- Add sufficient structured logs to distinguish transition, no-op, skip, and failure outcomes.

## 3. Out of Scope

- Automatically moving issues to `completed` when an agent run or pull request finishes.
- Changing issue labels, priority, project, assignee, or other workflow fields.
- Automatically setting or changing `Issue.delegate`.
- Adding a configurable started-status name or ID.
- Transitioning automation- or agent-initiated sessions out of triage.
- Transitioning follow-up prompts after the initial Linear-created message.
- Refactoring the hand-maintained Linear webhook types or the adjacent `promptContext` placement.
- Adding durable callback delivery, a queue, an outbox, or a new database table.
- Adding new Terraform resources, service bindings, OAuth scopes, or secrets.
- Treating successful WebSocket send as proof that the model produced its first token. It is the
  earliest provider-independent point at which Open-Inspect has handed work to the sandbox.

## 4. Verified External Contract

Linear's current Agent API is a Developer Preview, so these assumptions must remain covered by tests
and a live smoke test.

### 4.1 Human versus automation initiation

The official `AgentSessionWebhookPayload` schema defines `creatorId` as the responsible human user's
ID. It is unset when a session is initiated by automation or another agent. The webhook type already
models this field as `creatorId?: string` in `packages/linear-bot/src/types.ts`.

For this feature, the producer opts in only when all of the following hold:

```text
webhook.action == "created"
and agentSession.creatorId is a non-empty string
and this is the initial Open-Inspect prompt created for that AgentSession
```

Do not infer origin from `comment.userId`, comment presence, or `sourceMetadata`. Those fields do
not carry the same documented semantic.

A Linear `created` AgentSession event may originate from either a human delegation or a human
mention. Open-Inspect currently starts the same implementation workflow for both. V1 therefore
treats both as human-initiated work. If product policy later requires assignment-only behavior, add
a fresh `Issue.delegate.id === appUserId` guard; do not guess from comment shape.

### 4.2 Destination workflow state

Linear recommends querying the issue's team for workflow states with `type: started` and choosing
the node with the lowest `position`. Display names and IDs are team-specific and must not be
hard-coded.

The Linear client should query the current issue state and candidate states at callback time:

```graphql
query IssueStartTransitionContext($issueId: String!) {
  issue(id: $issueId) {
    state {
      type
    }
    team {
      states(filter: { type: { eq: "started" } }) {
        nodes {
          id
          name
          position
        }
      }
    }
  }
}
```

If eligible, update the issue with the normal public GraphQL mutation:

```graphql
mutation IssueMoveToStarted($issueId: String!, $stateId: String!) {
  issueUpdate(id: $issueId, input: { stateId: $stateId }) {
    success
  }
}
```

Official references:

- <https://linear.app/developers/agent-best-practices>
- <https://linear.app/developers/agent-interaction>
- <https://linear.app/developers/graphql>
- <https://raw.githubusercontent.com/linear/linear/refs/heads/master/packages/sdk/src/schema.graphql>

## 5. Current Behavior and Timing Gap

The Linear webhook handler currently:

1. emits an immediate ephemeral `thought`;
2. resolves a repository or environment target;
3. creates the Open-Inspect session;
4. stores the issue-to-session mapping;
5. updates the Linear AgentSession plan and external URL;
6. posts the first prompt to the control plane;
7. emits the non-terminal `Working on ...` thought.

The prompt POST returning successfully means only that the control plane accepted and queued the
message. In `SessionMessageQueue.processMessageQueue()`:

- no sandbox socket means the message stays pending while sandbox creation begins;
- a live sandbox socket causes the message to become `processing`;
- `wsManager.send(sandboxWs, command)` then attempts to hand the prompt to the sandbox.

Therefore the Linear webhook handler is too early for the requested semantic. The lifecycle hook is
the successful sandbox send in `packages/control-plane/src/session/message-queue.ts`, not session
creation or prompt enqueue.

## 6. Target Flow

```text
Linear created webhook
  -> emit immediate thought (unchanged)
  -> resolve target and create Open-Inspect session
  -> enqueue initial prompt with Linear callback context
       transitionIssueOnStart = action is created and creatorId is present

control-plane message queue
  -> no sandbox: leave pending, spawn sandbox, no Linear transition
  -> live sandbox: mark message processing
  -> send prompt over sandbox WebSocket
  -> send failed: no Linear transition
  -> send succeeded:
       schedule notifyStarted(messageId) with ctx.waitUntil

callback notification service
  -> load message source + callback context
  -> require source == linear and forward callback context without interpreting Linear policy
  -> HMAC-sign start payload
  -> POST /callbacks/start through existing LINEAR_BOT binding
  -> retry once on transport/non-2xx failure

linear-bot /callbacks/start
  -> validate payload and HMAC
  -> acquire verified app-actor client for organization/appUserId
  -> query current issue state + team's started states
  -> no-op if already started/completed/canceled
  -> choose lowest-position started state
  -> issueUpdate(stateId)
  -> return a retryable or terminal HTTP outcome
```

## 7. Architecture Assessment

### 7.1 Boundary placement

The control plane owns execution lifecycle and can authoritatively say when dispatch succeeds. It
must not know Linear workflow categories, status selection rules, or GraphQL operations.

The Linear worker owns Linear authentication and provider policy. It receives a signed lifecycle
notification, performs all Linear reads and writes, and classifies provider outcomes.

This follows the existing completion and tool-progress callback direction:

```text
Session Durable Object -> service binding -> linear-bot -> Linear GraphQL API
```

No reverse dependency or new package dependency is introduced. Shared changes remain limited to the
message callback contract already consumed by both packages.

### 7.2 Message-scoped opt-in

Add an optional field to `LinearCallbackContext`:

```ts
transitionIssueOnStart?: boolean;
```

The initial new-session prompt sets it to `true` only for a human-initiated `created` webhook.
Follow-up callback contexts omit it or set it to `false`. The control plane forwards the opaque
context; `linear-bot` alone interprets the flag.

This is preferable to firing on every Linear prompt because a human may deliberately move an issue
back to an unstarted state after the original run. A later follow-up must not silently undo that
choice. The optional field also gives rolling compatibility with messages created before deployment.

### 7.3 Delivery and idempotency

The start notification is best-effort and is scheduled with `ctx.waitUntil`; Linear latency never
blocks prompt dispatch.

The transport may retry once. The receiver must re-read current state for every attempt. If the
first attempt mutated Linear but its response was lost, the retry sees `started` and becomes a
no-op. No KV or D1 deduplication record is required.

The read-before-write guard also prevents movement between multiple custom states that all have the
`started` type.

## 8. Implementation

Implement as one cohesive PR in `public/`, then sync to `prod/` through the normal public-to-prod
workflow. The phases below describe dependency order, not separate required PRs.

### Phase 1 — Mark eligible initial Linear messages

**Files**

- `packages/shared/src/types/session-api.ts`
- `packages/linear-bot/src/webhook-handler.ts`
- `packages/linear-bot/src/webhook-handler.test.ts`

**Changes**

1. Add optional `transitionIssueOnStart?: boolean` to `LinearCallbackContext` with a comment that it
   is message-scoped and applies only to the first dispatch.
2. Extend `buildLinearCallbackContext()` to accept the flag.
3. In `handleNewSession()`, set the flag from the documented creator predicate:
   `webhook.action === "created" && typeof creatorId === "string" && creatorId.length > 0`.
4. Do not use `getNewSessionActorUserId()` for this decision because its comment-author fallback is
   attribution behavior, not initiation provenance.
5. In `handleFollowUp()`, omit the flag or set it to false.
6. Assert the actual JSON posted to the control plane contains true for a human-created initial
   prompt, false/absent for an automation-created initial prompt, and false/absent for follow-ups.

### Phase 2 — Emit a lifecycle-accurate signed start callback

**Files**

- `packages/control-plane/src/session/message-queue.ts`
- `packages/control-plane/src/session/message-queue.test.ts`
- `packages/control-plane/src/session/callback-notification-service.ts`
- `packages/control-plane/src/session/callback-notification-service.test.ts`
- `packages/control-plane/src/session/linear-start-callback.ts`
- `packages/control-plane/src/session/callback-delivery.ts`

**Changes**

1. Add `CallbackNotificationService.notifyStarted(messageId)`.
2. Load callback context through the existing `getMessageCallbackContext()` repository interface.
3. Skip with structured reasons when context is absent, the message source is not `linear`, the
   callback secret is absent, or `LINEAR_BOT` is unavailable. Do not inspect Linear-specific fields
   in the control plane.
4. Build and sign this payload using the existing HMAC helper:

   ```ts
   {
     sessionId,
     messageId,
     timestamp,
     context,
     signature,
   }
   ```

5. POST it to `https://internal/callbacks/start` using the existing `LINEAR_BOT` service binding.
6. Use the completion callback's bounded policy: at most two attempts with one one-second delay.
7. Immediately after `wsManager.send(sandboxWs, command)`, and only when it returns true, schedule
   `notifyStarted(message.id)` with `ctx.waitUntil`. Catch and log the background promise.
8. Do not call the callback in the no-sandbox path or when `send()` returns false.

`wsManager.send()` returning true means the socket was open and `WebSocket.send()` did not throw.
There is no provider-independent sandbox event that more precisely acknowledges first execution;
`step_start` is later and may occur multiple times.

### Phase 3 — Authenticate and apply the Linear transition

**Files**

- `packages/linear-bot/src/callbacks.ts`
- `packages/linear-bot/src/callbacks/start-callback.ts`
- `packages/linear-bot/src/callbacks.start.test.ts`
- `packages/linear-bot/src/__tests__/pure-functions.test.ts` or a focused callback route test
- `packages/linear-bot/src/utils/linear-client.ts`
- `packages/linear-bot/src/utils/issue-start-transition.ts`
- `packages/linear-bot/src/utils/issue-start-transition.test.ts`
- `packages/linear-bot/src/test-helpers.ts` if a named GraphQL mock route is needed

**Changes**

1. Define the start callback contract with Zod at the receiving boundary.
2. Strictly validate `sessionId`, `messageId`, `timestamp`, `signature`, and `context`.
3. Add `POST /callbacks/start` beside the existing callback routes.
4. Verify HMAC over the unsigned payload with the existing `verifyCallbackSignature()` helper.
5. Reject callbacks outside a bounded timestamp window after signature verification so an old valid
   payload cannot re-promote an issue after a human moves it backward.
6. Require `context.issueId`, `context.organizationId`, `context.appUserId`, and
   `context.transitionIssueOnStart === true`. Permanent skips return 2xx and are logged.
7. Acquire the Linear client with `getLinearClient()` so organization and installed app-user
   identity validation remain centralized.
8. Add a focused client helper such as `transitionIssueToStarted()` that:
   - fetches current issue state and the team's started states;
   - normalizes the current state type before comparison;
   - returns a no-op for `started`, `completed`, or `canceled`;
   - sorts candidate states by ascending `position`, with ID as a deterministic tie-breaker;
   - returns a permanent no-op with warning if no started state exists;
   - calls `issueUpdate` once for the selected state;
   - checks both GraphQL errors and the mutation's `success` result;
   - returns domain outcomes and throws provider/schema failures to the HTTP boundary.
9. Await the small transition operation in the callback route. Return 2xx for transition and
   permanent no-op outcomes, and 5xx for provider/auth failures that may succeed on the control
   plane's second attempt. Because the caller already runs in `waitUntil`, this does not block agent
   execution.
10. Emit bounded structured fields only: session/message/issue identifiers, prior state type,
    selected state ID/name, outcome, HTTP status, and duration. Never log access tokens or raw API
    response bodies.

Suggested helper outcome values:

```text
transitioned
already_started
terminal_completed
terminal_canceled
no_started_state
issue_not_found
```

### Phase 4 — Update documentation

**Files**

- `docs/integrations/LINEAR.md`
- `packages/linear-bot/README.md`
- `packages/linear-bot/INTEGRATION.md`

**Changes**

1. Replace the statement that the integration never updates issue status with the exact new rule.
2. Keep issue status separate from Linear AgentSession `Thinking`/`Working`/terminal activity state.
3. Document that status changes happen only after successful initial sandbox dispatch.
4. Document human/automation behavior, custom workflow resolution, protected state categories, and
   best-effort failure semantics.
5. Add `/callbacks/start` to the Linear worker endpoint/architecture documentation.
6. Document `transitionIssueOnStart` as a message-level callback-context field, not a repository or
   workspace setting.

## 9. Test Plan

### 9.1 Linear webhook handler

- Human `created` session -> initial prompt context opts in.
- Missing `creatorId` -> initial prompt context does not opt in.
- `prompted` follow-up -> context does not opt in even when the AgentSession has a creator.
- Existing target resolution, environment sessions, and repository sessions retain the same flag
  semantics.
- Immediate first `thought` remains before target resolution and is not delayed by state work.

### 9.2 Control-plane dispatch

- Pending message with no sandbox -> no start callback.
- Successful WebSocket send -> schedules exactly one start callback for the processing message.
- WebSocket send failure -> no start callback.
- Already-processing queue re-entry -> no duplicate dispatch callback.
- Callback rejection/failure does not change message processing or sandbox execution.

### 9.3 Callback notification service

- No callback context -> skip.
- Non-Linear source -> skip without contacting Slack or Scheduler bindings.
- Missing/false opt-in -> skip.
- Missing secret or binding -> bounded skip log.
- Eligible message -> correct path, payload, HMAC, and LINEAR_BOT binding.
- Initial non-2xx/throw -> one retry; second success stops retrying.
- Two failures -> contained error, never thrown into prompt dispatch.

### 9.4 Linear callback route

- Malformed payload -> 400.
- Missing secret -> 500.
- Invalid signature -> 401.
- Missing required Linear identity context -> permanent 2xx skip with reason.
- Credential acquisition failure -> retryable failure response.
- Successful transition/no-op -> 2xx.
- GraphQL failure -> retryable failure response and bounded log.

### 9.5 Linear workflow helper

- Unstarted issue + one started state -> update with that state ID.
- Multiple started states -> choose lowest `position` deterministically.
- Current `started` -> no mutation, including when current state is not the first started state.
- Current `completed` or `canceled` -> no mutation.
- Missing issue/team/state or no started candidates -> classified permanent no-op.
- Mutation returns `success: false` -> classified API failure.
- HTTP 401 -> existing token-renewal and single GraphQL replay remain effective.
- Duplicate callback after a successful mutation -> query sees started and performs no second
  update.

## 10. Validation Commands

Run from `public/`:

```bash
npm run build -w @open-inspect/shared
npm test -w @open-inspect/control-plane
npm test -w @open-inspect/linear-bot
npm run typecheck -w @open-inspect/shared -w @open-inspect/control-plane -w @open-inspect/linear-bot
npm run build -w @open-inspect/control-plane -w @open-inspect/linear-bot
npm run lint
```

Run the shared build before dependent package checks.

## 11. Rollout

No migration or infrastructure sequencing is required. The existing control-plane `LINEAR_BOT`
binding, `INTERNAL_CALLBACK_SECRET`, and Linear OAuth `write` scope are sufficient.

Recommended deployment order for clean rolling compatibility:

1. deploy shared contract + Linear worker callback receiver/client behavior;
2. deploy the control-plane callback producer;
3. smoke-test in a non-critical Linear team with custom-named workflow states;
4. monitor callback and GraphQL outcome logs;
5. sync the merged public change to `prod/` through the repository's normal process.

The optional callback-context flag makes mixed versions safe: old messages omit the flag and are not
transitioned; a new Linear worker can accept the callback before a control plane begins sending it.

### Smoke-test matrix

| Scenario                                            | Expected result                               |
| --------------------------------------------------- | --------------------------------------------- |
| Human-created backlog issue, sandbox still spawning | Remains backlog                               |
| Same issue, first prompt dispatch succeeds          | Moves to team's lowest-position started state |
| Automation-created issue                            | Remains unchanged                             |
| Already-started issue                               | Remains in its current started state          |
| Completed or canceled issue                         | Remains unchanged                             |
| Sandbox WebSocket send fails                        | Remains unchanged                             |
| Follow-up after a human moves issue back to backlog | Remains backlog                               |
| Linear API temporarily fails                        | Agent still runs; callback logs failure/retry |

## 12. Risks and Mitigations

### Linear Agent API schema changes

The Agent API remains in Developer Preview. Keep raw GraphQL operations small, assert response
shapes in tests, and include a live compatibility smoke test before production rollout.

### Read/write race

A human can change issue status after the helper reads it and before `issueUpdate` completes.
Linear's documented mutation does not expose a compare-and-set precondition. The window is small but
not zero. Mitigations are: run immediately at dispatch, never retry without re-reading, skip
protected state types, and keep the mutation observable. Do not add heavy locking for a
provider-side race that cannot be made atomic locally.

### Multiple started states

Moving an already-started issue to the first started state would discard meaningful workflow
progress. Always guard by status type before selecting a destination.

### Callback duplication

Service-binding response loss can cause a retry after mutation success. Fresh state resolution makes
the operation idempotent; no durable dedupe store is needed.

Signed callbacks are accepted only within a bounded freshness window. This limits replay but does
not provide single-use delivery inside that window; HMAC authentication, TLS, service-binding
transport, and the state guard make that residual acceptable for this best-effort transition. A
durable nonce store would be required if the callback ever crosses a less trusted transport.

### Callback latency

The GraphQL query and mutation may take longer than prompt dispatch. They run in `waitUntil`, so
they cannot delay the sandbox. Keep retry count bounded to the existing two-attempt convention.

### Human mention versus explicit delegation

`creatorId` identifies a responsible human but does not distinguish mention from assignment. V1
intentionally covers both because Open-Inspect starts implementation work for both. If that policy
changes, add a fresh delegate check and corresponding tests rather than depending on undocumented
webhook metadata.

## 13. Acceptance Criteria

- A human-initiated Linear issue in an unstarted state does not move while its prompt is queued or
  while the sandbox is spawning.
- It moves to the team's lowest-position `started` state after the first prompt is successfully sent
  to a live sandbox.
- Automation/agent-initiated sessions, follow-ups, already-started issues, completed issues, and
  canceled issues do not transition.
- Custom workflow names require no configuration.
- Duplicate delivery is an idempotent no-op after the first successful transition.
- Linear API or callback failure never prevents or stops the coding session.
- Callback payloads are HMAC-authenticated using the existing internal secret.
- No new database schema, Terraform resource, binding, secret, or OAuth scope is introduced.
- User-facing and integration documentation accurately distinguishes issue workflow state from
  Linear AgentSession activity state.

## 14. File-Change Appendix

| Area               | Files                                                                                                                            | Purpose                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Shared contract    | `packages/shared/src/types/session-api.ts`                                                                                       | Initial-message transition opt-in                        |
| Linear ingress     | `packages/linear-bot/src/webhook-handler.ts`, `.test.ts`                                                                         | Derive human initiation and mark only the initial prompt |
| Dispatch lifecycle | `packages/control-plane/src/session/message-queue.ts`, `.test.ts`                                                                | Fire only after successful sandbox send                  |
| Callback transport | `packages/control-plane/src/session/callback-notification-service.ts`, `linear-start-callback.ts`, `callback-delivery.ts`, tests | Sign, route, retry, and contain start notification       |
| Linear callback    | `packages/linear-bot/src/callbacks/start-callback.ts`, `callbacks.start.test.ts`                                                 | Authenticate start callback and classify HTTP outcomes   |
| Linear GraphQL     | `packages/linear-bot/src/utils/issue-start-transition.ts`, `.test.ts`, `linear-client.ts`                                        | Resolve and mutate workflow state idempotently           |
| Documentation      | `docs/integrations/LINEAR.md`, `packages/linear-bot/README.md`, `packages/linear-bot/INTEGRATION.md`                             | Describe lifecycle and operational behavior              |

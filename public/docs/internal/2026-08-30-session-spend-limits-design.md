# Per-Session Spend Limits

## Status

Draft design for review. This document supersedes the 2026-07-22 Track C implementation spec for
per-session spend caps. The current-state evidence is recorded in
`2026-08-30-session-spend-limits-research.md`.

## Summary

Open-Inspect will support an optional best-effort cost limit for each session. The limit applies to
the positive finite cost values reported by OpenCode on `step_finish` events. When observed session
cost reaches the limit, the Session Durable Object marks the budget exhausted, emits a durable
warning, stops the active execution, and pauses queued and new prompts. The session owner can raise
or remove the live limit to resume work.

The default limit and warning threshold use the existing sandbox-settings resolution chain: global
defaults, primary-repository overrides, then environment overrides. The resolved limit is copied
into dedicated Session DO columns when the session is created. This makes one mutable value
authoritative for the lifetime of the session without re-reading moving D1 settings during
enforcement.

The feature is a guardrail, not a billing ledger or exact prepaid allowance. Cost reporting remains
dependent on OpenCode's optional event field, arrives after a billable step, and uses the current
non-critical event transport. The UI states that unreported cost cannot be limited and that a
session may exceed its limit by the cost of the step already in progress.

## Decisions

| Area              | Decision                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------- |
| Budget unit       | One Open-Inspect session and its Session DO cost aggregate.                                   |
| Cost basis        | Positive finite `step_finish.cost` values reported by OpenCode.                               |
| Guarantee         | Best-effort guardrail, not exact billing enforcement.                                         |
| Configuration     | Optional sandbox setting at global, repository, and environment scopes.                       |
| Default           | No limit unless configured.                                                                   |
| Resolution        | Global, primary repository, environment; copied into the Session DO at creation.              |
| Live changes      | The session owner can set a positive USD limit or remove it for that session.                 |
| Warning           | One durable warning at a configurable percentage; default 80%.                                |
| Exhaustion        | Stop active execution and pause queued and new prompts.                                       |
| Resume            | Raising the limit above observed cost or removing it clears exhaustion and resumes the queue. |
| Session status    | Budget state is orthogonal to `SessionStatus`; no new status value.                           |
| Missing cost      | Latch and display that cost tracking was unavailable for part of the session.                 |
| Children          | Each Open-Inspect child has its own independently resolved limit and cost aggregate.          |
| Persistence       | Session DO SQLite only; no new D1 budget columns.                                             |
| Client sync       | Full snapshot on subscribe plus a semantic `budget_status` update message.                    |
| Reliability scope | No cost-event acknowledgement, repricing, or billing reconciliation in this feature.          |
| Deployment mode   | One enforcement behavior; no warn-only environment switch.                                    |

## Motivation

Open-Inspect already records and displays model cost per session, but autonomous prompts, queued
follow-ups, bot callbacks, agent-spawned children, and automation fan-out can continue without a
monetary boundary. Existing controls limit child counts, execution time, sandbox lifetime, secret
payloads, and Autofix attempts. None compares observed model cost with an operator-defined amount.

The existing cost pipeline provides a useful operational signal but has explicit limits:

- OpenCode supplies the value; Open-Inspect does not calculate or reprice tokens.
- A `step_finish` arrives after the model step has incurred cost.
- Missing cost is currently silent.
- OpenCode-internal subtasks count toward their enclosing session.
- Separate Open-Inspect child sessions have separate totals.
- D1 receives settled-turn metric snapshots rather than live increments.
- Step-cost events are not durable or acknowledged.

The product therefore needs a limit whose behavior matches the signal it actually has. Calling the
feature best-effort and exposing unmetered activity avoids claiming billing-grade precision that the
current pipeline cannot provide.

## Goals

- Let operators configure an optional default per-session cost limit at existing sandbox-settings
  scopes.
- Warn once before the observed limit is reached.
- Stop active execution promptly after a reported step causes observed cost to reach the limit.
- Prevent pending or newly submitted prompts from consuming more cost while exhausted.
- Let the session owner raise or remove the limit without recreating the session.
- Preserve queued prompts while exhausted and resume them in FIFO order after the budget permits.
- Show observed cost, effective limit, exhaustion, and incomplete cost tracking in the session UI.
- Give HTTP and WebSocket callers stable budget-exhausted errors.
- Keep enforcement local to the Session DO and independent of stale D1 metrics.
- Preserve existing behavior when no limit is configured.

## Non-Goals

- Billing, invoicing, credits, prepaid balances, or accounting reconciliation.
- A guarantee that observed cost never exceeds the configured amount.
- Local model pricing tables or token repricing.
- Provider invoice, subscription quota, or sandbox-provider cost collection.
- Retrofitting durable acknowledgement or deduplication onto `step_finish` events.
- Root-session, automation-invocation, repository, user, or installation-wide monetary budgets.
- Rolling daily or monthly spend limits.
- Aggregating Open-Inspect child-session cost into the parent limit.
- Cancelling or deleting queued prompts when a limit is reached.
- A human “send anyway” bypass while the session remains over its limit.
- A warn-only deployment mode.
- D1 dashboard filtering by budget state.
- Per-model limits or different warning thresholds by model.
- Currency selection; the current cost pipeline and UI treat reported cost as USD.

## Terminology

### Observed cost

The sum of positive finite `step_finish.cost` values accepted by the Session DO. This is the
existing `session.total_cost` value.

### Effective limit

The nullable USD limit stored in the Session DO's `max_cost_usd` column. `null` means unlimited. The
initial value is resolved from sandbox settings when the session is created. The session owner can
replace it for that session.

### Warning threshold

The percentage of the effective limit at which the session emits its one-time pre-limit warning. It
is resolved from sandbox settings at session creation and remains in the existing `sandbox_settings`
snapshot. The default is 80.

### Exhausted

A latched session condition indicating that observed cost is greater than or equal to the current
effective limit. Exhaustion pauses dispatch and admission but does not cancel the session or remove
queued prompts.

### Cost tracking unavailable

A one-way informational latch indicating that at least one `step_finish` included positive token
usage but omitted cost. It does not stop execution because the system does not know the missing
amount.

## Product Experience

### Sandbox settings

The existing sandbox settings editor gains a **Session Cost Limit** section at global, repository,
and environment scopes.

It contains:

- **Maximum session cost (USD)**: optional positive decimal. Empty inherits the broader setting;
  when no broader value exists, the session is unlimited.
- **Warning threshold (%)**: optional integer from 1 through 99. Empty inherits the broader setting;
  when no broader value exists, it uses 80%. This setting has an effect only when an effective limit
  exists.

The section explains:

> Stops additional model work after reported session cost reaches the limit. The current step may
> finish above the limit, and models that do not report cost cannot be limited.

Changing scoped settings affects newly created sessions. It does not mutate existing sessions,
matching the established sandbox-settings snapshot behavior.

### Session sidebar

The session details sidebar always shows observed cost when a limit exists, including before cost is
positive:

> Session cost: $3.42 of $10.00 limit

When no limit exists, the current positive-cost-only display remains:

> Session cost: $3.42

The session owner can open an inline **Edit limit** control and either enter a positive amount or
choose **No limit**. Other participants see the effective limit without mutation controls. The
control shows that the change applies only to the current session. A successful change updates all
connected clients through `budget_status`.

If any positive-token step omitted cost, the sidebar also shows:

> Cost tracking was unavailable for part of this session

The accompanying explanation states that observed cost and limit enforcement may be incomplete. The
latch remains visible even if later steps report cost.

### Warning state

Crossing the warning threshold creates one durable budget warning in the session timeline and shows
the same warning in the sidebar's existing warnings section:

> Session cost $8.14 reached 80% of the $10.00 limit.

The warning does not interrupt execution. A direct jump from below the warning threshold to the
limit emits only the exhausted warning, avoiding two adjacent warnings for the same step.

### Exhausted state

When observed cost reaches the limit, the composer displays a persistent inline state. For the
owner:

> Session cost limit reached at $10.27 of $10.00. Raise or remove the limit to continue.

For other participants:

> Session cost limit reached at $10.27 of $10.00. The session owner must raise or remove the limit
> to continue.

The send action is disabled. Existing pending prompts remain visible in the queued-prompt stack but
do not dispatch. Stop controls and non-prompt session actions continue to work.

The timeline receives one durable exhausted warning. When an execution was active:

> Session cost limit reached: $10.27 of $10.00. Execution stopped.

When no execution was active:

> Session cost limit reached: $10.27 of $10.00. Work paused.

There is no “send anyway” action. This keeps web, bot, automation, extension, GitHub, Linear, Slack,
and agent prompt sources under the same server-enforced rule.

### Resuming work

When the session owner raises the effective limit above observed cost or removes it, exhaustion
clears, the warning latch re-arms for the new limit, and the oldest pending prompt dispatches
through the normal queue path.

Setting a limit equal to or below observed cost leaves the session exhausted. If an execution is
active when the owner lowers the limit to or below observed cost, that execution is stopped by the
same budget-stop path.

## Budget Model

### Shared settings

`sandboxSettingsSchema` gains:

```ts
maxSessionCostUsd: z.number().positive().optional();
costWarningThresholdPct: z.number().int().min(1).max(99).optional();
```

`maxSessionCostUsd` is a finite number greater than zero. `costWarningThresholdPct` is an integer
from 1 through 99. `DEFAULT_COST_WARNING_THRESHOLD_PCT` is 80 and is defined once in the shared
package.

The control-plane sandbox normalizer applies the same constraints in throw and omit modes. Unknown
or invalid persisted values continue to follow current strict-boundary and tolerant-consumer
behavior. The existing global, repository, and environment merge requires no new storage tables.

### Session DO columns

The Session DO `session` row gains:

| Column                      | Type                         | Meaning                                          |
| --------------------------- | ---------------------------- | ------------------------------------------------ |
| `max_cost_usd`              | `REAL NULL`                  | Current effective limit; `NULL` means unlimited. |
| `cost_warning_sent`         | `INTEGER NOT NULL DEFAULT 0` | Warning latch for the current effective limit.   |
| `budget_exhausted`          | `INTEGER NOT NULL DEFAULT 0` | Dispatch and admission pause latch.              |
| `cost_tracking_unavailable` | `INTEGER NOT NULL DEFAULT 0` | At least one positive-token step omitted cost.   |

The next available DO migration ID at implementation time adds the columns and the fresh schema
defines them. No D1 migration is part of this design.

### Initialization

Session creation already resolves and sends `sandboxSettings` to the Session DO. During
`SessionInitHandler.init()`, normalization produces the JSON snapshot and initializes `max_cost_usd`
from `maxSessionCostUsd` in the same transaction that creates the session row.

The JSON snapshot remains the source for `costWarningThresholdPct`. The dedicated limit column is
the source for the mutable effective limit. This intentionally duplicates only the resolved limit,
because it is the one setting that changes during a session.

Old Session DOs receive `NULL` and remain unlimited. Existing sessions are not retroactively given
limits from settings changed after their creation.

### Budget evaluation

Budget evaluation is a small pure domain function with these inputs:

```ts
interface BudgetEvaluationInput {
  totalCost: number;
  maxCostUsd: number | null;
  warningThresholdPct: number;
  warningSent: boolean;
  exhausted: boolean;
}
```

It returns one of:

```ts
type BudgetAction = "none" | "warn" | "exhaust";
```

Rules are evaluated in this order:

1. A `null` limit returns `none`.
2. Cost greater than or equal to the limit returns `exhaust` only when not already exhausted.
3. Cost greater than or equal to `limit * threshold / 100` returns `warn` only when neither latch is
   set.
4. Every other state returns `none`.

Comparisons use the unrounded reported float. Rounding is display-only. A direct jump to or beyond
the limit chooses `exhaust`, not `warn`.

## Enforcement Flow

### Cost ingestion

`SandboxStreamingEventHandler.handleStep()` remains the single place where observed cost changes.
For a positive finite `step_finish.cost`, it performs this sequence in the same Durable Object turn:

1. Atomically add the step cost and read back the resulting total.
2. Read the session's effective limit and latches.
3. Evaluate the budget.
4. Atomically persist any latch and its corresponding warning event, or establish the atomic
   exhaustion transition described below.
5. Broadcast the original `step_finish` event.
6. Persist and broadcast any budget warning event.
7. Broadcast `budget_status` when state changed.
8. Deliver the already-established stop command when exhaustion was newly latched during active
   execution.

`SessionCoreRepository.addSessionCost()` returns the updated aggregate. The Session DO is
single-writer, so update-then-read is race-free without introducing another storage abstraction.

When a `step_finish` omits cost and has positive token usage, the handler latches
`cost_tracking_unavailable` once, writes one durable warning, and broadcasts updated budget state.
Positive token usage means a positive scalar token value or any positive `total`, `input`, `output`,
`reasoning`, cache-read, or cache-write count in the structured form. Explicit zero or negative cost
does not mark tracking unavailable. It retains current non-accumulating behavior and is logged when
anomalous. The latch and warning event commit in one transaction so a restart cannot suppress the
warning. The handler does not infer a price or stop the session.

### Durable warnings

The warning event scope enum gains `budget`. Budget warnings use the existing event repository and
timeline sequence rather than a separate budget-event table. The timeline row stores the triggering
message ID in `events.message_id` when one is available; the warning event payload itself does not
gain a `messageId` field. Every warning has a control-plane-generated event ID.

Budget warnings are control-plane-synthesized `SandboxEvent` values with a timestamp and an optional
sandbox ID, matching the existing warning contract. The handler broadcasts them only through the
ordinary `sandbox_event` path. The separate `sandbox_warning` message remains unchanged and is not
used by this feature.

### Stopping execution

`MessageQueue.stopExecution()` accepts an optional human-readable reason while retaining the current
default. Its existing persistence preparation and post-persistence delivery are separated internally
so the budget path can share delivery without attempting to fail an already failed message. Budget
exhaustion passes:

> Session cost limit reached: $10.27 of $10.00

The reason flows to the failed message, synthetic `execution_complete`, and completion callback.
Existing stop acknowledgement, timeout, sandbox termination fallback, and token-buffer flushing
remain unchanged.

For active execution, a dedicated budget-stop entry point performs one synchronous SQLite
transaction across the existing session, event, and message repositories. It sets
`budget_exhausted`, creates the durable exhausted warning, fails the processing message, records its
synthetic completion, and sets the message stop-confirmation deadline and shared persisted alarm
deadline before any await or external side effect. After commit, it uses the shared post-persistence
stop delivery to rearm the runtime alarm, broadcast state, send the sandbox command, and schedule
the completion callback. This makes the exhausted latch a truthful durable record that stop recovery
was established; an isolate cannot persist exhaustion while leaving an active message without stop
intent. Manual stop continues through the existing entry point and behavior.

For idle exhaustion, the transaction sets the latch and creates the “Work paused” warning without
message or stop-confirmation mutations. Later cost events do not repeat the transition. This avoids
duplicate callbacks and warnings while preserving existing stop recovery.

### Queue pause

`MessageQueue.processMessageQueue()` checks `budget_exhausted` at entry and again immediately after
its last pre-dispatch await, before either spawning a sandbox or claiming a pending message. The
second check closes the interleaving where provider-auth resolution yields and a cost event or live
limit reduction exhausts the session. No await occurs between that final check and
`startMessageProcessing()`. An exhausted session returns without spawning or dispatching work. These
checks are the queue backstop after stop confirmation, sandbox termination recovery, reconnect,
alarms, and Durable Object rehydration.

The current stop flow eventually calls `processMessageQueue()`. The new guard turns that call into a
no-op while exhausted, so pending prompts remain durable and ordered.

### Prompt admission

`enqueuePromptCore()` checks budget exhaustion before attachment claims or message insertion. The
budget check occurs after web request-id deduplication lookup so a client retry for a prompt already
accepted before exhaustion returns its existing acknowledgement rather than a contradictory
rejection.

GitHub Autofix has a separate atomic admission path through `admitAutofixMessage()`. That path
checks budget exhaustion after its feedback-key duplicate lookup and before queue capacity,
attempt-limit, or insertion work. An already admitted feedback key keeps its existing duplicate
result; new Autofix work receives a budget-exhausted rejection. The Autofix shared result union
includes this rejection reason. This preserves its specialized idempotency without introducing a
generalized admission framework.

New HTTP prompts receive:

```json
{
  "error": "Session cost limit reached. The session owner must raise or remove the limit to continue.",
  "code": "BUDGET_EXHAUSTED"
}
```

with status 409. WebSocket prompts receive a correlated `error` message with code
`BUDGET_EXHAUSTED`. Bot and automation callers retain the human-readable body even if they do not
yet render specialized copy. The web prompt BFF passes through this structured error body instead of
replacing it with its current generic failure response.

The shared server error says “The session owner must raise or remove the limit to continue.” The web
composer uses owner-aware copy because `subscribed.canManageBudget` identifies the viewer's
capability.

### Session status

Budget exhaustion does not add a `SessionStatus`. Stopping the active message continues to reconcile
through the existing status service:

- With pending prompts, the session remains `active`, but budget state prevents dispatch.
- Without pending prompts, the failed budget-stopped message settles the session as `failed`.
- Raising or removing the limit can transition the session to `active` when pending work resumes.

The explicit `budgetExhausted` state prevents the UI from inferring budget behavior from these
existing lifecycle statuses.

## Live Limit Changes

### Public route

An owner-only session route accepts a strict body:

```ts
z.strictObject({
  maxCostUsd: z.number().finite().positive().nullable(),
});
```

`null` means no limit for this session. There is no separate “reset to configured default” state;
the settings-derived amount is the initial value and the live value is authoritative thereafter.

The web BFF authenticates with `getServerAuthSession()` and uses `controlPlaneUserFetch`, matching
the archive, unarchive, title, and prompt routes. The control-plane route explicitly uses
`SCM_AGNOSTIC_HUMAN_USER_ROUTE`; it does not inherit the GitHub-only lifecycle policy. It derives
the canonical user from the verified principal and forwards it to the internal handler. The handler
requires a current session participant whose role is `owner`. Sandbox and service principals cannot
call the route.

### Mutation semantics

An unchanged nullable limit is an idempotent no-op. It returns current state without resetting
latches, emitting events, broadcasting, stopping, or processing the queue.

For a changed limit, the internal handler performs the mutation transactionally:

1. Validate the session owner.
2. Store the new nullable limit.
3. Clear `cost_warning_sent`.
4. Evaluate current observed cost against the new limit and persist the resulting exhausted boolean.
5. On a `false` to `true` exhaustion transition, perform the same atomic idle or active exhaustion
   transition used by cost ingestion. A changed limit that remains exhausted does not emit another
   exhausted warning or stop again.
6. If the resulting state is not exhausted and current cost is in the new warning band, set the
   warning latch and create the durable threshold warning immediately.
7. Read the resulting budget state.

After the transaction it broadcasts `budget_status`.

If the new state is not exhausted, it invokes normal queue processing. If the new state becomes
exhausted while a message is processing, the transaction has already established the budget stop
before the handler sends its external side effects. Idle exhaustion emits “Work paused.”

Removing the limit or setting it above observed cost re-arms the threshold warning. Setting a lower
limit can immediately exhaust the session; it does not wait for another cost event.

## Shared Session Contract

`SessionState` already contains `totalCost` and gains three optional fields for mixed-version
compatibility:

```ts
maxSessionCostUsd?: number | null;
budgetExhausted?: boolean;
costTrackingUnavailable?: boolean;
```

Snapshots populate observed cost and all three fields. Older snapshots remain valid because the new
fields are optional; web defaults are unlimited and both latches false. Warning threshold and the
warning latch remain server-only because no client behavior consumes them.

The viewer-specific `subscribed` message also gains optional `canManageBudget`. The connection
authenticator sets it from the authenticated participant's `owner` role. The web defaults it to
false until subscription completes and uses it only to show the live-limit control; the owner check
in the mutation handler remains authoritative.

The server message union gains:

```ts
{
  type: "budget_status";
  totalCost: number;
  maxSessionCostUsd: number | null;
  budgetExhausted: boolean;
  costTrackingUnavailable: boolean;
}
```

`budget_status.totalCost` is the authoritative aggregate read from the Session DO. The web reducer
replaces, rather than increments, its local value. For cost-triggered transitions, the control plane
broadcasts the original `step_finish` first and `budget_status` afterward, so the replacement also
corrects event loss without double-applying the triggering step.

The web reducer merges `budget_status` into `sessionState`. The control plane broadcasts it after
warning, exhaustion, unmetered-cost, and live-limit transitions. No broadcast occurs for ordinary
under-threshold cost increments.

## Children and Automations

An Open-Inspect child session resolves current sandbox settings from the parent's primary repository
and environment scope through the existing child-creation path. Its initial cost limit comes from
that child settings snapshot. A parent's live limit change is not inherited, copied, or rolled up.

OpenCode-internal subtasks remain inside one Open-Inspect session and therefore share its observed
cost and limit.

Automations that fan out to several targets create several sessions, each with its own limit. This
design does not bound the aggregate cost of an automation invocation. The UI and documentation state
that per-session limits multiply across fan-out.

Agent child-spawn admission is not blocked solely because the parent is exhausted if the spawn
request was already executing inside the current model step. Any newly created child has its own
limit. Once the parent stop takes effect, no further parent steps can request children until the
parent resumes.

## Failure Behavior

### Missing or invalid cost

- Omitted cost with positive token usage sets `cost_tracking_unavailable` and emits one warning.
- Missing cost without token usage leaves budget state unchanged.
- Explicit zero or negative cost does not mark tracking unavailable and does not increment observed
  cost. Non-finite wire values fail schema validation; direct internal anomalies are ignored and
  logged.
- No local estimate is substituted.

### Stop delivery failure

The existing stop-confirmation timeout and unresponsive-sandbox termination path remains the
recovery mechanism. Budget exhaustion stays latched while recovery runs, so queue dispatch remains
paused even if the sandbox must be replaced.

### Durable Object restart

The limit and latches are persisted in SQLite. On rehydration, `processMessageQueue()` reads
`budget_exhausted` and does not dispatch pending work. Clients receive the state in the next
`subscribed` snapshot.

### D1 projection failure

Budget enforcement does not read D1. A failed or delayed metrics projection can make analytics stale
without changing enforcement. Existing status and metric repair behavior remains separate.

### Settings resolution failure

Session settings resolution currently fails open to `{}`. A session created during such a failure is
unlimited and stores `NULL` as its effective limit. This feature does not create a separate failure
policy for one sandbox setting.

## Security and Authorization

- Global, repository, and environment cost settings use the existing integration-settings
  authorization model.
- Only the authenticated current session owner can change a live session limit.
- The verified principal determines participant identity; body-supplied identity is not trusted.
- Sandbox tokens cannot mutate their own limit.
- Agent tool calls cannot raise a limit through sandbox-authenticated routes.
- All connected participants can observe budget state because the session itself is collaborative.
- The current single-tenant trust model remains unchanged; no budget-specific administrator role is
  introduced.

## Observability

Structured logs record state transitions rather than every cost increment:

| Event                                 | Fields                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `session.budget_warning`              | session ID, message ID, observed cost, limit, threshold                     |
| `session.budget_exhausted`            | session ID, message ID, observed cost, limit                                |
| `session.budget_tracking_unavailable` | session ID, message ID, model, positive token usage present                 |
| `session.budget_updated`              | session ID, actor user ID, prior limit, new limit, observed cost, exhausted |
| `prompt.enqueue` rejection            | existing fields plus reason `budget_exhausted`                              |
| `prompt.dispatch` pause               | debug-level reason `budget_exhausted`                                       |

Cost values are operational metadata already exposed in session state and analytics. Logs do not add
prompt content, credentials, or provider tokens.

## Compatibility

- No configured limit preserves current session behavior.
- New shared session fields are optional for snapshots produced during mixed-version deployment.
- The web and control plane deploy from the same shared package build, as required by the workspace
  dependency graph.
- Older web bundles do not understand `budget_status` or the new `budget` warning scope; the current
  transport closes on unknown server-message variants. Compatibility lands in two merges. The first
  adds the shared protocol variants and web handling but no control-plane emission. After that web
  deployment is live, the second merge enables control-plane emission and enforcement. This avoids
  relying on completion order between the independent Vercel and Terraform workflows. Tabs that
  loaded the old bundle must reload; reconnecting with the same JavaScript does not upgrade the
  protocol. Snapshot fields remain the reconnect fallback after the current bundle loads.
- Old Session DOs receive unlimited defaults from the lazy migration.
- Existing sessions are not assigned newly configured scoped limits.
- Existing warning events remain valid when the `budget` scope is added.

## Testing

### Shared and settings

- Accept valid decimal limits and integer thresholds from 1 through 99.
- Reject zero, negative, non-finite, non-number, fractional-threshold, and values of 100 or more.
- Preserve absent fields through normalization.
- Verify global, repository, and environment precedence without pinning inherited values in the web
  editor.

### Budget evaluation

- Unlimited, below warning, warning crossing, repeated warning, direct cap crossing, repeated
  exhausted evaluation, and threshold 99.
- Unrounded comparisons at decimal boundaries.
- Clearing and raising a limit re-arm warning behavior.

### Repository and schema

- Cost increment returns the accumulated total.
- Fresh and migrated DO schemas have matching budget columns.
- Latch and live-limit writes are transactional and survive reinitialization.

### Event enforcement

- Under-limit cost updates total without budget side effects.
- Warning crossing persists and broadcasts one `budget` warning.
- Threshold and unmetered-cost latch/event pairs commit atomically.
- Direct cap crossing atomically persists the exhausted warning and stop intent, then delivers the
  stop once.
- Late cost after exhaustion increments observed cost without a duplicate stop or warning.
- Omitted cost with scalar or structured positive token usage latches and warns once.
- Missing cost without positive tokens, and explicit zero cost, do not mark tracking unavailable.
- Active exhaustion atomically persists the latch, warning, failed message, stop confirmation, and
  alarm intent before stop delivery.
- Idle exhaustion emits “Work paused” and performs no stop mutation.

### Queue and lifecycle

- Exhausted sessions do not claim or dispatch pending prompts after stop confirmation, reconnect,
  alarm delivery, or sandbox termination.
- Exhaustion interleaved during provider-auth resolution is observed by the final pre-dispatch
  check.
- Every ordinary new prompt source receives `BUDGET_EXHAUSTED` before message insertion.
- A deduplicated web retry for an already accepted request still returns the original result.
- Autofix checks feedback-key duplicates before budget rejection and does not insert new work while
  exhausted.
- Raising or removing the limit resumes the oldest pending prompt.
- Lowering the limit during processing stops the active message.
- Lowering into the warning band emits the threshold warning immediately.
- Repeating an unchanged live-limit request is a side-effect-free no-op.
- Manual stop behavior and default error text remain unchanged.

### Authorization and API

- Session owners can set, raise, and remove the live limit.
- Members and non-participants receive 403.
- Sandbox principals cannot call the public route.
- The route works under GitHub and GitLab deployments through its SCM-agnostic user policy.
- Invalid bodies return 400 and missing sessions return 404.
- HTTP prompt rejection returns 409 with `BUDGET_EXHAUSTED`.
- The web prompt BFF preserves the structured 409 body and code.
- WebSocket rejection includes the matching correlated error code.

### Web

- Settings fields show inherited values without storing overrides.
- Sidebar renders cost with and without a limit.
- Unmetered-cost explanation renders independently of positive observed cost.
- Exhausted composer disables submit and preserves its draft.
- Pending queue remains visible while exhausted.
- Live limit changes merge through `budget_status` and clear the exhausted composer state.
- `budget_status.totalCost` replaces stale event-derived client cost.
- A `subscribed` snapshot replaces stale local budget state after reconnect.
- An old bundle rejects the new protocol and requires a page reload rather than recovering through
  repeated reconnects.

### Integration

- Create a session from scoped settings and verify the resolved limit in the DO snapshot.
- Drive cost below warning, through warning, and through exhaustion using sandbox events.
- Verify the active message fails, pending work remains pending, and no further dispatch occurs.
- Raise the limit through the owner route and verify pending work resumes.
- Verify durable budget warnings through the events API.
- Verify settled D1 cost remains an analytics mirror and is not read for enforcement.

## Delivery

The shared package still builds before dependents. Delivery uses two merges because the current web
transport rejects unknown server messages. The compatibility merge adds shared protocol variants and
web handling without control-plane emission. After its web deployment is live, the enforcement merge
adds control-plane emission, storage, settings, and behavior. No workflow dependency is assumed.

No default limit is introduced. Deployments remain behaviorally unchanged until an operator saves a
limit in sandbox settings or a session owner sets one on a session.

The Session DO migration applies lazily on access and requires no new Durable Object binding. There
is no D1 migration and no Terraform variable.

## Risks and Tradeoffs

### Best-effort enforcement

The current step-cost transport can lose non-critical events and cannot deduplicate repeats.
Enforcement can therefore undercount or overcount. This design exposes that limitation rather than
expanding into billing infrastructure. The limit still bounds continued work when reported cost is
present and is useful as an operational guardrail.

### Post-step overshoot

Cost arrives at `step_finish`, after the step has incurred spend. The stop prevents later steps but
cannot undo the triggering one. Displaying observed cost above the limit is expected and accurate.

### Unmetered models

The repository does not identify in advance which current provider/account combinations omit cost.
The first positive-token step without cost exposes the limitation, but spend may already have
occurred. The session remains usable because no defensible missing amount exists to compare.

### Active status with paused work

An exhausted session with queued prompts can remain `active` while dispatch is paused. The explicit
budget state is the source of truth for this condition. Reusing lifecycle status for budget state
would conflate resumable policy with execution outcome.

### Independent child limits

A parent and each Open-Inspect child have independent budgets. Fan-out can multiply total spend, and
the parent's live override does not constrain descendants. Root and invocation budgets remain a
separate product boundary.

### Mixed web deployment

The current web transport closes on unknown server message types and warning variants. The two-merge
compatibility sequence ensures a current bundle exists before the control plane emits
`budget_status` or the `budget` warning scope. They are not silently ignored by stale tabs; tabs
with an old bundle must reload before reconnect can succeed.

## Open Questions

1. Does product copy use “cost limit” or “spend limit” consistently? This document uses “cost limit”
   in user-facing text because the value covers reported model cost only.
2. Is 80% the desired default warning threshold, or is a single near-limit warning at another
   percentage preferred?
3. Do current bot clients preserve the HTTP error body on 409 well enough for operators to
   understand why a follow-up was rejected?

# Research: Per-session spend limits

**Date:** 2026-08-30 **Status:** Research only **Scope:** Current session cost accounting, settings
and storage boundaries, lifecycle controls, client surfaces, integrations, and changes that make the
2026-07-22 Track C implementation spec stale.

This document is intentionally research-only. It does not include recommendations, implementation
plans, proposed code/API/schema changes, task breakdowns, estimates, or rollout steps.

The code evidence was inspected at commit `9e88529c3c7a04fb8f3f8bea7348bda5df094c4b`. The checkout
is shallow; its available history begins on 2026-08-21, so repository history between the prior
spec's 2026-07-22 baseline and 2026-08-20 is not locally available.

## Summary

Open-Inspect currently tracks an aggregate cost for each session, but it has no monetary spend
limit, threshold warning, cost-based admission rule, or cost-triggered stop behavior. OpenCode
supplies an optional numeric cost on `step_finish`; the sandbox runtime forwards that value
unchanged, the Session Durable Object increments `session.total_cost` for positive finite values,
and the web client displays and independently accumulates the same events.

The Session Durable Object is the live source for an individual session's aggregate. D1 mirrors the
aggregate only when a turn settles as `completed`, `failed`, or `cancelled`, and analytics read that
D1 mirror. Separate Open-Inspect child sessions have separate aggregates. OpenCode-internal subtasks
contribute to their enclosing Open-Inspect session because cost ingestion does not branch on
`isSubtask`.

The current aggregate is operational telemetry rather than an auditable billing ledger.
`step_finish` is not an acknowledged critical event, has no idempotency key, is not persisted in the
timeline, and is accepted without local repricing. Event loss can undercount, repeated events can
overcount, and the stored aggregate cannot be reconstructed from durable step records.

The prior Track C spec remains directionally aligned with several current facts: cost originates in
OpenCode, the Session Durable Object owns the live total, D1 is not a live enforcement source, and
global/repository/environment sandbox settings resolve into a session snapshot. Its concrete file
ownership, migration numbering, stop behavior, child settings behavior, protocol assumptions, and
several named risks are now stale or incomplete.

## Research Questions

1. Where does cost originate, and how is it transported, stored, synchronized, and displayed?
2. Which data source is current enough to describe live per-session spend?
3. How do OpenCode subtasks, Open-Inspect child sessions, and automation fan-out affect attribution?
4. Which current settings, lifecycle, prompt, auth, and client workflows intersect with spend
   limits?
5. Which assumptions in the 2026-07-22 Track C spec no longer match the repository?
6. What reliability and product gaps limit the meaning of the current aggregate?

## Current Behavior

### Cost source and event shape

`OpenCodePromptStream._handle_part()` translates an OpenCode `step-finish` part into a `step_finish`
event and copies `part.get("cost")`, `part.get("tokens")`, and the finish reason without applying a
local price table (`packages/sandbox-runtime/src/sandbox_runtime/prompt_stream.py:665-692`). The
shared schema accepts optional `cost: number`, optional scalar or structured token usage, and
optional OpenCode subtask attribution (`packages/shared/src/types/sandbox-events.ts:10-36,79-93`).

The event does not identify a currency, pricing version, provider invoice item, or unique step. The
repository contains no local token-to-cost calculation in this path. The prior spec's claim that
specific model catalog groups do not report cost is not encoded as current catalog metadata; the
code establishes only that cost may be absent.

### Delivery reliability

`BufferedEventForwarder` classifies only `execution_complete`, `error`, `snapshot_ready`,
`push_complete`, and `push_error` as critical acknowledged events
(`packages/sandbox-runtime/src/sandbox_runtime/event_forwarder.py:18-29`). `step_finish` is
delivered at most once after a successful WebSocket send. Events are buffered while disconnected or
after a send failure, but the in-memory buffer is bounded to 1,000 and evicts non-critical events
first (`event_forwarder.py:37-53,109-136,249-267`).

There is no durable sandbox-side cost journal. A successfully sent `step_finish` receives no
acknowledgement, and the event has no idempotency identifier at the control-plane boundary.

### Session Durable Object accumulation

The sandbox message router validates incoming events, then the split event processor delegates step
events to `SandboxStreamingEventHandler.handleStep()`
(`packages/control-plane/src/session/sandbox-events/processor.ts:42-117`). The handler renews
activity for both step types and increments cost only when `step_finish.cost` is a finite number
greater than zero (`packages/control-plane/src/session/sandbox-events/streaming.handler.ts:50-64`).

`SessionCoreRepository.addSessionCost()` performs an atomic SQLite increment and returns no value
(`packages/control-plane/src/session/session-core-repository.ts:150-158`). The current DO schema
stores `total_cost REAL NOT NULL DEFAULT 0` and a JSON `sandbox_settings` snapshot on the single
session row (`packages/control-plane/src/session/schema.ts:50-84`). The corresponding `SessionRow`
has no budget, warning latch, exhaustion latch, override, or cost-availability field
(`packages/control-plane/src/session/types.ts:29-54`).

Step events are deliberately not written to the durable timeline. The streaming handler documents
that steps only renew activity and accumulate cost (`streaming.handler.ts:10-16`). Consequently, the
durable aggregate cannot be reconciled against persisted step-level costs.

### D1 projection and analytics

`SessionStatusService` projects metrics when a status satisfies `isTurnSettled`: `completed`,
`failed`, or `cancelled`; `archived` is intentionally excluded
(`packages/shared/src/types/session-activity.ts:33-53`,
`packages/control-plane/src/session/session-status-service.ts:116-134`). The background metric
projection copies the current DO aggregate into D1 with other session metrics
(`session-status-service.ts:257-282`; `packages/control-plane/src/db/session-index.ts:780-797`).

D1 `sessions.total_cost` was introduced by `terraform/d1/migrations/0017_add_analytics_columns.sql`.
Analytics sum those individual D1 rows
(`packages/control-plane/src/db/analytics-store.ts:58-103,166-205`). D1 is therefore a settled-turn
mirror rather than a live cost stream. A late `step_finish` after metric projection updates the DO
aggregate without itself causing another D1 projection.

### Browser synchronization and display

Session snapshots expose optional `totalCost` through the shared server-message contract
(`packages/shared/src/types/server-messages.ts:17-52`). Snapshot construction reads the DO total,
and the reducer normalizes absent values to zero
(`packages/control-plane/src/session/snapshot-reader.ts:84-121`;
`packages/web/src/lib/session-socket/reducer.ts:91-106`).

For live events, the browser independently adds every positive finite `step_finish.cost`
(`reducer.ts:319-343`). A later `subscribed` snapshot replaces the local projection, including on
reconnect (`reducer.ts:177-201`). The details sidebar renders cost only when it is greater than zero
(`packages/web/src/components/sidebar/metadata-section.tsx:160-175`). Formatting treats the value as
dollars but does not attach provenance (`packages/web/src/lib/session-cost.ts:1-5`).

There is no dedicated live aggregate message. There is also no client state for a cap, warning
threshold, exhausted state, or unavailable cost tracking.

## Relevant Workflows

### Sandbox settings resolution and snapshotting

`SandboxSettings` is a strict Zod object containing ports, child-session count limits, resources,
sandbox lifetime, and image-build timeout. It has no monetary field
(`packages/shared/src/types/integrations.ts:204-285`). Control-plane normalization validates each
known field and omits unknown fields from normalized output
(`packages/control-plane/src/sandbox/settings.ts:23-156`). Strict boundary parsing rejects unknown
keys in external settings writes.

Sandbox settings exist at global, repository, and environment scopes in D1. Resolution merges global
defaults, primary-repository overrides, then environment overrides; defined later values win, while
`undefined` preserves inheritance (`packages/control-plane/src/db/integration-settings.ts:302-352`).
The sandbox integration is one of the integrations allowed at environment scope
(`packages/shared/src/types/integrations.ts:412-423`).

Session creation resolves sandbox-wide settings from the primary repository and optional
environment, then persists the normalized JSON in the Session DO
(`packages/control-plane/src/session/integration-settings-resolution.ts:72-175`;
`packages/control-plane/src/session/http/handlers/session-init.handler.ts:181-204`). Existing
sessions use that snapshot for spawn, restore, timeout, and runtime behavior. Repository-less
sessions use global defaults. Resolution failures return empty sandbox settings. A repository
excluded by the global sandbox `enabledRepos` allowlist also resolves to empty settings.

### OpenCode subtasks and Open-Inspect child sessions

OpenCode-internal task activity is annotated with `isSubtask` and optional child identifiers by the
sandbox runtime (`prompt_stream.py:684-692`). Cost accumulation does not inspect those fields, so
those steps contribute to the enclosing Open-Inspect session total.

An Open-Inspect child session receives its own D1 row, Durable Object, and `total_cost`. No current
query rolls child cost into a parent's aggregate. D1 now stores `root_session_id` and maintains
lineage across inserts, parent rewrites, and deletion
(`terraform/d1/migrations/0063_session_root.sql`), but cost analytics do not aggregate by root.

Child creation currently combines live and snapshotted settings. It resolves the parent's current
primary-repository and environment settings for child count admission and most child sandbox
settings, while copying the parent's snapshotted `sandboxTimeoutMs` instead of a newly resolved
timeout (`packages/control-plane/src/routes/session-child-spawn.ts:69-125`). Children are limited to
depth two and default to five concurrent and fifteen total direct children
(`session-child-spawn.ts:42,81-95,258-265`).

Default analytics exclude sessions with agent spawn source, while those child rows remain separate
(`packages/control-plane/src/db/analytics-store.ts:11-18`). Child summary and live parent update
contracts do not surface child cost (`packages/shared/src/types/session-api.ts:345-363`;
`packages/shared/src/types/server-messages.ts:183-190`).

### Prompt admission and source identity

The current message-source vocabulary is `web`, `slack`, `linear`, `extension`, `github`,
`automation`, and `agent` (`packages/shared/src/types/sessions.ts:48-59`). The HTTP prompt route is
authenticated for GitHub users or services, enforces principal identity, and defaults an omitted
source to `web` (`packages/control-plane/src/routes/session-prompt.ts:50-177`). The WebSocket
composer path explicitly uses `web` (`packages/control-plane/src/session/message-queue.ts:241-264`).

Prompt admission checks session promptability, queue capacity, attachment claims, and web request
idempotency. It has no cost or budget check (`message-queue.ts:701-875`). `created`, `active`,
`completed`, and `failed` sessions accept follow-up work; `archived` and `cancelled` sessions do not
(`packages/shared/src/types/session-activity.ts:55-67`). HTTP promptability conflicts currently
return a 409 without a typed budget code
(`packages/control-plane/src/session/http/handlers/messages.handler.ts:29-59`).

### Stop and cancellation

`MessageQueue.stopExecution()` fails only the current processing message with the fixed text
`Execution was stopped`, records and broadcasts a synthetic failed `execution_complete`, schedules
completion callbacks, reconciles session status, and sends a sandbox stop command
(`packages/control-plane/src/session/message-queue.ts:514-554,619-666`). It also creates a stop
confirmation deadline. If delivery or confirmation fails, the sandbox is terminated. Pending prompts
are retained and resume after confirmation or termination recovery (`message-queue.ts:556-573`;
`packages/web/src/components/session-prompt-composer.tsx:168-195`).

Session cancellation is distinct. It sets the session to `cancelled`, terminalizes unfinished
messages, projects status and metrics, and prevents later prompting
(`packages/control-plane/src/session/session-status-service.ts:98-134`;
`packages/control-plane/src/session/http/handlers/session-lifecycle.handler.ts:283-303`). A normal
parent cancellation does not recursively cancel descendants; the explicit child-cancellation
workflow separately supports nested cancellation.

### Warning and client surfaces

Durable runtime warnings use timeline events whose current scopes are `sync`, `setup`, `start`,
`assembly`, `secrets`, and `media` (`packages/shared/src/types/sandbox-events.ts:152-164`). The
streaming handler persists and broadcasts warning events
(`packages/control-plane/src/session/sandbox-events/streaming.handler.ts:85-93`), and the session
sidebar renders them (`packages/web/src/components/sidebar/metadata-section.tsx:439-456`).

The server protocol still includes `sandbox_warning`, but the web reducer intentionally performs no
state change for it (`packages/shared/src/types/server-messages.ts:170`;
`packages/web/src/lib/session-socket/reducer.ts:312-315`). No budget scope, budget status message,
sticky warning state, or spend-limit composer confirmation exists.

### Auth and deployment boundaries

Session runtime routes use explicit route policies. Human-only snapshot and sandbox-access routes,
user-or-service prompt/event routes, sandbox-only credential routes, and selected sandbox fallback
routes are separate policy classes (`packages/control-plane/src/routes/shared.ts:59-143`;
`packages/control-plane/src/routes/session-runtime-proxy.ts:308-414`). A sandbox principal is not
included in the ordinary user-or-service policy.

The control-plane environment contract includes sandbox inactivity, execution timeout, and secret
payload enforcement, but no spend setting (`packages/control-plane/src/types.ts:99-111`). Terraform
plumbs provider and lifecycle variables but contains no spend-limit binding
(`terraform/environments/production/workers-control-plane.tf:96-184`).

## Existing Patterns

- Sandbox configuration has strict shared schemas, control-plane normalization, scoped D1 storage,
  and resolved-at-session-creation DO snapshots.
- The secret payload cap has `enforce` and `warn` runtime modes controlled by
  `SECRETS_CAP_ENFORCEMENT`; it governs spawn/build payload validation rather than session spend
  (`packages/control-plane/src/db/secrets-validation.ts`,
  `packages/control-plane/src/types.ts:108`).
- Child-session count admission uses configurable per-parent concurrent and total limits plus a
  fixed depth limit.
- GitHub Autofix has a rolling attempts-per-PR limit, and its settings UI explicitly describes
  autonomous-work spend impact. This is a work-volume cap, not monetary accounting
  (`packages/shared/src/types/integrations.ts:20-53`;
  `packages/web/src/components/settings/integrations/github-autofix-settings-fields.tsx:140-187`).
- The scheduler has a per-tick child launch "budget" that bounds fan-out volume, not money
  (`packages/control-plane/src/scheduler/scheduler.ts:623-647`).
- Full `subscribed` snapshots are the reconnect convergence mechanism for session client state;
  semantic server messages provide live updates between snapshots
  (`docs/adr/0003-session-snapshot-handoff.md`).
- Runtime warning events are durable timeline records, while `sandbox_warning` is an imperative
  protocol message with no current reducer projection.

## Changes Since the Prior Track C Spec

The following prior assumptions no longer match the current tree:

- Session event handling is no longer centered in `session/sandbox-events.ts`. Commit `ae74cc6`
  split processing by event family; cost ingestion now belongs to
  `session/sandbox-events/streaming.handler.ts`, with orchestration in `processor.ts`.
- The broad session repository was split. Live aggregate writes now belong to
  `SessionCoreRepository` in `session-core-repository.ts`.
- The next free DO migration is not 37. Migrations 37 through 45 now exist; migration 45 stores
  Autofix admission metadata (`packages/control-plane/src/session/schema.ts:533-621`).
- DO migration 37 is the canonical D1 user reference on participants, not an unclaimed slot.
- `SandboxSettings` is now a strict inferred Zod type rather than the interface shape cited by the
  old spec (`packages/shared/src/types/integrations.ts:245-270`).
- The shared session state contract now lives in `server-messages.ts`; it is not defined in
  `shared/src/types/sessions.ts`.
- Session lifecycle predicates were centralized in `shared/src/types/session-activity.ts`, making
  the intentional difference between inactive and turn-settled statuses explicit.
- Stop execution now has an acknowledgement deadline and termination fallback, retains queued
  prompts, and resumes queue processing after stop confirmation. Its option type remains private and
  contains only `suppressStatusReconcile`; there is no custom reason option.
- The current sandbox event schema requires `sandboxId` and `timestamp` for `step_finish`. The
  current warning event contract likewise requires a timestamp and limits scope to its existing
  enum.
- Child settings are not uniformly independently resolved. Current child count limits and most
  settings resolve live, while sandbox timeout is inherited from the parent's creation snapshot.
- Message sources now include `agent`, in addition to the source set listed in the prior spec.
- Prompt identity enforcement has changed materially. The HTTP prompt route derives identity from
  the verified principal, while an omitted source still defaults to `web`.
- D1 lineage now includes `root_session_id` through migration 0063, although cost remains
  per-session and current analytics do not use root rollups.
- The old spec's named "cost tracking unavailable" honesty flag, budget warning scope, budget status
  message, budget route, latches, settings fields, and composer behavior are absent.
- The old claim that `sandbox_warning` is dropped remains true at reducer level, but the current
  reducer and transport architecture has been substantially refactored.
- Available local history cannot establish which of these changes landed between 2026-07-22 and
  2026-08-20 because the checkout is shallow.

## Constraints and Invariants

- The Session DO SQLite row is the freshest persisted aggregate for one Open-Inspect session.
- D1 cost is eventually projected at settled turns and is not guaranteed current during execution.
- Cost is trusted from OpenCode as a float. There is no local pricing version or token repricing.
- Only positive finite cost contributes to both DO and browser totals. Missing, zero, negative,
  `NaN`, and infinite values do not increment the aggregate.
- OpenCode-internal subtask cost contributes to the enclosing Open-Inspect session.
- Separate Open-Inspect children own separate totals; parent totals and default analytics do not
  represent aggregate lineage spend.
- The browser's live total is a projection and converges to the DO snapshot on subscription.
- Session settings resolve from global to primary repository to environment and are snapshotted at
  creation. Secondary repositories do not contribute sandbox settings.
- Existing settings can resolve to empty values through allowlist exclusion or resolution failure.
- `completed` and `failed` sessions remain promptable. `cancelled` and `archived` do not.
- Stop and cancel have different queue, sandbox, status, and resumability effects.
- Session protocol messages are shared-schema validated; an unknown message variant causes the
  current web transport to close with invalid-message code 4004 rather than silently accepting it
  (`packages/web/src/hooks/use-session-transport.ts:169-203`).
- D1 and DO migration number spaces are independent. Current D1 migrations extend through at least
  0063, and current DO migrations through 45.

## Known Gaps and Risks

- **Event loss undercounts spend.** `step_finish` is buffered but not acknowledged, is evictable
  from the bounded non-critical buffer, and has no durable sandbox-side journal.
- **Repeated events overcount spend.** Cost increments are unconditional and `step_finish` has no
  event identity used for deduplication.
- **The aggregate is not auditable.** Step events and their costs are omitted from the durable
  timeline, so the aggregate cannot be reconstructed or independently checked.
- **Missing cost is silent.** Token usage may exist without cost, but no session flag or user-facing
  indicator records that part of a session was unmetered.
- **Currency and pricing provenance are implicit.** The schema stores a number and the UI formats
  dollars; no currency or pricing-source metadata accompanies it.
- **D1 analytics can lag or miss late cost.** Metric projection occurs on settled status
  transitions, not on every cost event.
- **Lineage spend is fragmented.** Agent-spawned children are excluded from default analytics and
  are not rolled into the parent despite D1 root lineage being available.
- **Automation fan-out multiplies independent session totals.** Each target creates a separate
  session, and there is no invocation-level monetary aggregate in current storage.
- **Client live totals share event-delivery weaknesses.** The browser increments from the same
  non-critical stream and corrects only when a later snapshot arrives.
- **Specific unmetered model groups are not verifiable from current internal metadata.** The old
  list may reflect observed provider behavior, but the repository only models optional cost.
- **An omitted HTTP prompt source becomes `web`.** Source is not a reliable proxy for human
  supervision when a trusted service omits it.
- **`sandbox_warning` has no durable client state.** A warning event reaches the timeline, while the
  separate imperative warning message is a reducer no-op.
- **No end-to-end cost mirror test was found.** Unit and integration coverage separately test
  ingestion, SQLite increments, browser accumulation, D1 metric writes, and analytics, but not one
  real cost event through DO accumulation, settled transition, and D1 projection.
- **Historical comparison is incomplete.** The local shallow clone omits the first month after the
  prior spec's baseline.

## Open Questions

1. What product boundary does "session spend" denote: one Session DO, an Open-Inspect root lineage,
   an automation invocation, or another operator-visible unit?
2. Is OpenCode-reported cost considered sufficiently complete and stable for enforcement, or only
   for informational telemetry?
3. Which current models and provider account modes emit absent, delayed, zero, or corrected cost in
   production event streams?
4. How often do non-critical event loss, reconnect buffering, duplicate delivery, or late
   post-settlement cost occur in observed sessions?
5. Does spend include only model cost, or also sandbox provider, image build, storage, and network
   consumption that are not represented by `step_finish.cost`?
6. Which identities are permitted to observe or alter monetary controls in a multiplayer session?
7. How is human supervision distinguished from service-originated traffic when HTTP source defaults
   to `web`?
8. What user and bot behavior is expected when pending prompts remain after a cost-triggered
   interruption?
9. What precision, rounding, and comparison semantics match the upstream cost values used in
   production?
10. Are cost corrections or refunds emitted upstream, given that current aggregation ignores zero
    and negative values?

## Evidence

- `packages/sandbox-runtime/src/sandbox_runtime/prompt_stream.py`: OpenCode step-finish translation
  and subtask attribution.
- `packages/sandbox-runtime/src/sandbox_runtime/event_forwarder.py`: critical-event acknowledgement,
  reconnect buffer, and delivery limits.
- `packages/shared/src/types/sandbox-events.ts`: current cost, token, warning, and event schemas.
- `packages/control-plane/src/session/sandbox-events/streaming.handler.ts`: current cost ingestion
  and timeline persistence split.
- `packages/control-plane/src/session/session-core-repository.ts`: authoritative DO aggregate write.
- `packages/control-plane/src/session/schema.ts`: current DO schema and migrations through 45.
- `packages/control-plane/src/session/types.ts`: current persisted session row shape.
- `packages/control-plane/src/session/session-status-service.ts`: settled-turn D1 projection.
- `packages/shared/src/types/session-activity.ts`: promptable, inactive, and turn-settled semantics.
- `packages/control-plane/src/db/session-index.ts`: D1 metric mirror write.
- `packages/control-plane/src/db/analytics-store.ts`: D1 aggregate analytics and default source
  filter.
- `terraform/d1/migrations/0017_add_analytics_columns.sql`: D1 total-cost column.
- `terraform/d1/migrations/0063_session_root.sql`: current root lineage storage.
- `packages/shared/src/types/integrations.ts`: strict sandbox settings and existing non-monetary
  caps.
- `packages/control-plane/src/sandbox/settings.ts`: sandbox settings normalization.
- `packages/control-plane/src/db/integration-settings.ts`: scoped settings storage and merge order.
- `packages/control-plane/src/session/integration-settings-resolution.ts`: primary-repository and
  environment resolution behavior.
- `packages/control-plane/src/routes/session-child-spawn.ts`: child admission and hybrid settings
  inheritance.
- `packages/control-plane/src/session/message-queue.ts`: prompt admission, stop behavior, callbacks,
  and queue continuation.
- `packages/control-plane/src/routes/session-prompt.ts`: HTTP identity and source defaulting.
- `packages/shared/src/types/server-messages.ts`: session snapshot and live protocol contract.
- `packages/web/src/lib/session-socket/reducer.ts`: browser cost projection and warning no-op.
- `packages/web/src/components/sidebar/metadata-section.tsx`: cost and warning presentation.
- `packages/web/src/components/session-prompt-composer.tsx`: current composer, queue, and stop UX.
- `packages/control-plane/src/types.ts`: current worker runtime variables.
- `terraform/environments/production/workers-control-plane.tf`: current control-plane bindings.
- `docs/adr/0003-session-snapshot-handoff.md`: snapshot and reconnect synchronization invariant.
- `git log`: available refactor history from the shallow 2026-08-21 boundary onward.

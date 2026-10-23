# Pi first-class harness — Open-Inspect conformance audit

## Result and authority

This audit is subordinate to `/Users/param/Documents/Compound/OPEN-INSPECT-REFERENCE-MODEL.md` §7
and the independent `pi-conformance/verify.py` judge. `conformance.json` is the machine-checkable
claim; this file explains the current design without preserving historical failures as if they were
current facts.

Pi is an ordinary harness on a reusable in-process runtime seam. Open-Inspect remains the sole
authority for identity, team membership, RBAC, D1 state, budget, audit, lifecycle, and export. The
Pi adapter owns Pi vocabulary and maps it onto neutral core ports. Compound-only personal MCP,
external-action approvals, and cross-session messaging remain in the off-by-default overlay after
`oi-core-end`.

## First-principles boundary

- **Propose versus decide:** the model proposes actions; SessionDO re-reads the turn author and
  current D1 authority at the moment of use. A cached token or recorded actor is never treated as
  current authorization.
- **No sandbox impersonation:** an in-process harness uses the neutral execution-principal and
  runtime ports. It never forges a sandbox or service principal.
- **No secret-bearing runtime:** binding scoping happens before PiSessionDO starts. Model-reachable
  code cannot access D1, signing material, encryption keys, service secrets, or deployment
  credentials.
- **Neutral lifecycle:** initialization, FIFO dispatch, lookup, cancellation, archive, restore, and
  deletion flow through `InProcessHarnessRuntime`; Pi is only its first adapter.
- **Trusted accounting:** every provider terminal response is metered before the harness sees it.
  Durable cumulative cost is computed from measured counters and the server-held price table;
  provider-reported `usage.cost` is ignored.
- **Rollback safety:** every in-process session state persists with a `durable_` marker, and enabled
  in-process automations persist a non-legacy enabled marker. Current code decodes them only after
  validating the harness; an older binary can neither reopen the session nor fire the automation as
  OpenCode.
- **Archive completeness:** archiving fences new work before its first await, aborts runtime work,
  drains every canonical projection, persists quiescence, and fails closed if delivery is
  incomplete. Only explicit unarchive clears the marker.

## Strict pending-user decisions

- **Browser Rendering network containment:** strict option selected. The feature remains unavailable
  even when flagged on because the binding cannot constrain redirects and subresources to reviewed
  hosts. The transport fails closed until enforceable per-request interception exists.
- Other open product choices remain behind their stricter flagged behavior and do not weaken any §7
  invariant.

## Core versus overlay

| Layer        | Contents                                                                                                                                    | Rule                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Core seam    | Harness-neutral runtime, authority, action ceiling, deadline, pricing, accounting, event, archive, export, and sandbox-escalation contracts | May not name Pi or any Compound deviation                          |
| Core adapter | Pi runtime, provider adapter, Pi Durable Object, Code Mode Worker, workspace and event translation                                          | May name Pi; may only adapt neutral contracts                      |
| Overlay      | Personal MCP/OAuth, external-action approvals, cross-session messaging                                                                      | After `oi-core-end`, off by default, documented in `DEVIATIONS.md` |

## §7 row evidence

Every PASS below has a unique delete-the-check mutation. Exact mutation commands and complete
citations are in `conformance.json`.

| Row | Status | Primary implementation evidence                                                                                                                                                                                            | Regression proof                                                                                                                                                 |
| --- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | PASS   | `packages/shared/src/harnesses.ts:29`                                                                                                                                                                                      | `packages/shared/src/harnesses.test.ts` — lists only harnesses the runtime can boot, built-in first                                                              |
| A2  | PASS   | `packages/control-plane/src/db/session-row.ts:1`                                                                                                                                                                           | `packages/control-plane/test/integration/d1-session-index.test.ts` — persists promptable in-process rows with a rollback-safe status marker                      |
| A3  | PASS   | `packages/shared/src/harnesses.ts:135`                                                                                                                                                                                     | `packages/shared/src/harnesses.test.ts` — rejects a model the harness cannot run                                                                                 |
| A4  | PASS   | `packages/control-plane/src/harness-admission.ts:40`                                                                                                                                                                       | `packages/control-plane/src/harness-admission.test.ts` — checks current native model availability and resolved auth again at dispatch                            |
| A5  | PASS   | `packages/shared/src/harnesses.ts:78`                                                                                                                                                                                      | `packages/shared/src/harnesses.test.ts` — lists only harnesses the runtime can boot, built-in first                                                              |
| A6  | N/A    | The stored-harness resolution never reads a resume field for this harness: the catalogue entry carries it only because upstream's HarnessCapabilities type requires the field, so no invented semantics reach the runtime. | —                                                                                                                                                                |
| B-1 | PASS   | `packages/control-plane/src/routing/route-admission.ts:1`                                                                                                                                                                  | `packages/control-plane/test/integration/route-admission-matrix.test.ts` — admits exactly the credential classes each route's policy accepts                     |
| B-2 | PASS   | `packages/control-plane/src/routing/identity-enforcement.ts:1`                                                                                                                                                             | `packages/control-plane/src/auth/identity-enforcement.test.ts` — returns the canonical id only when it matches the admitted authorization subject                |
| B-3 | PASS   | `packages/control-plane/src/authorization/service-permissions.ts:1`                                                                                                                                                        | `packages/control-plane/src/authorization/service-permissions.test.ts` — allows launch capabilities but denies management capabilities                           |
| B-4 | PASS   | `packages/control-plane/src/harness/execution-principal.ts:44`                                                                                                                                                             | `packages/control-plane/src/harness/execution-principal.test.ts` — parses the SessionDO creation snapshot and current emergency policy                           |
| B-5 | PASS   | `packages/control-plane/src/session/http/handlers/browser-gateway.handler.ts:1`                                                                                                                                            | `packages/control-plane/src/session/http/handlers/browser-gateway.handler.test.ts` — refuses a request after the turn author loses current authority             |
| B-6 | PASS   | `packages/control-plane/src/session/http/handlers/harness-sandbox-execution.handler.ts:1`                                                                                                                                  | `packages/control-plane/src/session/http/handlers/harness-sandbox-execution.handler.test.ts` — refuses a command after the turn author loses current authority   |
| B-7 | PASS   | `packages/control-plane/src/harness/action-ceiling.ts:1`                                                                                                                                                                   | `packages/control-plane/src/pi/tool-policy-extension.test.ts` — refuses the turn when the action ceiling is reached                                              |
| B-8 | PASS   | `packages/control-plane/src/cloudflare/pi-durable-object.ts:299`                                                                                                                                                           | `packages/control-plane/test/integration/pi-session-do.test.ts` — holds no deployment secret in its runtime bindings                                             |
| B-9 | PASS   | `packages/control-plane/src/routing/identity-enforcement.ts:1`                                                                                                                                                             | `packages/control-plane/src/auth/identity-enforcement.test.ts` — restricts callbackContext to callback-owning bots                                               |
| C1  | PASS   | `packages/control-plane/src/session/http/handlers/personal-mcp-session.handler.ts:1`                                                                                                                                       | `packages/control-plane/src/session/http/handlers/mcp-session.handler.test.ts` — refuses a read after the turn author loses current authority                    |
| C2  | PASS   | `packages/control-plane/src/session/message-queue.ts:795`                                                                                                                                                                  | `packages/control-plane/src/session/message-queue.test.ts` — dispatches Pi prompts without consulting, spawning, or sending to a sandbox                         |
| C3  | PASS   | `packages/control-plane/src/pi/projection-outbox.ts:1`                                                                                                                                                                     | `packages/control-plane/test/integration/pi-export-projection.test.ts` — puts a Pi turn's tool call and its completion in the session's events                   |
| C4  | PASS   | `packages/control-plane/src/session/sandbox-events/processor.ts:62`                                                                                                                                                        | `packages/control-plane/src/session/sandbox-events/processor.test.ts` — correlates tool processing without logging content or credentials                        |
| C5  | PASS   | `packages/control-plane/src/session/message-queue.ts:1`                                                                                                                                                                    | `packages/control-plane/src/session/message-queue.test.ts` — dispatches Pi prompts without consulting, spawning, or sending to a sandbox                         |
| C6  | PASS   | `packages/control-plane/src/session/sandbox-events/execution.handler.ts:63`                                                                                                                                                | `packages/control-plane/test/integration/pi-export-projection.test.ts` — puts a Pi turn's tool call and its completion in the session's events                   |
| C7  | PASS   | `packages/control-plane/src/session/sandbox-events/processor.ts:62`                                                                                                                                                        | `packages/control-plane/src/session/sandbox-events/processor.test.ts` — correlates tool processing without logging content or credentials                        |
| C8  | PASS   | `packages/control-plane/src/harness/turn-authority.ts:1`                                                                                                                                                                   | `packages/control-plane/test/integration/turn-authority.test.ts` — denies an author who is not on the session                                                    |
| D-1 | PASS   | `packages/control-plane/src/pi/computer-workspace-policy.ts:47`                                                                                                                                                            | `packages/control-plane/src/pi/computer-workspace-policy.test.ts` — blocks oversized content and paths outside scratch                                           |
| D-2 | PASS   | `packages/control-plane/src/pi/codemode-extension.ts:1`                                                                                                                                                                    | `packages/control-plane/src/pi/codemode-durable.test.ts` — aborts the active script and its nested call                                                          |
| D-3 | PASS   | `packages/control-plane/src/harness/turn-deadline.ts:60`                                                                                                                                                                   | `packages/control-plane/src/harness/turn-deadline.test.ts` — expires when the deadline passes                                                                    |
| D-4 | PASS   | `packages/control-plane/src/pi/projection-outbox.ts:1`                                                                                                                                                                     | `packages/control-plane/test/integration/pi-export-projection.test.ts` — puts a Pi turn's tool call and its completion in the session's events                   |
| D-5 | PASS   | `packages/control-plane/src/cloudflare/browser-rendering-transport.ts:1`                                                                                                                                                   | `packages/control-plane/src/pi/browser-transport.test.ts` — fails closed when the binding cannot constrain redirects and subresources                            |
| D-6 | PASS   | `packages/control-plane/src/pi/external-action-policy-extension.ts:117`                                                                                                                                                    | `packages/control-plane/src/pi/external-action-policy-extension.test.ts` — refuses a new effect when the live deployment policy denies it                        |
| E-1 | PASS   | `packages/control-plane/src/pi/codex-credential-store.ts:1`                                                                                                                                                                | `packages/control-plane/src/pi/codex-credential-store.test.ts` — rechecks broker authority even while the cached token remains valid                             |
| E-2 | PASS   | `packages/control-plane/src/session/provider-account-resolution.ts:78`                                                                                                                                                     | `packages/control-plane/src/session/provider-account-resolution.test.ts` — keeps an explicit connected account ahead of unattended default policy                |
| E-3 | PASS   | `packages/control-plane/src/source-control/credential-scope.ts:15`                                                                                                                                                         | `packages/control-plane/src/source-control/credential-scope.test.ts` — refuses more than 500 unique ids without truncating the set                               |
| E-4 | PASS   | `packages/control-plane/src/session/pull-request-service.ts:46`                                                                                                                                                            | `packages/control-plane/src/session/pull-request-service.per-branch.test.ts` — reports the resolved head, base, and updated=false on creation                    |
| E-5 | PASS   | `packages/control-plane/src/cloudflare/mcp-connection-durable-object.ts:35`                                                                                                                                                | `packages/control-plane/test/integration/mcp-connections.test.ts` — derives ownership from the human principal and never the request body                        |
| E-6 | PASS   | `packages/control-plane/src/mcp/egress-policy.ts:34`                                                                                                                                                                       | `packages/control-plane/src/mcp/egress-policy.test.ts` — refuses an endpoint that carries credentials                                                            |
| E-7 | PASS   | `packages/control-plane/src/cloudflare/mcp-connection-durable-object.ts:63`                                                                                                                                                | `packages/control-plane/test/integration/mcp-connections.test.ts` — rechecks durable D1 authority before every broker tool call                                  |
| E-8 | PASS   | `packages/control-plane/src/mcp/egress-policy.ts:21`                                                                                                                                                                       | `packages/control-plane/src/mcp/egress-policy.test.ts` — refuses an endpoint that carries credentials                                                            |
| E-9 | PASS   | `packages/control-plane/src/cloudflare/mcp-connection-durable-object.ts:35`                                                                                                                                                | `packages/control-plane/test/integration/mcp-connections.test.ts` — closes the dormant transport cache and clears credentials before D1 cascade deletion         |
| F-1 | PASS   | `packages/control-plane/src/routes/session-create.ts:78`                                                                                                                                                                   | `packages/control-plane/test/integration/route-admission-matrix.test.ts` — admits exactly the credential classes each route's policy accepts                     |
| F-2 | PASS   | `packages/control-plane/src/session/http/handlers/session-init.handler.ts:142`                                                                                                                                             | `packages/control-plane/src/session/http/handlers/session-init.handler.test.ts` — initializes the separate durable runtime without creating or warming a sandbox |
| F-3 | PASS   | `packages/control-plane/src/scheduler/scheduler.ts:622`                                                                                                                                                                    | `packages/control-plane/src/scheduler/scheduler.test.ts` — resolves one provider auth snapshot for every child in a fan-out invocation                           |
| F-4 | PASS   | `packages/control-plane/src/authorization/slack-post-gate.ts:9`                                                                                                                                                            | `packages/control-plane/src/authorization/slack-post-gate.test.ts` — refuses a missing session even for an unbound channel                                       |
| F-5 | PASS   | `packages/control-plane/src/scheduler/scheduler.ts:223`                                                                                                                                                                    | `packages/control-plane/src/scheduler/scheduler.test.ts` — appends workspace session instructions to a new Slack automation session                              |
| F-6 | PASS   | `packages/control-plane/src/routes/session-child-spawn.ts:1`                                                                                                                                                               | `packages/control-plane/test/integration/spawn-children.test.ts` — rejects when depth >= 2 (403)                                                                 |
| G-1 | PASS   | `packages/shared/src/overlay-migration-reservations.ts:1`                                                                                                                                                                  | `packages/shared/src/migration-reservations.test.ts` — assigns the cross-cutting feature migration ranges                                                        |
| G-2 | PASS   | `packages/control-plane/src/session/schema.ts:210`                                                                                                                                                                         | `packages/control-plane/src/session/schema.test.ts` — has unique, strictly increasing migration ids                                                              |
| G-3 | PASS   | `packages/control-plane/src/cloudflare/pi-durable-object.ts:1`                                                                                                                                                             | `packages/control-plane/test/integration/pi-session-do.test.ts` — preserves its durable record for an archive without deleting it                                |
| G-4 | PASS   | `packages/control-plane/src/session/components.ts:951`                                                                                                                                                                     | `packages/control-plane/test/integration/session-components.test.ts` — builds the whole graph on a correctly configured deployment                               |
| G-5 | PASS   | `packages/control-plane/src/cloudflare/pi-durable-object.ts:1`                                                                                                                                                             | `packages/control-plane/test/integration/pi-session-do.test.ts` — refuses to confirm an archive while a transcript event is undelivered                          |
| G-6 | PASS   | `packages/shared/src/types/audit-events.ts:28`                                                                                                                                                                             | `packages/shared/src/types/audit-events.test.ts` — keeps shadow observations separate from operation actions                                                     |
| H-1 | PASS   | `packages/control-plane/src/session/budget-service.ts:154`                                                                                                                                                                 | `packages/control-plane/src/session/budget-service.pi.test.ts` — routes a running Pi step across a tiny cap through exact Pi stop                                |
| H-2 | PASS   | `packages/control-plane/src/harness/trusted-usage-meter.ts:1`                                                                                                                                                              | `packages/control-plane/src/harness/trusted-usage-meter.test.ts` — prices measured usage only through the server-held price table                                |
| H-3 | PASS   | `packages/control-plane/src/harness/budget-gate.ts:52`                                                                                                                                                                     | `packages/control-plane/src/harness/budget-gate.test.ts` — refuses the call once the limit is reached                                                            |
| I-1 | PASS   | `packages/control-plane/src/memory/session-memory-service.ts:39`                                                                                                                                                           | `packages/control-plane/src/memory/session-memory-service.test.ts` — denies a write when the principal can no longer read the partition                          |
| I-2 | PASS   | `packages/control-plane/src/pi/managed-skills-extension.ts:11`                                                                                                                                                             | `packages/control-plane/src/pi/managed-skills-extension.test.ts` — reads only declared skill resources                                                           |
| I-3 | PASS   | `packages/control-plane/src/pi/managed-skills-extension.ts:11`                                                                                                                                                             | `packages/control-plane/src/pi/managed-skills-extension.test.ts` — activates a managed skill through Pi's output contract                                        |
| I-4 | PASS   | `packages/control-plane/src/session/http/handlers/sandbox.handler.ts:1`                                                                                                                                                    | `packages/control-plane/src/session/http/handlers/sandbox.handler.test.ts` — creates a media artifact row and matching timeline event                            |

## Suspect closure

| Suspect | Verdict | Evidence                                                                                                                        |
| ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1       | fixed   | `packages/control-plane/src/cloudflare/pi-durable-object.ts:299`<br>`packages/control-plane/src/cloudflare/binding-scope.ts:33` |
| 2       | fixed   | `packages/shared/src/harnesses.ts:95`<br>`packages/control-plane/src/harness-admission.ts:40`                                   |
| 3       | fixed   | `packages/shared/src/harnesses.ts:78`                                                                                           |
| 4       | fixed   | `packages/control-plane/src/cloudflare/mcp-connection-durable-object.ts:63`                                                     |
| 5       | fixed   | `packages/control-plane/src/cloudflare/mcp-connection-durable-object.ts:63`                                                     |
| 6       | fixed   | `packages/control-plane/src/pi/codemode-extension.ts:1`                                                                         |
| 7       | fixed   | `packages/shared/src/migration-reservations.ts:31`                                                                              |
| 8       | fixed   | `packages/control-plane/src/session/sandbox-events/execution.handler.ts:63`                                                     |
| 9       | fixed   | `packages/control-plane/src/harness/accounting.ts:1`                                                                            |
| 10      | fixed   | `packages/control-plane/src/harness/turn-authority.ts:1`                                                                        |
| 11      | fixed   | `packages/control-plane/src/session/provider-account-resolution.ts:100`                                                         |
| 12      | fixed   | `packages/control-plane/src/pi/projection-outbox.ts:1`                                                                          |
| 13      | killed  | `features/pi-first-class/DEVIATIONS.md:1`                                                                                       |
| 14      | killed  | `features/pi-first-class/LAYERS.md:1`                                                                                           |

## Fresh-review findings closed

1. Browser, shared/personal MCP, sandbox execution, Code Mode, memory, external actions,
   credentials, and cross-session calls re-check current turn-author authority.
2. The credential facade contacts the broker for every model call; token freshness never substitutes
   for authorization freshness.
3. `TrustedUsageMeter` persists measured counters and prices them with the server-held model
   catalogue before terminal provider events are released.
4. Browser Rendering fails closed because reviewed-host containment cannot cover redirects and
   subresources.
5. Rollback-safe persisted status markers prevent an older binary from interpreting Pi rows as
   OpenCode.
6. Archive cannot confirm with undelivered projections and stays quiescent across object restart
   until explicit restore.
7. Core initialization, queue, stop, archive, restore, and deletion use neutral in-process runtime
   ports rather than Pi identity branches.
8. Model budget reads and memory actions re-enter the turn author's current D1 authority and fail
   closed when SessionDO cannot answer.
9. Native model-producing controls use the same action ceiling and runtime deadline as queued
   prompts; busy follow-ups are refused rather than becoming mid-turn steering.
10. Slack and automation launch paths preserve the stored harness and refuse an unavailable or
    unknown selection instead of falling back to OpenCode.
11. Personal MCP connection creation and authorization require the current `mcp_servers.read`
    entitlement, in addition to owner checks.
12. Unattended external actions decline deterministically unless a current automation grant
    authorizes the exact provider and action.
13. SessionDO's canonical messages/events projection is the authoritative bounded export; Pi no
    longer advertises an intentionally incomplete parallel transcript.
14. Core composes deployment extensions through default-empty runtime, session-service, route, and
    schema registries. Only the overlay composition root imports Compound implementations.

## Verification state

The judge report is the completion authority. Do not infer completion from this document: only two
consecutive clean `verify.py --all` runs plus a fresh no-context `VERDICT: CLEAN` satisfy the goal.

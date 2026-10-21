# First-class Pi go-live integration plan

Branch: `feat/pi-go-live-integration-v2`

Base: `814ed3e610a8f4371b40554e7ffd8fd7f716be2c` (`feat/pi-first-class`)

Started: 2026-10-19

This is the execution ledger for the final Pi go-live integration. A box is checked only beside
local evidence. Live credentials, provider calls, pushes, and deployments are excluded.

## Authority and non-regression invariants

1. SessionDO exclusively owns the Open-Inspect product session: participants, presence, typing/read
   state, author identity, canonical human messages and shared timeline ordering, WebSocket
   snapshots/events, visibility/team/collaborators, budgets, callbacks, approvals, audit,
   archive/delete/export, and external-effect ledgers.
2. Pi Durable owns only subordinate model execution state: its model-facing transcript, inbox,
   conversations, tasks, compaction, journals, and usage. Pi conversation/task IDs are opaque within
   the owning SessionDO and never define a separate product room or transcript.
3. D1 exclusively owns long-lived credentials, grants, OAuth authority, and cross-session receipts.
4. Browsers, bots, and public routes reach Pi only through SessionDO. `PiSessionDO` has no public
   route and receives no D1 binding.
5. OpenCode, Claude, Codex, web, Slack, automation, provider, sandbox, snapshot, and image behavior
   is frozen unless an explicit Pi-only feature gate selects the additive path.
6. New risky features default off. Migrations are additive. Rollback retains bindings, classes,
   storage, receipt readers, cancellation, replay, status, and deletion paths for admitted sessions.
7. Credentials never enter Pi SQLite, Computer VFS, Code Mode, command argv/environment, execution
   images, prompts, events, exports, journals, logs, browser state, or error text.
8. TypeScript durations are milliseconds and Python durations are seconds; each default has one
   named definition with the unit in its name.
9. Shared contracts build before their consumers.

## Version and source baseline

Exact repository pins in `packages/control-plane/package.json` and `package-lock.json`:

| Component                     | Exact version | Contract used here                                      |
| ----------------------------- | ------------: | ------------------------------------------------------- |
| Pi Durable / Pi AI / Chord    |         1.3.0 | Harness, inbox, conversations, tasks, compaction, usage |
| Pi Code Mode                  |         1.3.0 | native extension and remote sandbox journal             |
| Cloudflare Agents / PiHarness |        0.28.1 | Lifecycle and durable harness adapter                   |
| Cloudflare Computer           |         0.5.1 | preview VFS only, least-authority facade                |
| MCP client                    |         2.3.1 | broker-private transport, never credential authority    |
| Wrangler                      |       4.103.0 | exact local deploy/canary command generation only       |

The implementation is checked against the pinned package source/types and current official
Cloudflare Workers, Durable Objects, Queues, service bindings, Wrangler versions/deployments, and
MCP transport/OAuth documentation. Newer upstream APIs are not assumed to exist in these pins.

Official references reviewed on 2026-10-19:

- Cloudflare Agents [Pi harness](https://developers.cloudflare.com/agents/harnesses/pi),
  [extensions](https://developers.cloudflare.com/agents/harnesses/pi/extensions),
  [Browser](https://developers.cloudflare.com/agents/tools/browser/), and
  [MCP OAuth](https://developers.cloudflare.com/agents/guides/oauth-mcp-client).
- Cloudflare Browser Run [overview](https://developers.cloudflare.com/browser-run/),
  [limits](https://developers.cloudflare.com/browser-run/limits/), and
  [Kitesurf](https://developers.cloudflare.com/browser-run/kitesurf/). Browser capability is not
  implemented in this repository.
- Cloudflare Workers [observability](https://developers.cloudflare.com/workers/observability),
  [versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments),
  and
  [gradual deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments).
- Cloudflare Queues
  [at-least-once delivery](https://developers.cloudflare.com/queues/reference/delivery-guarantees),
  which requires D1 idempotent claims rather than assuming exactly-once Queue delivery.
- Official MCP
  [authorization guidance](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/authorization)
  and the Tier-1 [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).
- Pi Durable 1.3 package source/types and the upstream
  [Pi repository](https://github.com/earendil-works/pi); repository pins, not current-main APIs,
  remain the compile-time authority.

## Reachable baseline traces

### Web

1. Composer draft warming: `packages/web/src/hooks/use-warm-draft-session.ts` -> BFF
   `packages/web/src/app/api/sessions/route.ts` -> control-plane `POST /sessions` in
   `packages/control-plane/src/routes/session-create.ts` -> binding-only SessionDO `/internal/init`.
2. First prompt: `use-first-prompt-launch.ts` -> `lib/first-prompt-delivery.ts` -> BFF
   `/api/sessions/[id]/prompt` -> SessionDO prompt route -> `SessionMessageQueue`.
3. Live/replay: `use-session-transport.ts` obtains a BFF WS token, opens `/sessions/:id/ws`, and
   `use-session-socket.ts` composes replayed events through the reducer.
4. Pi creation enters `SessionInitHandler`, persists the complete capability snapshot, initializes
   `PiSessionDO`, and explicitly skips sandbox warming. Pi prompt dispatch takes the dedicated
   `SessionMessageQueue.dispatchPiMessage` branch. Existing harnesses keep the sandbox branch.

### Existing sandbox harnesses

`SessionMessageQueue` persists and claims a message, then waits for an attached ready socket or asks
`SandboxLifecycle.spawnSandbox()` to create/restore. Provider rows, bridge connect, boot phases,
managed skills, harness ready, prompt dispatch, stop, preservation, and snapshot remain under the
existing SessionDO/sandbox lifecycle. OpenCode, Claude, and Codex do not call `PiRuntimeDispatch`.

### Pi durable path

`SessionDO` owns the outer message and migration-62 dispatch fence. It calls `PiRuntimeDispatch`
with `operationId = message.id`; `PiSessionDO` uses PiHarness for admission/execution and projects
an immutable operation-local outbox back through the binding-only `/internal/pi/*` bridge. SessionDO
persists/broadcasts normalized events, usage, budget decisions, callbacks, and terminal state. Pi
creation and ordinary prompting create no sandbox row.

Explicit human Pi controls also terminate at SessionDO. SessionDO records one completed canonical
message and ordinary `user_message` event with the verified participant before dispatching the
idempotent Pi receipt. Pi internal assistant text is not a BFF/timeline source; public child views
contain opaque conversation ancestry, status, tasks, usage, cost, and fork entry IDs only.

Repository reads enter `open-inspect` tools, call the SessionDO capability bridge for fresh scope,
and read immutable provider blobs. Writable repository overlays and Computer VFS are capability
gated and default off. Code Mode is a private auxiliary Worker and default off.

`/workspace/scratch` and `/workspace/repos/N` are paths in one credential-free Computer VFS scoped
to PiSessionDO. They are not Open-Inspect workspace/team concepts. There is no browser VFS route or
cross-session path. See `MULTIPLAYER-COMPATIBILITY-AUDIT.md` for capability placement, current
Browser/Kitesurf research, and the only authorized future cross-session route.

### Bots and automations

- GitHub and Linear reject/fallback from Pi where their diff/mutation/publication contract is not
  available. This remains frozen until provider-specific canaries pass.
- Automation may select Pi and reuses existing SessionDO callback/accounting authority.
- Slack `routes/events.ts` verifies Slack, deduplicates through its current KV projection, resolves
  target/settings, creates a session through the control plane, sends the prompt, and receives
  signed activity/completion callbacks. Follow-ups reuse the mapped Open-Inspect session. Slice 3
  replaces ingress durability without changing callback authority.

## Latency and telemetry contract

Structured timestamps/spans contain no prompt, tool output, repository content, token, credential,
or raw webhook body. Every record uses stable IDs plus these dimensions where applicable: `harness`,
`executionBackend`, `source`, `cold`, repository count/mode, capability modes, model, recovery
count, and sandbox-avoidance count.

Milestones: ingress, durable ingress, acknowledgement, activity, session create, SessionDO init, Pi
init/open, prompt persisted, prompt claimed, Pi submit/admission, provider broker, model request,
first token committed, projected, and client-visible, terminal, and callback.

SLOs for the personal Pi canary:

- Slack acknowledgement p95 < 500 ms.
- Slack assistant activity p95 < 1 s from ingress claim.
- Pi admission p95 < 1 s from durable prompt claim (excluding provider model latency).
- Warm web first-token overhead (ingress to model request, excluding provider) p95 < 1 s.
- Every ordinary Pi prompt records `sandboxAvoided = 1`; eager provider blob/ref, Computer/VFS, and
  Code Mode creation counters remain zero until the corresponding tool is called.

## Sequential slices

### Slice 0 — characterization and latency

- [x] Pin web warm/create/prompt/WS/replay and existing harness spawn/ready/stop/snapshot behavior —
      unchanged full control-plane unit suite: 5,111 passed/1 skipped.
- [x] Pin Pi no-sandbox behavior and GitHub/Linear fallback, automation callback, and Slack ingress,
      thread continuation, activity, and completion behavior. Focused queue/init/projection tests:
      149 passed; Slack full suite: 638 passed.
- [x] Add secret-free milestone spans and dimensions at existing ownership boundaries — SessionDO,
      PiSessionDO, projection visibility, terminal/callback scheduling, and Slack ingress/ACK logs
      contain IDs, dimensions, timestamps, and durations but no content or credentials.
- [x] Fault and regression tests pass; commit evidence recorded below.

### Slice 1 — server capabilities and truly lazy first token

- [x] Add one server-authoritative `/capabilities` contract and route reporting binding
      reachability, harness/auth/model constraints, Pi modes, exact versions, and canary readiness
      without secrets — shared strict schema plus public control-plane route and sentinel test.
- [x] Web BFF/SWR and Slack consume the server contract; independent build/env Pi advertising now
      fails closed while ordinary harnesses remain available during capability outages.
- [x] Session creation stores only repository identities/positions/base branches, skill snapshot,
      and feature snapshot. It resolves no repository ref/blob or provider pin and opens no
      Computer/VFS, Code Mode, or sandbox — workerd idle-open test proves no VFS tables.
- [x] First repository tool call obtains fresh SessionDO authorization/ref, atomically latches the
      immutable identity-matching winner, and performs the direct read only then; crash recovery
      reuses SessionDO's claimed baseline.
- [x] Workspace facade creates Computer only on the first workspace call — focused unit and workerd
      tests cover zero-open, first-call open, reuse, eviction, quota, and deletion.
- [x] Tests prove an ordinary Pi open has zero sandbox rows, provider ref/blob calls, Computer/VFS
      tables, or Code Mode RPC; Slack launch consumes capabilities without changing non-Pi fallback.

### Slice 2 — personal web production vertical

- [x] Pi visibility requires server capability plus a ready compatible provider account.
- [x] UI accurately distinguishes Instant/durable from sandbox capabilities and includes operator
      diagnostics without sandbox-only copy or controls.
- [ ] Browser E2E covers no-repo, lazy direct read, follow-up, stop, budget, reload/eviction,
      delete, and absence of eager resources.
- [x] Credential sentinels are absent from Pi SQLite/VFS/journals after broker use; existing
      redacted event/export contracts cover SessionDO projections. Live log verification remains a
      canary. journals.

### Slice 3 — durable Slack ingress and instant Pi

#### Slice 3A — control-plane ingress authority

- [x] D1 0092 reserves bounded Slack ingress receipts with immutable source/event identity, stable
      session/message IDs, actor/team links, leases, deadlines, attempts, terminal retention
      indexes, and restrictive user/team deletion semantics.
- [x] Portable store implements idempotent admission, hash verification, atomic claims, lease
      recovery, expected-state transitions, terminal cleanup, and response-loss reconciliation.
- [x] Service-auth routes admit only `slack-bot`; strict shared schemas expose no secret-bearing log
      fields. User merge repoints actor authority before deletion.
- [x] Fresh migration, duplicate/conflict, concurrent claim, lease expiry, stale-owner CAS,
      deadline, staged completion, retention, user merge, route policy, and SQL portability tests
      pass.

#### Slice 3B — durable ACK handoff

- [x] D1 migration 0092 adds bounded ingress receipts; Queue and DLQ bindings default safely.
- [x] Verify signature/schema, commit the exact bounded event receipt and queue admission before
      ACK, then race `waitUntil` fast path and Queue through one D1 idempotent claim.
- [x] Slack KV mapping/dedupe is a cache projection recoverable from D1.
- [x] Stable Slack event ID determines session-create and first-prompt request IDs; session ID is
      durable before initialization/prompt and every retry reuses IDs.
- [x] Activity follows claim immediately; Queue failure/429, fast-path/Queue race, dispatcher
      failure, duplicate redelivery, DLQ observability, and flag-off compatibility are covered. The
      launcher-level exactly-once session/prompt/reply reconciliation remains Slice 3C.
- [x] Crash-boundary tests prove exactly one session, prompt, and mapping; the existing completion
      Queue keeps one reply per message. Follow-ups use the same SessionDO/Pi conversation.

#### Slice 3C — exactly-once session, prompt, and thread continuity

- [x] Stable identities are accepted only from `slack-bot`, persisted before SessionDO init, and
      reused through D1/DO and prompt response-loss retries without caller-forged user identity.
- [x] D1 0095 owns completed thread mappings; KV repairs from it after loss while existing channel,
      team, and closure-tombstone authorization remains unchanged.
- [x] Create, prompt intent, mapping, and completion use receipt CAS stages. Retryable ambiguity
      releases the lease, while exhausted DLQ work terminalizes.
- [x] Ordinary active Pi follow-ups remain queued turns. No normal text path invokes steer.

### Slice 4 — Pi-native controls and same-session agents

#### Slice 4A — native control authority

- [x] SessionDO migration 64 owns bounded, idempotent native-control receipts and survives rollback
      and eviction without reissuing indeterminate mutations.
- [x] SessionDO-only dispatch exposes conversation reads, submit/send, explicit steer/follow-up,
      exact submission/task cancellation, fork, reset/handoff, compact, task graph, and redacted
      inspection through Pi Durable 1.3 APIs.
- [x] Read, collaborate, and lifecycle routes have distinct RBAC. Session state, budget, identity,
      request-id, action, conversation, task, retention, input, active-task, depth, and timeout
      bounds fail closed; no public route reaches PiSessionDO.
- [x] One root-conversation event router attributes runs from submission IDs to request IDs. Native
      steering cannot change the active model configuration; Pi usage includes child, tool, and
      compaction work through the existing global accounting ledger.
- [x] Tests cover duplicate/lost responses, eviction, active A plus explicit steer/follow-up,
      configuration isolation, exact cancel, fork/handoff/compact, sanitized inspect/task graph,
      global usage, authorization policy, retention, migration, and non-Pi regressions.

- [x] SessionDO migration 64 stores idempotent control receipts and reservations.
- [x] Extend `PiRuntimeDispatch` through SessionDO-only endpoints for conversations, submit/send,
      steer, follow-up, exact cancel, task graph, sanitized inspect, fork, reset/handoff, and
      compact.
- [x] Install one conversation-wide event router with submission/run/task attribution and
      submission-bound model/reasoning; eliminate positional pending selection and duplicate
      streams.
- [x] Account root/child/tool/compaction usage. Add bounded depth-1 agent tools (four active
      children) with parent capability, fanout, message, loop, and cost constraints.
- [x] Web and Slack expose authorized controls/task graph/basic child navigation; automations use an
      explicit policy; GitHub/Linear remain fallback.

#### Slice 4B — accessible agent controls

- [x] Root-only Pi tools use the active-operation SessionDO bridge for bounded same-session agent
      listing, messaging, last-message reads, follow-up, steering, exact child cancellation, and
      sanitized inspection. Children lose delegation and agent-messaging extensions.
- [x] The web BFF and SWR inspector expose bounded child/task status, usage/cost, selection,
      explicit controls, permission-gated lifecycle actions, confirmations, keyboard focus, live
      regions, responsive controls, and reduced-motion behavior without changing the ordinary
      composer.
- [x] Slack recognizes only `follow up now: ...` and `steer: ...` in existing Pi threads, gates them
      on deployment capabilities and signed actor/session authority, and leaves all other text
      queued.

### Multiplayer compatibility gate before Slice 5

- [x] Audit `d484e480..a1e4bd95` against the existing Open-Inspect session contract; record the
      capability map and future cross-session path in `MULTIPLAYER-COMPATIBILITY-AUDIT.md`.
- [x] Remove Pi assistant text from public/BFF child inspection. Public child state is opaque
      metadata only; `get_last_message` remains root-agent-only through SessionDO.
- [x] Project every authorized human Pi control exactly once as an attributed completed SessionDO
      message and ordinary shared `user_message` event. Receipts remain metadata/idempotency only.
- [x] Prove two connected collaborators receive the same sequenced control event, stale receipt IDs
      cannot re-execute, and existing visibility, participant, read-state, merge, export, callback,
      bot, automation, and non-Pi paths remain unchanged.
- [x] Confirm Computer is one credential-free session VFS, browser capability is absent/default-off,
      and Code Mode/execution/MCP/external actions remain behind SessionDO and existing boundaries.

### Slice 5 — Code Mode production safety

- [x] Replace call identity with authoritative `taskId`/`parentTaskId`; enforce truthful policy.
- [x] Add one session-wide abort-aware semaphore/queue, absolute clamped deadlines, replay
      semantics, active/queued drain, and emergency deny.
- [x] Build immutable JS/WASM once and attest exact hashes through deploy/canary scripts. Contract
      checks require one 100% version, etag, CPU 60000, migration, bindings/routes/secrets/privacy,
      pinned privileged actions, and shared workflow concurrency. Attestation/canary scripts do not
      deploy themselves.

### Slice 6 — secure lazy execution

#### Slice 6A — isolation boundary, no model tools

- [x] Execution receives only session-scoped WS/events/preservation credentials; credential routes,
      secret argv/environment, repo images, snapshots, user env, VCS/model secrets are denied.
- [x] Privileged bridge and unprivileged command boundary; network default deny with explicit
      package profiles.
- [x] Generation 78 clean artifact, immutable manifest/evidence verifier, provider attack contracts,
      and honest canary blocks for Modal/OpenComputer/Daytona/Vercel/E2B. No live calls.

#### Slice 6B — durable execution tools

- [x] Add the next unclaimed SessionDO migration for dispatch/ack/retry/cancel/fence/indeterminate,
      replay-gap/late completion, quotas, and retention.
- [x] Expose authorized `run_shell`, `run_build`, and `run_tests` only after emergency policy.
- [x] Provider contract/canary scripts cover Modal/OpenComputer/Daytona/Vercel/E2B generation 78+
      without making live calls.
- [x] Every real provider stays `canary_blocked` until a live isolation canary passes, so the
      creation snapshot never admits sandbox execution.

#### Slice 6C — upstream Pi Durable parity

- [x] Serverless wake contract: a reopened or hibernated Pi session resumes its pending work; the
      derived wake mirrors upstream's `{ active, at }` shape.
- [x] Telemetry: a content-free span vocabulary that mirrors upstream `DURABLE_TELEMETRY_SCHEMA`,
      published through the `@earendil-works/pi-telemetry@1.3.0` contract.
- [x] One trace id per Pi operation across the SessionDO and PiSessionDO hops.
- [x] Documented the single upgrade point when Pi Durable publishes `onWake`/`wake()` and
      `HarnessOptions.telemetry` — `features/pi-first-class/PI-UPSTREAM-PARITY.md`.

### Slice 7 — external actions and publication

#### Slice 7A — authority and gateway correctness

- [ ] Require `collaborate` session action authority for an approval or denial, not `read`. A
      read-only break-glass reader and a workspace administrator without current owning-team
      membership must both be refused; `external_actions.approve` stays required.
- [ ] Add a cursor-bounded pending-action list route and BFF so an approver does not need an
      out-of-band action id.
- [ ] Coalesce identical nonterminal effects, rearm a one-shot continuation only after a definitive
      `not_admitted`, and add approval expiry and cancellation transitions.
- [ ] Enforce source and grant provenance, bound public errors, and record the occurrence time of
      every prepare, approve, deny, execution, indeterminate, reconciliation, and grant change.
- [ ] Add a live emergency deny for new prepares and executions while status, reconciliation, audit
      recovery, and revocation stay available.

#### Slice 7B — approval and grant surfaces

- [ ] Pending-action list and decision UI inside the existing session page, with exact target and
      argument review, permission-gated controls, and recoverable error states.
- [ ] Automation-grant list, create, and revoke API and UI requiring automation management and
      `external_actions.manage_grants`, revoking atomically on executor change.

#### Slice 7C — provider adapters

- [ ] Reversible credential-closed GitHub, GitLab, Slack, and Linear comment/reply definitions with
      action markers, status lookup, and cleanup.
- [ ] A generic fault-injection conformance suite: pre-write rejection, post-write timeout, restart,
      revoked grant, malformed response, duplicate execution, marker recovery, and a credential
      sentinel scan of the ledger, outbox, public output, and logs.
- [ ] Canary scripts for disposable provider resources. No live calls.

### Slice 8 — read-only MCP/OAuth

- [ ] Add D1 migration 0093 (or next inventory-safe successor) for sealed catalog/read projection,
      owner-only nondelegable review, session pins, identity-first Lifecycle, opaque callback, S256,
      refresh/revoke/remove/tombstone, RESTRICT user merge, and versioned key rotation.
- [ ] Enforce DNS/redirect/public-egress policy and stable read tools before extension assembly.
- [ ] Route Pi -> SessionDO pin/active operation -> broker reauthorization -> bounded call. No
      static headers, mutation, URL elicitation, or automation.
- [ ] UI supports Connect/Authorize/Review/Ready/Mismatch/Revoke and always permits revoke. Add
      controlled canary-server scripts without deployment.

### Slice 9 — authorized cross-session messaging and finish

- [ ] D1 migration 0094 stores idempotent receipts. Main-agent tool routes source Pi -> source
      SessionDO -> D1 RBAC/team/collaborator/audit -> target SessionDO -> target queue/Pi; never
      PiSessionDO-to-PiSessionDO.
- [ ] Stable source task/target IDs, archived/private denial, and fanout/depth/rate/cost limits.
- [ ] Complete accessible UI, telemetry, docs, ten-minute canary, and two self-audit rounds.
- [ ] Final full affected matrix is green and the worktree is clean.

## Validation after every slice

1. Trace the changed reachable flow and compare all authority/non-regression invariants.
2. Run affected shared, control-plane unit/workerd, web, Slack, GitHub, Linear, Python, Terraform,
   fault-injection, SQL portability, typecheck, lint, format, build, and diff checks.
3. Run a simplicity pass for duplicate authority, speculative seams, unsafe defaults, and dead code.
4. Commit one coherent conventional commit without coauthor metadata. Never push or deploy.

## Evidence ledger

| Slice         | Commit      | Reachable-flow evidence                                                                                                                                                                                                     | Test/canary evidence                                                                                                                                                                              | Remaining live-only gate                                             |
| ------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 0             | `d484e480`  | Existing sandbox dispatch is unchanged; Pi queue still never asks for a socket or spawn; Slack still verifies signature/schema and keeps its current ACK path                                                               | control-plane 5,111/1 skipped; Slack 638; focused 154; control-plane typecheck/lint/build; Slack lint/build; Prettier/diff check                                                                  | none                                                                 |
| 1             | pending     | Server capability authority now drives web/Slack; Pi opens bootstrap context only; repository pin, provider reads, and Computer are first-tool lazy                                                                         | shared 1,303; control-plane 5,115/1 skipped; focused workerd 51; Slack 638; web 2,532/2,533 plus isolated timeout pass; affected typecheck/lint                                                   | capability reachability in deployed account                          |
| 2             | pending     | pending                                                                                                                                                                                                                     | pending                                                                                                                                                                                           | personal provider credential/browser canary                          |
| 3A            | `d888b169`  | D1 0092 and Slack-only internal routes own bounded ingress admission, leases, stable IDs, staged CAS, reconciliation, and retention; Slack ACK is unchanged                                                                 | shared 1,303; control-plane 5,115/1 skipped; focused unit 163; workerd store/user merge 17; SQL portability green                                                                                 | none; Queue wiring belongs to 3B                                     |
| 3B            | `0f554777`  | Feature-gated D1 admit and Queue persistence precede ACK; fast path and Queue share one claim; old KV path is unchanged while off                                                                                           | Slack 645; focused workerd 3; control-plane policy 151; Terraform 95 total including 2 ingress plans; build/type/lint/format/SQL green                                                            | real Slack retry/latency canary                                      |
| 3C            | this commit | Stable receipt IDs now own idempotent D1/SessionDO creation, first-message admission, staged mapping, KV repair, and queued Pi follow-ups                                                                                   | shared 1,305; control-plane 5,115/1 skipped; workerd ingress/session/user-merge 18; Slack 647; web 8; docs 44/build 185; Terraform 95; build/type/lint/format/SQL green                           | real Slack SLO/redelivery canary                                     |
| 4A            | this commit | SessionDO migration 64 and RBAC-separated routes own idempotent native controls; Pi Durable owns conversations, submissions, tasks, reset/fork/compaction and one event router                                              | shared 1,305; control-plane 5,126/1 skipped; workerd 2,470/1 skipped; Slack 647; focused authority, callback, attribution, eviction, redaction, cost, and bounds coverage                         | real model native-control canary                                     |
| 4B            | this commit | Root-only tools and signed web/Slack actors traverse SessionDO receipts into same-session Pi conversations; child/fork capability subsets prevent recursive messaging and ordinary prompts remain queued                    | shared 1,305; control-plane 5,129/1 skipped; workerd 2,470/1 skipped plus current Pi 54; web 2,539; Slack 655; docs 44/build 185; type/lint/build/format/SQL green                                | authenticated browser and real-model multi-agent/Slack canaries      |
| compatibility | this commit | SessionDO again owns the only public participant/message/timeline contract; human controls project once with canonical actor identity; Pi inspection is metadata-only and all future capability paths stay behind SessionDO | shared 1,306; control-plane 5,135/1 skipped; workerd 2,471/1 skipped; web 2,540; Slack 655; GitHub 335; Linear 317; docs 44/build 185; type/lint/build/format green                               | authenticated browser remains unavailable locally; no Slice 5 canary |
| 5             | this commit | Task-bound Code Mode policy, one session FIFO, durable absolute deadline/admission, native replay, drain, and redacted nested activity remain subordinate to the canonical SessionDO operation/timeline                     | shared 1,306; control-plane 5,140/1 skipped; workerd 2,471/1 skipped; two-Worker 10; web 2,540; bots 1,307; Python 562; sandbox 7; Terraform 101; workflows 33; full build/type/lint/format green | paid exact-artifact Cloudflare/runtime attestation                   |
| 6             | pending     | pending                                                                                                                                                                                                                     | pending                                                                                                                                                                                           | provider execution canaries                                          |
| 7             | pending     | pending                                                                                                                                                                                                                     | pending                                                                                                                                                                                           | provider comment/reply canaries                                      |
| 8             | pending     | pending                                                                                                                                                                                                                     | pending                                                                                                                                                                                           | approved MCP OAuth server canary                                     |
| 9             | pending     | pending                                                                                                                                                                                                                     | pending                                                                                                                                                                                           | 10-minute deployed soak                                              |

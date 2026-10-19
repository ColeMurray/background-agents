# First-class Pi go-live integration plan

Branch: `feat/pi-go-live-integration-v2`

Base: `814ed3e610a8f4371b40554e7ffd8fd7f716be2c` (`feat/pi-first-class`)

Started: 2026-10-19

This is the execution ledger for the final Pi go-live integration. A box is checked only beside
local evidence. Live credentials, provider calls, pushes, and deployments are excluded.

## Authority and non-regression invariants

1. Pi Durable exclusively owns transcripts, inbox ordering, tasks, conversations, and compaction.
2. SessionDO exclusively owns authentication/RBAC, the Open-Inspect message queue, budgets,
   callbacks, approvals, audit, and external-effect ledgers.
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
  [extensions](https://developers.cloudflare.com/agents/harnesses/pi/extensions), and
  [MCP OAuth](https://developers.cloudflare.com/agents/guides/oauth-mcp-client).
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

Repository reads enter `open-inspect` tools, call the SessionDO capability bridge for fresh scope,
and read immutable provider blobs. Writable repository overlays and Computer VFS are capability
gated and default off. Code Mode is a private auxiliary Worker and default off.

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

- [ ] D1 migration 0092 adds bounded ingress receipts; Queue and DLQ bindings default safely.
- [ ] Verify signature/schema, commit the exact bounded event receipt and queue admission before
      ACK, then race `waitUntil` fast path and Queue through one D1 idempotent claim.
- [ ] Slack KV mapping/dedupe is a cache projection recoverable from D1.
- [ ] Stable Slack event ID determines session-create and first-prompt request IDs; session ID is
      durable before initialization/prompt and every retry reuses IDs.
- [ ] Activity follows claim immediately; crash-boundary, 429, ambiguous network, and redelivery
      tests prove exactly one session, prompt, and reply. Follow-ups use the same SessionDO/Pi
      conversation.

### Slice 4 — Pi-native controls and same-session agents

- [ ] SessionDO migration 64 stores idempotent control receipts and reservations.
- [ ] Extend `PiRuntimeDispatch` through SessionDO-only endpoints for conversations, submit/send,
      steer, follow-up, exact cancel, task graph, sanitized inspect, fork, reset/handoff, and
      compact.
- [ ] Install one conversation-wide event router with submission/run/task attribution and
      submission-bound model/reasoning; eliminate positional pending selection and duplicate
      streams.
- [ ] Account root/child/tool/compaction usage. Add bounded depth-1 agent tools (four active
      children) with parent capability, fanout, message, loop, and cost constraints.
- [ ] Web and Slack expose authorized controls/task graph/basic child navigation; automations use an
      explicit policy; GitHub/Linear remain fallback.

### Slice 5 — Code Mode production safety

- [ ] Replace call identity with authoritative `taskId`/`parentTaskId`; enforce truthful policy.
- [ ] Add one session-wide abort-aware semaphore/queue, absolute clamped deadlines, replay
      semantics, active/queued drain, and emergency deny.
- [ ] Build immutable JS/WASM once and attest exact hashes through deploy/canary scripts. Contract
      checks require one 100% version, etag, CPU 60000, migration, bindings/routes/secrets/privacy,
      pinned privileged actions, and shared workflow concurrency. Scripts do not deploy themselves.

### Slice 6 — secure lazy execution

- [ ] Execution receives only session-scoped WS/events/preservation credentials; credential routes,
      secret argv/environment, repo images, snapshots, user env, VCS/model secrets are denied.
- [ ] Privileged bridge and unprivileged command boundary; network default deny with explicit
      package profiles.
- [ ] Add the next unclaimed SessionDO migration for dispatch/ack/retry/cancel/fence/indeterminate,
      replay-gap/late completion, quotas, and retention.
- [ ] Expose authorized `run_shell`, `run_build`, and `run_tests` only after emergency policy.
- [ ] Provider contract/canary scripts cover Modal/OpenComputer/Daytona/Vercel/E2B generation 78+
      without making live calls.

### Slice 7 — external actions and publication

- [ ] Correct collaborate/action authority and approval; emergency deny prepare/execute while
      status/reconcile/revoke remain available.
- [ ] Coalesce gateway calls, rearm only after definitive `not_admitted`, and retain expiry,
      cancellation, provenance, bounded errors, and full occurrence audit.
- [ ] Add pending UI/BFF and automation-grant management.
- [ ] Add reversible credential-closed GitHub/GitLab/Slack/Linear comment/reply definitions with
      markers, status, delete, generic fault suites, and no Pi credentials. Canary scripts only.

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

| Slice | Commit     | Reachable-flow evidence                                                                                                                                       | Test/canary evidence                                                                                                                            | Remaining live-only gate                    |
| ----- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 0     | `d484e480` | Existing sandbox dispatch is unchanged; Pi queue still never asks for a socket or spawn; Slack still verifies signature/schema and keeps its current ACK path | control-plane 5,111/1 skipped; Slack 638; focused 154; control-plane typecheck/lint/build; Slack lint/build; Prettier/diff check                | none                                        |
| 1     | pending    | Server capability authority now drives web/Slack; Pi opens bootstrap context only; repository pin, provider reads, and Computer are first-tool lazy           | shared 1,303; control-plane 5,115/1 skipped; focused workerd 51; Slack 638; web 2,532/2,533 plus isolated timeout pass; affected typecheck/lint | capability reachability in deployed account |
| 2     | pending    | pending                                                                                                                                                       | pending                                                                                                                                         | personal provider credential/browser canary |
| 3     | pending    | pending                                                                                                                                                       | pending                                                                                                                                         | real Slack retry/latency canary             |
| 4     | pending    | pending                                                                                                                                                       | pending                                                                                                                                         | real model multi-agent canary               |
| 5     | pending    | pending                                                                                                                                                       | pending                                                                                                                                         | paid Cloudflare deployment/version canary   |
| 6     | pending    | pending                                                                                                                                                       | pending                                                                                                                                         | provider execution canaries                 |
| 7     | pending    | pending                                                                                                                                                       | pending                                                                                                                                         | provider comment/reply canaries             |
| 8     | pending    | pending                                                                                                                                                       | pending                                                                                                                                         | approved MCP OAuth server canary            |
| 9     | pending    | pending                                                                                                                                                       | pending                                                                                                                                         | 10-minute deployed soak                     |

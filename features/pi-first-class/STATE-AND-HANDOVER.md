# First-class Pi: current state and handover

This file is the handover record for the first-class Pi work. It states what is done, what each
change is, how it was verified, what is deliberately not done, and exactly what remains. Read it
before changing anything; do not re-derive the design from the code alone.

## The one rule

Every Pi-specific capability is an **Open-Inspect capability**, never a Pi-side capability that
bypasses Open-Inspect.

```text
Pi task
  → owning SessionDO authorizes it
    (current actor, session, team, workspace, resource authority)
  → D1 resolves current authority
  → capability-specific durable gateway executes it
  → result returns through SessionDO audit / timeline / budget
  → Pi receives only a bounded, credential-free result
```

Pi never receives a raw privileged client, never holds a long-lived credential, and never decides
its own authorization.

### Authority owners (these do not move)

| Authority                                                                                                          | Owner                        |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| Pi transcript, inbox, tasks, conversations, compaction                                                             | `PiSessionDO` / Pi Durable   |
| Authorization, RBAC, multiplayer session, timeline, ordering, budgets, callbacks, audit, approvals, effect ledgers | `SessionDO`                  |
| Long-lived credentials, grants, MCP OAuth, session index                                                           | D1                           |
| Harness selection, model and auth admissibility                                                                    | existing Open-Inspect routes |

### Non-regression invariants

1. OpenCode, Claude Agent, and Codex keep creating and warming their sandbox exactly as before.
2. Typing still warms a non-Pi session. A Pi session never warms a sandbox for ordinary work.
3. Pi collaborators keep the same participants, presence, typing, read state, shared timeline,
   message order, visibility, budget, stop, archive, delete, and export.
4. Pi child conversations are subordinate activity inside one Open-Inspect session. They never
   become separate multiplayer rooms.
5. A human message is always created through the existing SessionDO queue. Pi never writes a human
   message directly, and never spoofs an author.
6. GitHub and Linear keep mapping a configured Pi harness to OpenCode until publication contracts
   pass their canaries.
7. Every new D1 or Durable Object migration is additive and forward-only. Rollback disables
   admission first and never deletes a binding or stored data.
8. Every new capability defaults to off and fails closed.
9. A capability never reaches a provider with a credential that came from a model, a tool argument,
   Pi storage, a VFS file, or a log line.
10. Only one implementation owner edits the shared composition files. Capability work happens in an
    isolated worktree and is integrated by the owner.

## What is integrated today

### Main feature branch `feat/pi-first-class`

| Commit     | What it does                                                                                           | Evidence                                         |
| ---------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `aa157652` | Portable external-action grant revocation with old-binary rollback compatibility                       | SQL portability clean, 9 focused, 77 integration |
| `b930292b` | Creation-time capability authority and dynamic emergency deny                                          | 5,047 unit, 2,470 workerd                        |
| `a1d738b2` | Canonical Pi session diffs in the web UI                                                               | 2,533 web                                        |
| `3b8bc49b` | Prompt admission reconciliation, durable projection, cost and budget, stop races, callback idempotency | 5,047 unit, 2,452 workerd                        |
| `814ed3e6` | Lazy Computer and repository overlays, bounded quotas, durable diff outbox, generation fence           | 122 unit, 59 workerd, 11 Terraform               |

### Go-live integration branch `feat/pi-go-live-integration-v2`

| Commit     | What it does                                                                                       | Evidence                                                        |
| ---------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `d484e480` | Latency milestones and characterization of existing flows                                          | —                                                               |
| `bf565b16` | Server-authoritative capabilities, lazy first token, lazy repository pinning and Computer          | 5,115 unit, 2,459 workerd                                       |
| `d1cf7645` | Personal web Pi diagnostics and credential sentinel scan                                           | 54 web                                                          |
| `d888b169` | Durable Slack ingress receipts in D1                                                               | 163 focused                                                     |
| `0f554777` | Slack Queue/DLQ, durable enqueue before ACK, fast-path claim                                       | 12 focused                                                      |
| `d93170c5` | Exactly-once Slack session, thread mapping, prompt, and callback repair                            | 647 Slack                                                       |
| `d5fb92f7` | Pi-native control authority in SessionDO                                                           | 5,126 unit, 2,470 workerd                                       |
| `efca49ae` | Slack ingress flag wired into both Terraform jobs                                                  | 33 workflow contracts                                           |
| `a1e4bd95` | Accessible Pi agent controls and bounded same-session agent tools                                  | 2,540 web                                                       |
| `a4a7aaa9` | SessionDO stays the canonical multiplayer authority                                                | 335 GitHub, 317 Linear                                          |
| `72fc8d8e` | Production Code Mode safety, exact artifact, observed attestation                                  | 10 two-Worker, 101 Terraform                                    |
| `722e41fe` | Generation-78 execution isolation boundary                                                         | 565 Modal, 78 image, 1,668 runtime                              |
| `77fc7be2` | Authorized Pi execution tools, provider canary blocked by default                                  | 5,185 unit                                                      |
| `514db750` | Pi hibernation telemetry, external-action authority, pending-action list                           | 5,226 unit, 2,472 workerd, 2,554 web                            |
| `75be1a63` | External-action lifecycle hardening, grant administration, provider adapters and conformance suite | 5,289 unit, 2,472 workerd, 2,576 web, 49 provider conformance   |
| `1c9ec044` | `crossSessionMessaging` capability gate with a version 2 snapshot                                  | 1,308 shared, 5,303 unit                                        |
| `37ef29e8` | Authorized cross-session messaging with durable receipts and provenance                            | 5,305 unit, 2,578 web, 98 Terraform                             |
| `0a8ed61b` | Read-only MCP gateway, session grants, reviewed catalog, and the cross-session authority fixes     | 5,338 unit, 2,473 workerd, 1,309 shared                         |
| `d62cccc1` | Browser gateway, MCP OAuth keyring, DNS and redirect-safe egress, RESTRICT user merge              | 5,348 unit, 104 Terraform                                       |
| `f641896b` | The browser tool gated on the owning session                                                       | 5,352 unit                                                      |
| `83ce188a` | The web suite waits for its requests instead of assuming them                                      | 2,578 web                                                       |
| `80adb08b` | The external-action credential source: a per-call credential from the deployment credential        | 5,354 unit, 2,473 workerd, 1,309 shared                         |
| `389dcb8e` | The handover record for the closed credential source                                               | —                                                               |
| `e5eebd5f` | A portable MCP session grant migration, with the invariant in the store                            | 14 SQL portability, 9 focused                                   |
| `b2b79341` | The fourth audit round's repairs: the owning delegate, the publication tool, the credential guard  | 5,370 unit, 2,578 web, 1,314 shared, 108 Terraform, 13 workflow |
| `b2891bf5` | The MCP gateway refuses a credential-shaped answer before it leaves the session                    | 5,371 unit                                                      |
| `47775993` | The credential availability check stays cheap and off the provider path                            | 5,377 unit                                                      |
| `ec8a6aba` | The verified upstream wake and telemetry contract, and who owns the physical alarm                 | —                                                               |
| `ae507189` | A blocked Pi task says why it cannot run                                                           | 5,388 unit                                                      |
| `8c53d6b8` | The browser transport: a bounded, untrusted, session-authorized page read                          | 5,405 unit, 113 Terraform                                       |
| `d368bd3f` | The browser binding in Terraform, and a read-only browser mode that means something                | 5,405 unit, 113 Terraform, 13 workflow                          |
| `e0553b99` | The browser binding read from the worker's own bindings                                            | 5,405 unit                                                      |
| `c47b8baf` | One browser activity per page, not two                                                             | 5,406 unit, 2,474 workerd, 2,578 web, 1,314 shared              |
| `b1f53734` | The restart, the budget, and the attribution findings of the sixth audit                           | 5,407 unit                                                      |
| `3ddf7332` | Code Mode runs behind the owning session's authority                                               | 5,409 unit                                                      |
| `1d05cfe5` | The MCP transport: the manager, the registration, the call, and the OAuth callback route           | 5,409 unit                                                      |
| `HEAD~1`   | The MCP grant becomes a session action, with the core's repository scope rule                      | 5,409 unit, 2,475 workerd                                       |

## Slice 7A — what landed

The external-action authority now holds to the rule that reading a session is not action authority.

- The decision route requires `collaborate` session authority plus `external_actions.approve`. A
  private break-glass reader and a workspace administrator without current owning-team membership
  are both refused. The route-admission sentinel now expects the stronger session-layer denial.
- `GET /sessions/:id/external-actions` lists pending effects with an opaque cursor, oldest first,
  scoped to one session. An approver never needs an out-of-band action id.
- One effect is one ledger entry. An identical effect that is still pending, running, or
  indeterminate joins the existing entry instead of raising a second approval card or a second
  provider write. The search is scoped to one session, so two sessions never share an effect.
- A definitive `not_admitted` re-arms the one-shot continuation, because the approval that
  authorized the effect is still valid.
- Approval provenance is unambiguous: a human approval carries no grant, and an automation approval
  names the grant that authorized it.
- Pending approvals expire after a bounded window and are cancelled by the alarm. Cancellation is a
  separate decision from denial, and it cannot cancel an effect the provider may already have
  applied.
- The audit event records the decision time, not the flush time. A system expiry is attributed to a
  service principal, never to a user.
- A live deployment deny blocks a new prepare and a new approval. Status, audit recovery,
  reconciliation, denial, and cancellation stay available, and an already-prepared effect keeps its
  memo, so an emergency never strands admitted work.

### Files that matter for 7A

| File                                                                    | Role                                                        |
| ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| `packages/control-plane/src/routes/session-external-actions.ts`         | Public routes: pending list, status, decision               |
| `packages/control-plane/src/session/external-action-gateway.ts`         | The approval and exactly-once dispatch state machine        |
| `packages/control-plane/src/session/http/handlers/pi-bridge.handler.ts` | SessionDO internal routes and the live gate                 |
| `packages/control-plane/src/session/components.ts`                      | SessionDO wiring: live mode, expiry alarm, audit flush      |
| `packages/control-plane/src/session/schema.ts`                          | SessionDO migration 66                                      |
| `packages/shared/src/types/external-actions.ts`                         | Shared contracts, including approval provenance             |
| `packages/web/src/hooks/use-session-external-actions.ts`                | Browser hook; the browser never decides what it may approve |

### Migrations added

| Store      | Version | Feature         | Purpose                                              |
| ---------- | ------- | --------------- | ---------------------------------------------------- |
| session_do | 66      | externalActions | approval expiry, cancellation, audit occurrence time |

## Capability status

| Capability                   | State                                | Why                                                                                         |
| ---------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------- |
| Durable Pi chat and recovery | Ready                                | Pi Durable is the transcript and task authority                                             |
| Credential brokerage         | Ready                                | Memory-only short-lived access token; no API-key fallback                                   |
| Repository analysis          | Ready                                | Commit-pinned, credential-free, provider-backed reads                                       |
| Cloudflare Computer VFS      | Ready behind preview acknowledgement | Lazy, least-authority facade, bounded quota; named apart from the workspace and the sandbox |
| Repository editing and diffs | Ready behind preview acknowledgement | Lazy overlay, durable diff outbox, generation fence                                         |
| Code Mode                    | Ready behind paid canary             | Task-scoped policy, bounded FIFO, durable parent record, observed attestation               |
| Native execution             | **Unavailable by construction**      | Every provider is `canary_blocked` until a live isolation canary passes                     |
| External publication         | Ready behind its own gate            | Four credential-closed providers, a per-call credential source, the generic suite, a tool   |
| MCP read                     | Ready behind its own gate            | Grants, reviewed catalog, gateway, broker authority, the transport, the OAuth callback      |
| Cross-session messaging      | Ready behind its own gate            | Source SessionDO to D1 to target SessionDO, with durable receipts and confirmed provenance  |
| Browser                      | Ready behind its own gate            | Session gateway, host allowlist, activity on the timeline, and a bounded transport          |

## The two MCP lanes, and the decision

Open-Inspect's MCP is centralized, and that is the design, not a gap: the deployment owns the MCP
servers, one shared credential serves them, the session's repositories scope them, and every trusted
member of the tenant uses them. There is no per-user external-service credential anywhere in
Open-Inspect, because Open-Inspect is single-tenant by design.

Pi does not change that. Pi has two lanes, and neither invents an authority model.

### Lane 1 — the shared lane (Open-Inspect's core, untouched)

The deployment's own MCP servers, with the deployment's own credential, scoped by the session's
repositories. This is exactly what the sandbox gets:
`McpServerStore.getDecryptedForSession(repositories)`
(`packages/control-plane/src/db/mcp-servers.ts:347`) is the single resolver, and the sandbox's
launch context calls it with the session's repositories
(`packages/control-plane/src/sandbox/lifecycle/launch-context.ts:216`). No actor, no per-user
identity, and none is needed: every member of the tenant is trusted with the deployment's servers.

**Decision: Pi uses this lane too.** Pi is a harness alongside OpenCode, Claude, and Codex, so it
must reach the same servers the sandbox reaches, under the same credential, under the same scope.

### Lane 2 — the personal lane (new, and only because MCP needs OAuth)

A credential that belongs to one person. It exists because an OAuth-protected MCP server cannot be
reached with a shared static credential, and because a personal token is a _person's_ secret, not
the tenant's. The personal lane is strictly **narrower** than the shared lane: the owner's explicit
grant, the session's own `collaborate` authority, and the server's repository scope must all hold.

**The rule: a personal credential never widens the deployment's scope.** The scope that decides "may
this session use this MCP server" is unchanged and shared by both lanes: the session's repositories
against the server's `repo_scope`.

### The seam the shared lane's call must use

The shared lane's credential is a static header or env blob on the server row. It is _not_ an OAuth
token, so the shared lane needs none of the personal lane's machinery: no `mcp_connections` row, no
`mcp_oauth_storage`, no owner, no callback route, no per-user keyring.

The call belongs to the session, and the session already holds the resolver:

- The SessionDO already wires the core's resolver
  (`packages/control-plane/src/session/components.ts:1646`:
  `getDecryptedForSession: (repositories) => mcpStore.getDecryptedForSession(repositories)`).
- The call uses the MCP SDK's own client, which is already a dependency
  (`@modelcontextprotocol/client`): a `Client` over a `StreamableHTTPClientTransport` pointed at the
  server's `url`, with the shared `headers`/`env` closed over. No `Lifecycle`, no persistence, and
  no callback — none of them are needed for a static credential.
- The reviewed-catalog gate is the same one the personal lane uses: the tool must be in the server's
  reviewed read-only catalog for the server's current revision (`mcp_reviewed_tools`,
  `effect = 'external_read'`). A mutation is unrepresentable.
- The result is bounded and credential-free exactly as the personal lane's result is, and the read
  is audited and lands on the session's timeline like every other capability activity.

### What the shared lane must never do

- It must not let the credential reach Pi, a tool result, an error, a log line, or the timeline.
- It must not use a per-user credential for a shared server.
- It must not widen `repo_scope`: the session's repositories decide, as they do for the sandbox.
- It must not create a personal connection for a shared server, and it must not let a personal grant
  widen what the shared lane exposes.

### What the shared lane does now

- The session resolves the shared servers with the core's own resolver and the session's own
  repositories, so the scope is exactly the sandbox's.
- Only the server's reviewed read-only tools are listed, and only those are callable. A mutation is
  unrepresentable.
- The call belongs to the session: the MCP SDK's client over the deployment's own headers, closed
  over for one call, with the provider's error never leaving the session.
- The result is bounded and refused when it carries a credential-shaped key, exactly as the personal
  lane's result is.
- The Pi read tool names either a personal connection or a shared server, and the session's MCP
  roster lists both, so the model is offered only what it may read.

**What is left for the shared lane:** the live canary against a real MCP server, with a repo-scoped
server and a session without that repo, to prove the scope rule holds.

## Upstream Pi Durable parity

Upstream `main` is ahead of the published release. See `PI-UPSTREAM-PARITY.md`.

- Published `1.3.0` has `resume()`, `whenBusy`, `harness.submission(id)`, `harness.waitForTask(id)`,
  and the `tool-search` export. It has no `onWake`, no `wake()`, and no harness telemetry.
- `@earendil-works/pi-telemetry@1.3.0` is published, so the telemetry contract is usable now.
- Open-Inspect implements the upstream wake shape itself
  (`packages/control-plane/src/pi/pi-harness-wake.ts`) and a content-free telemetry span vocabulary
  (`packages/control-plane/src/pi/pi-telemetry.ts`). When Pi Durable ships the native options, those
  two files are the only ones that change.

## Remaining work, in order

### Slice 7A — external action authority and gateway correctness — DONE

Everything landed, including the bounded public errors: a public failure is now a stable code and a
generic message, so an internal provider string never reaches the browser. The conformance suite
asserts that no credential and no provider response reaches a result, an error, or the agent.

### Slice 7B — approval and grant surfaces — DONE

- The session sidebar shows the pending external effects with named approve, deny, and cancel
  controls. The controls appear only for a user who holds `external_actions.approve`; the server
  decides the rest.
- The automation detail page manages unattended publication grants. A grant names one provider, one
  action, and one automation, and always runs as that automation's own executor.
- Grant administration requires the automation's own manage authority _and_
  `external_actions.manage_grants`. A user who may edit the automation but holds no external-action
  permission cannot widen what it publishes.
- Revocation is scoped to the automation that owns the grant, so a caller can never revoke a grant
  that belongs to another automation.
- The browser never decides what it may approve or grant. It renders what the control plane returns
  and reports what the server refuses.

### Slice 7C — provider adapters

- Four credential-closed provider definitions: GitHub comment, GitLab comment, Slack thread reply,
  and Linear comment. A definition names a request, an endpoint, and how the provider's answer is
  read. It never names a credential; the executor closes over one.
- Every publication carries a marker derived from the action id. A response that is lost is
  reconciled by finding that marker, so a lost response never becomes a second publication.
- A generic fault-injection conformance suite runs against every provider definition. It proves that
  a refusal stays a refusal, an unknown stays unknown, a hung provider becomes an indeterminate
  failure instead of a request that never ends, a malformed answer never leaks, and no credential
  ever reaches a result, an error, or the agent.
- `scripts/canary-pi-external-actions.sh` runs the suite and prints the deployment configuration a
  live canary would need. It never calls a provider.
- A provider is registered only when the deployment supplies its credential source, so the agent
  never sees a publication it could not complete.

**The credential source is closed.** Each provider now closes over a credential the deployment
already holds, minted per call: a scoped source-control installation token for GitHub and GitLab,
the bot token for Slack, and the API key for Linear. The provider list comes from one deployment
variable, and a provider without a credential is not registered, so the agent never sees a
publication it could not complete. A publication that reaches the preparation path without a
credential is refused before an approval card is raised.

**Still open in 7C:** the live provider canaries. No provider may be switched on until a canary has
published one effect and reconciled it by its marker. The feature stays off by default until then.

### Slice 9 — authorized cross-session messaging

The path is the one the design requires, with no direct Pi-to-Pi hop:

```text
Pi session A → SessionDO A → D1 authority → durable receipt → SessionDO B → target queue
```

- The source session owns the decision. It checks its own latched capability, the live deployment
  mode, that the originating turn has a human actor, and that the actor may collaborate in the
  target. It never calls another Pi session directly.
- The target authority is read from D1 at the moment of the call, never from a cache, so a suspended
  user, a removed collaborator, or a lost team membership takes effect immediately. The rules are
  the canonical session rules: the actor needs the same `collaborate` authority on the target that
  they would need to post in it. An administrator who may break-glass _read_ a private session may
  not send into it.
- The target revalidates the same authority for itself before it enqueues anything. A receipt the
  target cannot confirm is refused rather than shown.
- A durable receipt is written before the target is called. One request key produces one receipt, so
  a retry delivers the same message once, and a reused key with different content is refused.
- One turn may reach only a bounded number of other sessions, and a message may only travel so many
  hops. Both limits are counted from durable state, not from memory.
- The target message is an agent message with typed provenance: the human who initiated it, the
  session it came from, and the agent conversation and task. It is never presented as something the
  human typed in the target session. The timeline says "Agent message · from session <id> ·
  initiated by <user>".
- The message is authored by a machine identity, `cross-session:<source session id>`, so the
  initiator never becomes a participant of the target session. A participant row is display, not
  access; the access rules read the collaborators, the owner, and the team.
- The capability is a first-class feature gate, `crossSessionMessaging`, with a version 2 snapshot.
  A version 1 snapshot is read with the new feature closed, so an older session keeps working and
  the capability stays off.

**Still open in Slice 9:** the browser journey for it.

### Slice 8 — read-only MCP and OAuth

The authority boundary now exists; the live transport does not.

- **Session attachments.** A personal MCP connection is not available to a session until its owner
  grants it. The grant names one session, records the catalog snapshot it was made against, and
  exposes only the reviewed read-only tools. Revoking a grant stays available even when the
  capability is switched off.
- **The review.** A server's catalog is reviewed by an account that holds `mcp_servers.manage`. A
  tool classified as a mutation is recorded so the decision is auditable, and it can never reach a
  connection snapshot: the snapshot table only accepts reads.
- **The gateway.** The session revalidates the grant, the reviewed catalog, and the tool's
  classification before anything reaches the provider, and it returns a bounded, credential-free
  result. A refused call is audited with the reason, and a provider result that is too large is cut
  and says so.
- **The broker.** The last authority before the provider rechecks the owner, the connection's
  status, and the reviewed catalog from D1.
- **The tool.** `mcp_read` is a single stable read tool, declared in the shared effect registry
  before any extension is assembled.

**Still open in Slice 8:** the live transport. The broker's authorization is complete and tested,
but the transport itself is not installed, so a reviewed read reaches the transport gate rather than
a provider. The OAuth dance (the opaque callback, S256, refresh, revoke, tombstone), the rotatable
keyring, the `RESTRICT` user merge, and the DNS and redirect-safe egress still have to be built on
top of it.

### The scratch workspace is not the workspace

The Pi scratch VFS, the Open-Inspect workspace, and the native execution sandbox's `/workspace` are
three unrelated filesystems, and they are now named distinctly everywhere:

| Concept                               | Name                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| The session's own Computer filesystem | `scratchWorkspace`, `PI_SCRATCH_WORKSPACE_MODE`, `open-inspect.scratch-workspace`, "Scratch files" |
| The tenant                            | "workspace" in the team switcher, the permissions, and the visibility                              |
| The execution sandbox's filesystem    | the native execution sandbox's own `/workspace`                                                    |

The capability snapshot moved to version 3. A version 2 snapshot is read with the same mode under
the new name, so a rename never changes what a session may do. The old `PI_WORKSPACE_MODE`
environment variable still works until it is removed.

### The adversarial audit rounds

Six rounds are written up in `AUDIT-ROUND-1.md`, `AUDIT-ROUND-2.md`, `AUDIT-ROUND-3.md`,
`AUDIT-ROUND-4.md`, `AUDIT-ROUND-5.md`, and `AUDIT-ROUND-6.md`. Round 3 is the deep audit of the
cross-session and capability slices, and it found a defect that made the whole feature unusable: the
target session compared the target against _its own_ id, so every delivery was refused. It is fixed,
along with the source-side authority, the receipt confirmation, the idempotency state machine, the
actor identity, and the depth and fan-out limits.

Round 4 audits the whole Pi surface — every tool, every route the agent calls on the owning session,
every credential path, and every cross-session reach. Its blocking finding was that the
external-action policy delegate claimed every external mutation, so the cross-session tool could
never be reached: the whole capability was dead. It is fixed, and the assembler now refuses to
install a runtime in which an external mutation has no owning delegate. Nine more findings are fixed
with it: the browser gate asked a question with no answer, the MCP capability had no deployment
switch, an MCP answer could carry a credential into the shared timeline, a provider error string
reached the model, the MCP grant list had a broken contract and named the owner, a read-only MCP
capability installed a tool that always failed, the execution endpoint trusted its body and had no
gate, the publication capability had no model-facing surface, and the browser effect registration
was an unconsumed trap. One finding, the live deny not covering the scratch reads, was reviewed and
deliberately left as it is, and the reasoning is written down in the round.

### Slice 9 — browser gateway

The boundary exists; the transport does not.

- A `browser` capability, off by default, latched per session and checked against the live
  deployment mode on every request.
- The session's own gateway decides every browser request: the capability, the live mode, that the
  turn belongs to this session, that it has a workspace actor, and that the page is on the host list
  an operator reviewed. A wildcard never matches the bare domain, and an empty list allows nothing.
- Every decision is recorded on the session's timeline, so a browser the agent drove is visible to
  the collaborators of the session, with the actor.
- The agent never receives a browser client and never receives a Live View URL. A Live View URL is a
  bearer credential for a human, so it belongs on a human-facing route, not in a model context.

**Still open in Slice 9:** the transport. Cloudflare's Agents `Browser` needs a `BROWSER` binding
and a `LOADER` worker-loader binding in the Worker that hosts the Pi Durable Object, plus the
`guardrails` allowlist and the session scope. The browser tool runs model-written code in a Worker
Loader sandbox, so that Worker must export the `CodemodeRuntime` class, exactly as the separate Code
Mode sandbox Worker does. The Worker's bindings, the Terraform that stages them, and a human-facing
Live View route are the remaining work, followed by a live canary. The MCP elicitation receipt and
its UI belong to the MCP transport and stay open with it.

## What is still open, in order

1. **The MCP OAuth lifecycle, from the owner's side.** The transport is installed: the broker
   registers the server, connects it with the encrypted OAuth provider, calls a reviewed read
   through the client's own transport, and serves the server's OAuth callback on a route that only
   the connection's owner may reach. What remains is the owner's half: surfacing the authorization
   URL to the browser, the refresh, the revoke, and the tombstone.
2. **The browser canary.** The transport exists: the session gateway authorizes every request, the
   page is loaded in a fresh browser with no cookie jar, the content is marked untrusted, and the
   result is bounded. What remains is a live canary on a deployment with Browser Rendering, the
   approval path for logging in, uploading, and downloading, and the accessibility review of the
   browser surface.
3. **The finish.** Accessibility review, the browser journeys, the ten-minute canary on the user's
   own instance, and the provider canaries. The four adversarial audit rounds over the new code are
   written up in `AUDIT-ROUND-1.md`, `AUDIT-ROUND-2.md`, `AUDIT-ROUND-3.md`, and `AUDIT-ROUND-4.md`.

## The gaps the deep audit found

Every item below was found by reading the code against the boundary rules, and every item is either
fixed or listed as still open above.

| Gap                                                                                                           | Severity | Status                                                             |
| ------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------ |
| The target session refused every cross-session delivery because it compared the target against its own id     | blocking | fixed                                                              |
| A cross-session receipt was never confirmed by the target, so the provenance could be asserted by the sender  | blocking | fixed                                                              |
| The source session never checked its own status, its own authority, or that the turn belonged to it           | high     | fixed                                                              |
| The actor could be a namespaced identity, which violated the receipt's foreign key and broke every second hop | high     | fixed                                                              |
| A rejected receipt could never be delivered again, and a retry could duplicate the message                    | high     | fixed                                                              |
| A receipt was written before the authority check, so a denied attempt still wrote a row                       | medium   | fixed                                                              |
| The fan-out count rejected a legitimate retry of the same request                                             | medium   | fixed                                                              |
| The initiator of a cross-session message became a participant of the target session                           | medium   | fixed                                                              |
| "Workspace" named the tenant, the scratch VFS, and the execution sandbox at once                              | high     | fixed, with a version 3 snapshot that reads an older one unchanged |
| A scratch write kept no attribution                                                                           | medium   | fixed                                                              |
| Code Mode's nested-call restriction lived only in memory and failed open after an eviction                    | medium   | fixed, the parent record is now durable                            |
| The two Code Mode model tools were declared but could never be called                                         | low      | written down; the policy blocks them on purpose                    |
| The native execution slice cannot run in any real deployment                                                  | low      | written down; it stays dormant until the isolation canary passes   |
| The execution endpoint trusts the approval revision in its body                                               | low      | fixed: the session records its own revision and gates new work     |
| The MCP transport, its OAuth lifecycle, and its elicitation receipt do not exist                              | high     | open, listed above                                                 |
| The browser transport and its Worker bindings do not exist                                                    | high     | fixed: a bounded transport behind the session gateway              |
| A native control in flight broke the Durable Object's restart, so every later prompt failed                   | blocking | fixed: the event relay leaves a control submission alone           |
| A follow-up's model spend was never charged, so the cost cap could be bypassed                                | high     | fixed: a follow-up is charged from the turn it was queued behind   |
| The repository materialization read the whole repository with no turn behind it                               | medium   | fixed: it needs an active operation                                |
| The session context's pin mode claimed diff baselines with no turn behind it                                  | medium   | fixed: the pin mode needs an active operation                      |
| Code Mode was the only capability with no per-turn session authority                                          | medium   | fixed: a Code Mode run is authorized and recorded by the session   |
| A busy conversation was reported as an unknown outcome and kept its operation active                          | medium   | fixed: a busy conversation is a refusal, not an unknown outcome    |
| The MCP grant list was not tied to a turn                                                                     | low      | fixed: it names the turn, as the read does                         |
| An event could be projected for an operation whose dispatch was ambiguous                                     | low      | fixed: an ambiguous dispatch takes no projections                  |
| The external-action providers had no credential source                                                        | high     | fixed: a per-call credential from the deployment credential        |
| A personal MCP grant could name any session, so the session's authority was never consulted                   | high     | fixed: the grant is a session action, with the core's scope rule   |
| The external-action delegate claimed every external mutation, so the cross-session tool was unreachable       | blocking | fixed, with an assembler invariant for an unowned mutation         |
| The publication capability had no model-facing surface                                                        | medium   | fixed: a tool per provider the deployment holds a credential for   |
| An MCP answer could carry a credential into the shared timeline                                               | medium   | fixed: a shared credential guard and a redacted read output        |
| A provider error string reached the model                                                                     | medium   | fixed: bounded public errors on both paths                         |
| The MCP capability had no deployment switch                                                                   | medium   | fixed: the variable, the binding, and the workflow variable        |
| The browser gate asked a question with no answer                                                              | medium   | fixed: the delegate sends the URL                                  |
| The MCP grant list had a broken contract and named the owner                                                  | low      | fixed: the canonical pin shape, gated, no owner                    |
| A read-only MCP capability installed a tool that always failed                                                | low      | fixed: the gateway refuses only when it is off                     |
| The browser effect registration was declared and never consumed                                               | low      | written down as reserved; the invariant makes it a refused runtime |

## How to work in this repository

- Both `feat/pi-first-class` and `feat/pi-go-live-integration-v2` are at the same commit, so the
  integration worktree and the main worktree hold identical trees. Continue in
  `/Users/param/.local/share/opencode/worktree/0e6d72/pi-go-live-v2` on
  `feat/pi-go-live-integration-v2`, and fast-forward `feat/pi-first-class` to it once the lanes are
  green. Nothing has been pushed and nothing has been deployed.
- The upstream pull requests stay on `ColeMurray/background-agents`. The `fork` remote is the user's
  own fork; nothing is pushed without explicit authorization.
- One implementation owner at a time. A capability slice commits once, focused.
- Every slice ends with: shared build first, then focused tests, then the full affected lane, then
  typecheck, lint, format, SQL portability, and the Terraform workflow contracts.
- The frozen route manifests (`hono-route-catalog-conformance.test.ts` and its snapshot) and the
  route admission matrix are updated whenever a route is added. Verify the new entry's authorization
  by hand, then regenerate the snapshot. Regenerate with
  `npx vitest run --config vitest.integration.config.ts -u` from `packages/control-plane`; npm does
  not forward `-u` to vitest.
- The full workerd lane catches what a unit lane cannot. Slice 6B shipped with four failing Pi
  workerd tests and a stale route manifest, and both were found only by running it.
- Python suites on macOS need a short `--basetemp`; a long pytest temp path breaks `AF_UNIX` socket
  binding and is not a product failure.
- The web suite has a few load-sensitive tests that fail in a full run and pass in isolation. They
  are not product failures; re-run the file before believing one.
- Never push, never deploy, never apply Terraform. The user's own environment is the live canary
  target and the upstream pull requests stay on `ColeMurray/background-agents`.

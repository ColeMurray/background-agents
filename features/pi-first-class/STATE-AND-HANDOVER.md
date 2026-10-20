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

| Commit     | What it does                                                                                       | Evidence                                                      |
| ---------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `d484e480` | Latency milestones and characterization of existing flows                                          | —                                                             |
| `bf565b16` | Server-authoritative capabilities, lazy first token, lazy repository pinning and Computer          | 5,115 unit, 2,459 workerd                                     |
| `d1cf7645` | Personal web Pi diagnostics and credential sentinel scan                                           | 54 web                                                        |
| `d888b169` | Durable Slack ingress receipts in D1                                                               | 163 focused                                                   |
| `0f554777` | Slack Queue/DLQ, durable enqueue before ACK, fast-path claim                                       | 12 focused                                                    |
| `d93170c5` | Exactly-once Slack session, thread mapping, prompt, and callback repair                            | 647 Slack                                                     |
| `d5fb92f7` | Pi-native control authority in SessionDO                                                           | 5,126 unit, 2,470 workerd                                     |
| `efca49ae` | Slack ingress flag wired into both Terraform jobs                                                  | 33 workflow contracts                                         |
| `a1e4bd95` | Accessible Pi agent controls and bounded same-session agent tools                                  | 2,540 web                                                     |
| `a4a7aaa9` | SessionDO stays the canonical multiplayer authority                                                | 335 GitHub, 317 Linear                                        |
| `72fc8d8e` | Production Code Mode safety, exact artifact, observed attestation                                  | 10 two-Worker, 101 Terraform                                  |
| `722e41fe` | Generation-78 execution isolation boundary                                                         | 565 Modal, 78 image, 1,668 runtime                            |
| `77fc7be2` | Authorized Pi execution tools, provider canary blocked by default                                  | 5,185 unit                                                    |
| `514db750` | Pi hibernation telemetry, external-action authority, pending-action list                           | 5,226 unit, 2,472 workerd, 2,554 web                          |
| `75be1a63` | External-action lifecycle hardening, grant administration, provider adapters and conformance suite | 5,289 unit, 2,472 workerd, 2,576 web, 49 provider conformance |
| `1c9ec044` | `crossSessionMessaging` capability gate with a version 2 snapshot                                  | 1,308 shared, 5,303 unit                                      |
| `37ef29e8` | Authorized cross-session messaging with durable receipts and provenance                            | 5,305 unit, 2,578 web, 98 Terraform                           |

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

| Capability                   | State                                | Why                                                                                             |
| ---------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Durable Pi chat and recovery | Ready                                | Pi Durable is the transcript and task authority                                                 |
| Credential brokerage         | Ready                                | Memory-only short-lived access token; no API-key fallback                                       |
| Repository analysis          | Ready                                | Commit-pinned, credential-free, provider-backed reads                                           |
| Cloudflare Computer VFS      | Ready behind preview acknowledgement | Lazy, least-authority facade, bounded quota                                                     |
| Repository editing and diffs | Ready behind preview acknowledgement | Lazy overlay, durable diff outbox, generation fence                                             |
| Code Mode                    | Ready behind paid canary             | Task-scoped policy, bounded FIFO, observed attestation                                          |
| Native execution             | **Unavailable by construction**      | Every provider is `canary_blocked` until a live isolation canary passes                         |
| External publication         | Definitions and conformance ready    | Four credential-closed providers pass the generic suite; the credential source is still missing |
| MCP/OAuth                    | Dormant                              | Transport deliberately not installed                                                            |
| Cross-session messaging      | Ready behind its own gate            | Source SessionDO to D1 to target SessionDO, with durable receipts                               |
| Browser/Kitesurf             | Not started                          | Needs the current official API and a SessionDO browser gateway                                  |

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

Everything listed below landed. The remaining item is _bounded public errors_: the public error
bodies still echo a gateway message. Tighten them so a public error never repeats an internal
provider string.

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

**Still open in 7C:** the credential source for each provider. It must come from the encrypted D1
provider-account store, and no provider may be registered until its credential path is in place and
a live canary has published and reconciled one effect. Until then the registry stays empty and the
feature stays off by default.

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

D1 catalog and read projection, owner-only non-delegable review, session pins, identity-first
Lifecycle, opaque callback, S256 enforcement, refresh/revoke/tombstone, RESTRICT user merge, key
rotation, DNS and redirect-safe egress, and stable read tools declared before extension assembly.
Mutations stay prohibited.

### Slice 9 — browser gateway and finish

Browser/Kitesurf as a lazy, default-off, session-scoped SessionDO gateway. Then accessibility,
browser journeys, the ten-minute canary, and two adversarial audit rounds.

## How to work in this repository

- Branch: `feat/pi-go-live-integration-v2` in
  `/Users/param/.local/share/opencode/worktree/0e6d72/pi-go-live-v2`. The main worktree holds the
  integrated feature branch.
- One implementation owner at a time. A capability slice commits once, focused.
- Every slice ends with: shared build first, then focused tests, then the full affected lane, then
  typecheck, lint, format, SQL portability, and the Terraform workflow contracts.
- The frozen route manifests (`hono-route-catalog-conformance.test.ts` and its snapshot) and the
  route admission matrix are updated whenever a route is added. Verify the new entry's authorization
  by hand, then regenerate the snapshot.
- Python suites on macOS need a short `--basetemp`; a long pytest temp path breaks `AF_UNIX` socket
  binding and is not a product failure.
- Never push, never deploy, never apply Terraform. The user's own environment is the live canary
  target and the upstream pull requests stay on `ColeMurray/background-agents`.

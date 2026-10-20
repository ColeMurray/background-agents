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

| Commit     | What it does                                                                              | Evidence                           |
| ---------- | ----------------------------------------------------------------------------------------- | ---------------------------------- |
| `d484e480` | Latency milestones and characterization of existing flows                                 | —                                  |
| `bf565b16` | Server-authoritative capabilities, lazy first token, lazy repository pinning and Computer | 5,115 unit, 2,459 workerd          |
| `d1cf7645` | Personal web Pi diagnostics and credential sentinel scan                                  | 54 web                             |
| `d888b169` | Durable Slack ingress receipts in D1                                                      | 163 focused                        |
| `0f554777` | Slack Queue/DLQ, durable enqueue before ACK, fast-path claim                              | 12 focused                         |
| `d93170c5` | Exactly-once Slack session, thread mapping, prompt, and callback repair                   | 647 Slack                          |
| `d5fb92f7` | Pi-native control authority in SessionDO                                                  | 5,126 unit, 2,470 workerd          |
| `efca49ae` | Slack ingress flag wired into both Terraform jobs                                         | 33 workflow contracts              |
| `a1e4bd95` | Accessible Pi agent controls and bounded same-session agent tools                         | 2,540 web                          |
| `a4a7aaa9` | SessionDO stays the canonical multiplayer authority                                       | 335 GitHub, 317 Linear             |
| `72fc8d8e` | Production Code Mode safety, exact artifact, observed attestation                         | 10 two-Worker, 101 Terraform       |
| `722e41fe` | Generation-78 execution isolation boundary                                                | 565 Modal, 78 image, 1,668 runtime |
| `77fc7be2` | Authorized Pi execution tools, provider canary blocked by default                         | 5,185 unit                         |

## Capability status

| Capability                   | State                                | Why                                                                     |
| ---------------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| Durable Pi chat and recovery | Ready                                | Pi Durable is the transcript and task authority                         |
| Credential brokerage         | Ready                                | Memory-only short-lived access token; no API-key fallback               |
| Repository analysis          | Ready                                | Commit-pinned, credential-free, provider-backed reads                   |
| Cloudflare Computer VFS      | Ready behind preview acknowledgement | Lazy, least-authority facade, bounded quota                             |
| Repository editing and diffs | Ready behind preview acknowledgement | Lazy overlay, durable diff outbox, generation fence                     |
| Code Mode                    | Ready behind paid canary             | Task-scoped policy, bounded FIFO, observed attestation                  |
| Native execution             | **Unavailable by construction**      | Every provider is `canary_blocked` until a live isolation canary passes |
| External publication         | Foundation only                      | No production provider definitions yet                                  |
| MCP/OAuth                    | Dormant                              | Transport deliberately not installed                                    |
| Cross-session messaging      | Not started                          | Requires a D1 receipt migration                                         |
| Browser/Kitesurf             | Not started                          | Needs the current official API and a SessionDO browser gateway          |

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

### Slice 7A — external action authority and gateway correctness

- `packages/control-plane/src/routes/session-external-actions.ts` — the decision route requires
  `sessionRequirement("read")`; it must require `collaborate`. Read authority is not action
  authority: a private break-glass reader and a workspace administrator without current owning-team
  membership must both be refused.
- Add a cursor-bounded pending-action list route plus its SessionDO internal route, so an approver
  does not need an out-of-band action id.
- Gateway gaps: coalesce identical nonterminal effects, rearm a one-shot continuation only after a
  definitive `not_admitted`, add approval expiry and cancellation, enforce source and grant
  provenance, bound public errors, and record occurrence time for every transition.
- Live emergency deny for new prepares and executions while status, reconciliation, audit recovery,
  and revocation stay available.

### Slice 7B — approval and grant surfaces

Pending-action list and decision UI in the existing session page; automation-grant list, create, and
revoke API and UI.

### Slice 7C — provider adapters

Reversible credential-closed GitHub, GitLab, Slack, and Linear comment/reply definitions, a generic
fault-injection conformance suite, and canary scripts. No live calls.

### Slice 8 — read-only MCP and OAuth

D1 catalog and read projection, owner-only non-delegable review, session pins, identity-first
Lifecycle, opaque callback, S256 enforcement, refresh/revoke/tombstone, RESTRICT user merge, key
rotation, DNS and redirect-safe egress, and stable read tools declared before extension assembly.
Mutations stay prohibited.

### Slice 9 — authorized cross-session messaging, browser gateway, and finish

D1 receipts; source SessionDO to D1 authority to target SessionDO to target queue, with provenance
and no direct Pi-to-Pi call. Browser/Kitesurf as a lazy, default-off, session-scoped SessionDO
gateway. Then accessibility, browser journeys, the ten-minute canary, and two adversarial audit
rounds.

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

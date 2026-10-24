# DEVIATIONS.md — what the overlay relaxes, and what compensates

The overlay is the set of capabilities that **extend or relax** Open-Inspect's model. They are
additive: the overlay changes no core file, it attaches to neutral extension points in core, it
carries its own migration range above upstream's, and every feature is **off by default**.

**The one rule the overlay may not break.** The overlay may relax _policy_. It may not remove
_structure_. An **I row** must stay unreachable on every path, overlay included:

- model-driven code cannot reach the Durable Object's `env` or bindings;
- no raw credential in model context, output, logs, or a persisted transcript;
- no identity taken from model output;
- no forged service principal or actor;
- no cached owner, team, or visibility used for authorization;
- no execution of repository-supplied code.

Each entry below records: the §7 row it relaxes, why it is worth it, the compensating control, the
test that proves the compensating control, and how to remove it.

---

## 1. Personal MCP connections with OAuth (C6)

**§7 row relaxed: E-7** — "MCP servers deployment-wide, no team column … per-person connections:
owner-only use, **create entitlement checked**, resolved from current D1 at each call, unattended ⇒
deny or explicit policy". The overlay gives a **person** a credential of their own, against a server
the deployment hosts.

**Why it is worth it.** Open-Inspect's own MCP support is a single deployment-wide static
credential: one encrypted blob, injected as headers, scoped by the session's repositories. A
deployment that needs a per-person token — a GitHub token that carries the person's own access, a
server that issues a personal OAuth grant — cannot get it from the shared lane, and a shared
credential is a shared blast radius.

**The compensating controls.**

| Control                                                                                                                                                                                                                                                                                                    | Where                                                                                                 | Test                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The connection is **only ever used by its owner**. The broker re-reads the owner from D1 on every call and refuses a mismatch.                                                                                                                                                                             | `packages/control-plane/src/cloudflare/mcp-connection-durable-object.ts`                              | `packages/control-plane/test/integration/mcp-connections.test.ts` — "does not let another owner enumerate, read, or delete a connection"                                                                                                                                               |
| The **grant is a session action**: the session's own authority decides, and the session applies the server's repository scope itself.                                                                                                                                                                      | `packages/control-plane/src/routes/mcp-session-pins.ts`                                               | `packages/control-plane/src/db/mcp-session-pins.test.ts` — "refuses a grant from anyone but the connection owner"                                                                                                                                                                      |
| The grant is **re-evaluated against current authority at every call**: the server must still exist, still be enabled, and its repository scope must still cover a repository the session holds; the tool must be in the frozen pin set **and** in the server's current reviewed catalogue.                 | `packages/control-plane/src/session/mcp-grant-scope.ts`                                               | `packages/control-plane/test/integration/mcp-grant-scope.test.ts` — five cases, against real D1                                                                                                                                                                                        |
| The credential **never reaches the model**: the broker holds it, the result is refused if it carries a credential-shaped value, and the connection's storage is encrypted.                                                                                                                                 | `packages/control-plane/src/mcp/encrypted-oauth-provider.ts`; `packages/shared/src/types/mcp-read.ts` | `packages/control-plane/src/session/http/handlers/mcp-session.handler.test.ts` — "refuses a provider answer that carries a credential"; `packages/control-plane/test/integration/mcp-connections.test.ts` — "keeps every Agents OAuth value AES-GCM encrypted and connection-isolated" |
| **Unattended sessions are denied.** A Slack, Linear, GitHub or automation session has no personal credential of its own, so the personal lane refuses it.                                                                                                                                                  | `packages/control-plane/src/session/mcp-grant-scope.ts`                                               | `packages/control-plane/test/integration/mcp-grant-scope.test.ts`                                                                                                                                                                                                                      |
| **The egress is structural, not a hope.** https only; no IP literal; no private or reserved host; the host must be the reviewed server's registered host, checked at connect, on every request and on every redirect, with a cross-host redirect refused; and no credential is attached to any other host. | `packages/control-plane/src/mcp/egress-policy.ts`                                                     | `packages/control-plane/src/mcp/egress-policy.test.ts`                                                                                                                                                                                                                                 |

**How to remove it.** Delete the overlay's MCP package, the `PI_MCP_MODE` flag, and the overlay's D1
migrations. The shared MCP lane is upstream's and is untouched by the removal.

**Open.** The ledger records that the egress guard (`assertMcpEgress`) had **no production caller**
when the branch was audited. The overlay ships it wired; if the wiring is ever removed, the
personal-MCP flag must go with it — that is the rule the brief sets, and it is enforced by the
canary in `features/pi-first-class/TESTING.md`.

---

## 2. The external-action approval ledger (C4)

**§7 row relaxed: D-6** — "No approval / ask primitive anywhere … if built: harness-neutral,
server-side, unattended ⇒ deterministic decline/fail, never wait". The overlay builds the approval
primitive Open-Inspect does not have.

**Why it is worth it.** A harness with no sandbox can reach a provider directly. The approval ledger
is the substitute for the containment the sandbox gave for free: an effect that changes something
outside the model is _prepared_, not performed, and a human decides. It is also the one capability
the whole product is missing: today there is no way to say "this action needs a person".

**The compensating controls.**

| Control                                                                                                                                                                                                                                                                      | Where                                                                                                                                         | Test                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The ledger is **harness-neutral and server-side**: the gateway, the state machine, the expiry and the audit are in the session's own code, and the model-facing adapter is a thin delegate.                                                                                  | `packages/control-plane/src/session/external-action-gateway.ts`                                                                               | `packages/control-plane/src/session/external-action-gateway.test.ts` — "requires approval and executes an approved action exactly once"                   |
| The **model never waits**: a tool call whose effect is awaiting approval is blocked immediately, and the turn continues.                                                                                                                                                     | `packages/control-plane/src/pi/external-action-policy-extension.ts`                                                                           | `packages/control-plane/src/pi/external-action-policy-extension.test.ts` — "persists the prepared action identity before blocking the terminal tool task" |
| **Unattended ⇒ deterministic decline.** An unattended session may hold an owner-scoped automation grant, which is re-resolved from current D1 at prepare and again at execute; with no grant, the effect is refused, not parked for a human to find.                         | `packages/control-plane/src/db/automation-external-action-grants.ts`; `packages/control-plane/src/session/http/handlers/pi-bridge.handler.ts` | `packages/control-plane/src/db/automation-external-action-grants.test.ts`; `packages/control-plane/src/routes/session-external-actions.authority.test.ts` |
| The **credential is minted per call, closed over by the executor**, and never enters the action document, the model context, a result, an error, or a log line.                                                                                                              | `packages/control-plane/src/session/external-action-credentials.ts`                                                                           | `packages/control-plane/src/session/external-action-credentials.test.ts` — "carries the token the way each provider expects it"                           |
| The exact **repository, channel, or issue target is re-authorized before prepare, execute, and reconciliation**. Repository targets must belong to the session, Slack channels must retain their team binding, and Linear is limited to the active turn's originating issue. | `packages/control-plane/src/session/external-action-target-authority.ts`                                                                      | `packages/control-plane/src/session/external-action-target-authority.test.ts`; `packages/control-plane/src/pi/external-action-policy-integration.test.ts` |
| Provider reconciliation reads each provider's real list shape, including Slack's `messages`, so a lost success response cannot re-arm a duplicate publication.                                                                                                               | `packages/control-plane/src/session/external-action-providers/executor.ts`                                                                    | `packages/control-plane/src/session/external-action-providers/executor.test.ts` — "reads Slack conversations.replies messages for reconciliation"         |
| The **audit records ids and state, never content**.                                                                                                                                                                                                                          | `packages/control-plane/src/db/external-action-audit.ts`                                                                                      | `packages/control-plane/src/db/external-action-audit.test.ts`                                                                                             |

**How to remove it.** Delete the overlay's external-action package, the `PI_EXTERNAL_ACTIONS_MODE`
flag, and the overlay's D1 migrations. The core's tool surface loses the external actions, and
nothing else changes.

**Open.** The effect of an unattended action with no grant is _refused_; the row's wording also
allows the entry to be parked until its TTL and then cancelled. **Decided strict pending user:**
refused. The stricter reading is chosen and flagged.

---

## 3. Cross-session messaging (C5)

**§7 row relaxed: F-6** — "Child sessions depth ≤ 2, caps, same repo, author team membership … Pi
`callers` / nested calls must not become an unbounded fan-out outside this". The overlay lets a
session hand a message to _another_ session.

**Why it is worth it.** A durable, cross-session conversation is the one thing the Pi harness offers
that the sandbox harnesses cannot: the agent can carry work from one session to another without a
human copying it. It is also the capability that most needs a boundary, because it is the only one
that reaches _out of_ the session.

**The compensating controls.**

| Control                                                                                                                                                             | Where                                                                       | Test                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Never `PiSessionDO A → PiSessionDO B`.** A message goes out through the _owning_ session, which is the only thing that may send it.                               | `packages/control-plane/src/session/http/handlers/cross-session.handler.ts` | `packages/control-plane/src/pi/cross-session-extension.test.ts` — "hands the message to the owning session and nothing else"                                                                                    |
| The **target is resolved against current D1 at the moment of the call**: the actor must still be an active, unsuspended collaborator in the target, and the source. | `packages/control-plane/src/session/cross-session-authority.ts`             | `packages/control-plane/src/session/http/handlers/cross-session.handler.test.ts` — "refuses a target the actor may not collaborate in" and "refuses a send when the actor lost authority in the source session" |
| The **fan-out is bounded**: depth advances from incoming message provenance, and the fan-out claim plus receipt insert is one atomic D1 statement.                  | `packages/shared/src/types/cross-session.ts`                                | `packages/control-plane/src/db/cross-session-receipts.test.ts`; `packages/control-plane/src/session/http/handlers/cross-session.handler.test.ts`                                                                |
| The **provenance is recorded** on the receiving session's timeline, so a message that arrived from elsewhere is visible as such.                                    | `packages/control-plane/src/session/sandbox-events/processor.ts`            | `packages/control-plane/src/session/sandbox-events/processor.test.ts`                                                                                                                                           |

**How to remove it.** Delete the overlay's cross-session package, the
`PI_CROSS_SESSION_MESSAGING_MODE` flag, and the overlay's D1 migrations.

---

## The overlay's migration range

The overlay's migrations use the **9xxx block**, and the rule is recorded in
`features/pi-first-class/LAYERS.md`:

> **Rule O.** Overlay migrations live in the `9xxx` block (`9001` upward, zero-padded to four
> digits). Upstream's sequence is at `0089`; the `9xxx` block is unreachable by upstream for ~9,900
> more migrations, and the block is **claimed by a CI check** that fails the build if upstream ever
> lands a `9xxx_` file. The check turns a _deployment_ failure into a _review_ failure.

The reason the block cannot simply be "the next free number": `scripts/d1-migrate.sh` **refuses** a
version already recorded under another name, and it fails on a duplicate numeric prefix. A
renumbering is therefore a one-way operation for any installation that already applied the old
number — it is not "skip and continue", it is a deployment that stops. The overlay's numbers are
frozen at first use.

---

## What the overlay does _not_ do

The overlay never makes an I row reachable. Concretely, and each of these is proven by a test in the
core stack:

- model-driven code cannot reach the Durable Object's `env` — the object holds only the bindings it
  may hold (`packages/control-plane/src/cloudflare/binding-scope.ts`, and the test "holds no
  deployment secret in its runtime bindings");
- no raw credential in model context, output, logs, or a persisted transcript (the MCP result check,
  the external-action credential minting, and the binding scope);
- no identity from model output (the actor is the claimed message's author, resolved from D1);
- no forged service principal or actor;
- no cached owner, team, or visibility used for authorization (the grant scope is re-resolved on
  every call);
- no execution of repository-supplied code (the Code Mode sandbox is a separate Worker with no
  bindings; the execution sandbox is credential-free and repo-less).

# Adversarial audit round 4 — the whole Pi surface, capability by capability

Scope: every tool the Pi Durable Object can expose, every route it calls on the owning session,
every credential path, and every cross-session reach. One auditor read the code against the stated
boundary rules and produced eleven findings. This is what each one was, and what changed.

The rule every finding is measured against:

```
Pi proposes an operation
→ the owning session authorizes it
→ D1 resolves the current user, team, workspace, and resource authority
→ a capability-specific durable gateway executes it
→ the result returns through the session's audit, timeline, and budget
→ Pi receives only the bounded, credential-free result
```

Pi never receives a raw privileged client. A capability is always Open-Inspect's, wrapped in
Open-Inspect's boundaries.

## What the audit confirmed

Four categories came back clean, and the evidence is worth recording so a later reader does not have
to re-audit them.

**Credential reach.** The only platform credential that reaches the Pi Durable Object is the model
access token. It lives in memory in the credential store, goes to the model provider, and is cleared
when the object is destroyed. It is never written to storage, never logged, and never placed in a
tool result. The request logger records a method, a path, and a status, never a body.

**Cross-session reach.** The scratch filesystem is one per Durable Object. The repository overlay
lives under a separate root in the same storage. Code Mode is a per-session Durable Object. The MCP
grants are session rows in D1 and the broker re-verifies the owner and the reviewed catalog on every
call. The execution ledger is the session's own SQLite, and a command from another operation is
refused. A cross-session message is authorized by both sides and confirmed by a durable receipt.

**Off by default.** Every deployment switch defaults to `off`. An unknown value resolves to `off`. A
session with no persisted snapshot latches the legacy matrix, which is entirely off.

**Live deny.** A deployment deny blocks new effects — Code Mode calls, sandbox execution, scratch
and repository mutations, MCP reads, cross-session messages in both directions, browser
authorizations, external-action preparation, and external-action approval. It deliberately leaves
the recovery paths open: status, audit, reconciliation, denial, and cancellation stay reachable, so
an emergency never strands work that was already admitted.

## The findings and the fixes

### F1 — the cross-session tool could never be reached (high)

The external-action policy delegate claimed **every** tool with an `external_mutation` effect, but
it only knew how to authorize the tools in its own slot. `message_session` is an external mutation
that belongs to the cross-session delegate, and it lives in another slot. The delegate ran first, so
it refused the call before any cross-session authority was consulted, and the whole feature was
unreachable from the model. The unit tests did not catch it: `message_session` appeared in no test
at all.

The fix has two halves, because the first half alone would only hide the next one.

1. The delegate claims only the tools it owns. A tool it does not describe is left to the delegate
   that does.
2. The assembler now refuses to install a runtime in which an `external_mutation` tool has no owning
   delegate. The invariant is an assembly-time check, so the failure is a refused startup rather
   than a silently disabled capability.

The cross-session capability gained its own delegate and its own early gate. It asks the owning
session whether this turn may reach for another session at all, before a target is chosen, and it
refuses with the session's own reason. The full decision — source, target, actor, receipt — stays
where it was, in the outbound path.

### F2 — the browser gate asked a question with no answer (medium)

The browser delegate sent an empty request to the session's gateway. The gateway's whole job is the
scheme check and the host allowlist, and both key off the URL, so every request was refused as
malformed before any policy ran. The reviewed-host allowlist was never consulted.

The delegate now sends the URL, and the gateway treats an absent URL as a policy refusal rather than
a parse error, so the early gate can ask its question before any page is known.

### F3 — the MCP capability had no deployment switch (medium)

`PI_MCP_MODE` existed in the code and in the environment example but was never wired into the
production Terraform, so the feature was permanently unreachable in a real deployment. The variable,
the worker binding, and the workflow variable are now in place, and the value is validated against
`off`, `read_only`, and `enabled`.

### F4 — an MCP answer could carry a credential into the timeline (medium)

The external-action boundary already refused credential-shaped payloads. The MCP read boundary did
not, and a provider that answered a reviewed read with an access token would have put it into the
model's context and into the shared timeline, where every collaborator can read it.

The guard is now shared. The credential-shaped key list moved into one module, the MCP read result
refuses a payload that carries such a key at any depth, and the timeline keeps the _shape_ of a read
rather than its content: `read`, `mcp_read`, and `repository_read` outputs are redacted in the
shared timeline, exactly as `write` and `edit` already were. The model still receives the full
result.

The refusal happens at the gateway, not only at the agent. The session re-checks the bounded answer
before it returns it, so a credential never leaves the session at all: it is refused with a stable
code, and the refusal is audited with its own reason.

The refusal happens at the gateway, not only at the agent. The session re-checks the bounded answer
before it returns it, so a credential never leaves the session at all: it is refused with a stable
code, and the refusal is audited with its own reason.

### F5 — the provider's own error text reached the model (medium)

The repository-tool path and the MCP-read path forwarded `error.message` verbatim. A provider string
can name an internal URL, a repository, or a credential-fetch failure. The file already stated the
opposite rule for its sibling route, so this was an inconsistency rather than a decision. Both paths
now return a bounded public error and keep the internal reason in the audit.

### F6 — the MCP grant list had a broken contract and named the owner (low)

The route returned `{grants: […]}` while the agent parsed `{pins: […]}`, so the list was always
empty. The route also had no capability gate, unlike its sibling read route, and each grant carried
the owner's user id.

The route now returns the canonical pin shape, is gated by the same capability and live checks as
the read, and never names the owner.

### F7 — a read-only MCP capability installed a tool that always failed (low)

`read_only` installed `mcp_read`, and the gateway demanded `enabled`, so the model was given a tool
that always answered 403. The tool is read-only by declaration, so a read-only capability may use
it. The gateway now refuses only when the capability or the live mode is off.

### F8 — the execution endpoint trusted the body and had no gate (low)

The execution route took the caller's assertion of an approval revision and applied neither the
session's latched capability nor the live deployment mode. The live deny worked only because the Pi
Durable Object's own emergency policy blocked the tool at the hook.

The route now applies the session's own capability and the live mode to new submissions, and it
records its own approval revision rather than the caller's. A command that was already admitted
keeps its status, its output, and its cancellation reachable.

### F9 — the live deny did not cover the scratch reads (low) — deliberately not changed

Flipping the scratch workspace to off stopped the mutations but left the reads working in sessions
that had already latched the capability.

This one was reviewed and left as it is. A read is not privileged — it reads the session's own
scratch space, and nothing outside the session — and the emergency policy exists to stop a session
from _effecting_ something while an operator responds. A deny that also stopped the reads would
strand a turn that is halfway through reading its own workspace, which is the exact failure the
emergency path is meant to avoid. The latched capability still decides whether the tools exist at
all, and a session that never had the capability never has the reads. The decision is recorded here
rather than left implicit.

### F10 — the browser effect registration was a latent trap (low)

The browser's effect registration was declared in the shared registry and consumed by nothing,
because the browser transport is not in place yet. It is now marked as reserved, and the comment
names the three things the transport must bring with it: the slot, the contribution, and an owning
delegate. The assembler's new invariant means the trap is no longer silent — a browser tool without
an owner is a refused runtime, not a blocked tool.

### F11 — the publication capability had no model-facing surface (medium)

The provider definitions existed and passed the conformance suite, but the slot contributed no
tools, so the model had no way to propose a publication at all.

A tool now exists for each provider the deployment named **and** holds a credential for. The
session's own context lists those publications, so the model never sees one that could not complete,
and a publication that reaches the preparation path without a credential is refused before an
approval card is raised. The tool contributes nothing but a provider, an action, and bounded
arguments; the credential is minted per call inside the gateway and never enters the tool, the
result, or the error.

## The credential source

The external publications had no credential source: the definitions, the conformance suite, and the
canary script existed, but nothing closed over a credential.

The credential now comes from the deployment credential the session already holds, and it is minted
per call:

| Provider | Credential                                                                |
| -------- | ------------------------------------------------------------------------- |
| `github` | a source-control installation token, scoped to the session's repositories |
| `gitlab` | the deployment's source-control token                                     |
| `slack`  | the bot token                                                             |
| `linear` | the API key                                                               |

The provider list comes from one deployment variable, and an unknown name is refused rather than
ignored, so a typo never silently narrows what a deployment may publish. A provider without a
credential is not registered, so the agent never sees a publication it could not complete.

The check for a credential is cheap: it reads the deployment's configuration and never mints a token
and never reaches a provider. Only the publication itself mints a credential, once, for one call.

The check for a credential is cheap: it reads the deployment's configuration and never mints a token
and never reaches a provider. Only the publication itself mints a credential, once, for one call.

## What the new invariant is, in one sentence

Every tool that changes something outside the model has a named owner, and the assembler refuses to
install a runtime where one does not.

## What this round does not close

The live gates are unchanged and still open: the browser transport and its canary, the MCP OAuth
lifecycle and its canary, the provider canaries, the paid Code Mode canary, the accessibility
review, and the ten-minute canary on a personal instance. Those need a deployment and a browser, not
a code change.

# Pi design, as currently built

**Derived from:** `features/pi-first-class/PI-INTEGRATION-AUDIT.md` only. Nothing here is a new
design, a new claim, or a new piece of evidence. Where this document states a fact, the audit holds
the `file:line` for it; where this document states a gap, the audit holds the proof of the absence.

**Audited tree:** `11383ce1` on `feat/pi-go-live-integration-v2`
(`packages/control-plane/src/cloudflare/pi-durable-object.ts` and the
`packages/control-plane/src/pi/` directory are the two places the design actually lives).

**Markers used throughout:**

| Marker        | Meaning                                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **DEVIATION** | The current design gives Pi a reach the other harnesses do not have, or withholds a behaviour they have. Each maps to a (D) item in the audit. |
| **GAP**       | The design does not exist. Each maps to an absence in the audit, not to a bug.                                                                 |
| **CORE**      | The primitive lives in Open-Inspect's core, not in the harness. Each maps to a (C) item in the audit.                                          |

---

## 1. The spine, as built

The design is one line with five hops. Everything else in this document is a detail of one of them.

```
model writes a tool call
  │
  ├─ 1. ADMISSION      the call has a declaration, a caller set, a replay decision
  │                    (audit §1.1 rows 8, 7; CORE C1)
  │
  ├─ 2. POLICY HOOK    deployment emergency deny → feature delegates, in a fixed order
  │                    (audit §2 properties 1–2; CORE C3)
  │
  ├─ 3. BRIDGE         the owning SessionDO, over the binding-only internal seam
  │                    (audit §1.1 rows 9, 19–22; CORE C2, C6)
  │
  ├─ 4. GATEWAY        D1 resolves current authority; a capability gateway executes
  │                    (audit §1.4 rows 33, 34, 37, 39; CORE C4, C5, C7, C8, C10)
  │
  └─ 5. RESULT         audit / timeline / budget in the session; a bounded, credential-free
                       result back to Pi
                       (audit §1.1 rows 12–15, 16)
```

### 1.1 Hop 1 — admission

Every tool Pi can run is declared before it is installed, in a registry that lives in the shared
package. The declaration carries three facts: the effect class, the callers allowed to invoke it,
and whether a replayed run is safe. The assembler refuses to install a runtime where a tool and its
declaration disagree in any of the three, where a tool has no declaration, or where a declaration
has no tool. The policy hook then refuses any call whose name is not in the assembled registry, and
any call whose caller is not in that tool's caller set.

_Audit: §2 properties 1–2; inventory row 8; CORE C1._

### 1.2 Hop 2 — the policy hook

One hook, in one slot, with a fixed delegate order: the deployment emergency deny runs first, then
the feature delegates (external action, cross-session, browser, workspace, Code Mode, sandbox
execution), and the durable allow memos are written only after every delegate has allowed. A
delegate that throws fails the tool closed.

The Code Mode delegate is the only one with a _nested_ rule, and it is the one place where the
design's intent and its implementation disagree — see **DEVIATION D2** in §4.

_Audit: inventory row 7; hazard #2, #6; CORE C3._

### 1.3 Hop 3 — the bridge

The Pi Durable Object has three bindings and no D1 binding. It cannot read the session index, the
credentials, the grants, or the MCP connections itself. Everything it needs from the authority it
asks for over an internal route set that the owning SessionDO serves
(`packages/control-plane/src/session/contracts.ts:110-124`). The seam is session-scoped and
identity-bearing, which is exactly why it lives in core and not in the harness.

The DO is not reachable from outside: it is a namespace binding, it has no `onRequest`, and the
capability chain installed by `agents` `Lifecycle` answers any stray HTTP request with `404`.

_Audit: §2 property 3; inventory rows 9, 19–22; hazard #1; CORE C2, C6._

### 1.4 Hop 4 — the gateways

Each capability that reaches outside the session has its own durable gateway, and each one re-reads
current authority at the moment of the call rather than trusting a cached answer:

| Capability              | Gateway                                  | Authority re-read at call time                         |
| ----------------------- | ---------------------------------------- | ------------------------------------------------------ |
| External actions        | the session's approval ledger            | the approval row, its provenance, and its TTL          |
| Cross-session messaging | source authority → D1 → target authority | team membership, collaborator set, user status         |
| MCP (both lanes)        | the session's MCP gateway → the broker   | the grant, the reviewed catalog, the connection status |
| Browser                 | the session's browser gateway            | the capability, the live mode, the host allow-list     |
| Native execution        | the session's execution handler          | the capability, the operation, the generation fence    |
| Credential              | the session's provider broker            | the connected account, the credential version          |

_Audit: inventory rows 33, 34, 19–22, 31, 30, 39; CORE C4, C5, C6, C7, C10._

### 1.5 Hop 5 — the result

The result is bounded and credential-free by construction: the MCP gateway refuses a
credential-shaped answer before it leaves the session, the external-action providers return bounded
public errors, the browser marks page content untrusted and truncates it, and the workspace tools
count against a durable quota. The cost of the turn is measured against a baseline captured before
it and charged to the session's budget.

_Audit: inventory rows 22, 26, 37; CORE C8._

---

## 2. The capabilities, as built

### 2.1 Core execution — transcript, tasks, compaction, subagents, controls

Pi Durable owns the model-facing transcript, the inbox, the conversations, the tasks, the
compaction, and the usage. SessionDO owns the people and the product session. The two are reconciled
by an immutable operation-local outbox that projects Pi's events back into the session's timeline.

The agent-lifecycle controls (`fork`, `reset`, `handoff`, `compact`, `steer`, `follow_up`, exact
cancel) are dispatched only through SessionDO, with idempotent receipts so a retried control acts
once.

> **DEVIATION D8** — one authority covers both posting a message and reshaping the agent's
> conversation. A collaborator who may `collaborate` may also `reset` the agent's context for
> everyone else in the session. _Audit §3 D8; inventory rows 3–5, 11._

### 2.2 Repository analysis and editing

Repository reads are credential-free and commit-pinned: the tool asks the session for fresh scope,
the session pins the identity, and the provider blob is read directly. Editing is a separate, gated
capability: a lazy overlay over the Computer VFS, a durable diff outbox, and a generation fence
before publication.

> **GAP** — Pi's memory and attachment surfaces do not exist; see §3.

### 2.3 Scratch workspace (the Computer VFS)

One credential-free `Workspace` per Pi Durable Object. Filesystem methods only: no shell, no git, no
network, no mounts, no publishing, no execution. Paths cannot cross Pi sessions.

> **DEVIATION D4** — that VFS's `vfs_*` tables live in the same SQLite file as Pi's own `pi_*`
> runtime tables and Open-Inspect's `oi_pi_*` outbox tables, so agent-writable bytes share a
> database with the authoritative transcript and the audit trail. _Audit §3 D4; hazard #9._

> **DEVIATION D5** — the two `oi_pi_*` outbox tables are created at runtime with
> `CREATE TABLE IF NOT EXISTS` rather than through the session's tracked migration registry. _Audit
> §3 D5; hazard #9._

### 2.4 Code Mode

A private QuickJS sandbox in a **separate Worker**, reached over a Durable Object binding, with a
session-wide FIFO, an absolute clamped deadline, a durable admission memo, and a session-level
authorization before the first call. Nested calls from inside a script are restricted to replay-safe
reads.

> **DEVIATION D1** — the Code Mode extension leaves the model-catalog globals and the two model-call
> tools enabled. A script written by the model can therefore reach `models.classify` /
> `models.generateImages` with the session's provider credential. Today the reach is bounded only by
> the accident that the one registered provider's catalog has no classifier or image model. _Audit
> §3 D1; hazard #14._

> **DEVIATION D2** — the nested-call restriction fails _open_ when the durable parent record does
> not match, so a script whose parentage cannot be proven escapes the replay-safe-reads rule and
> reaches the control-effect and replay-unsafe tools. _Audit §3 D2; hazard #3._

### 2.5 Native execution

`run_shell`, `run_build`, `run_tests`, classified `sandbox_execution`. Every provider is
`canary_blocked` until a live isolation canary passes, so the creation snapshot never admits the
capability and the surface is dormant in every deployment.

> **CORE C10** — the isolation boundary, the dispatch fence, and the generation fence are core
> primitives that Pi consumes but does not own.

### 2.6 External actions and publication

Publication is an _effect_, not a tool: the model prepares an effect, a person (or an automation's
grant) approves it, the gateway dispatches it exactly once with a lease, and a lost response is
reconciled by the action's marker. Four credential-closed providers exist (GitHub comment, GitLab
comment, Slack thread reply, Linear comment), each closing over a per-call credential minted from a
deployment credential the agent never sees.

> **CORE C4** — the ledger, the approval record with provenance, the TTL, the cancellation path, and
> the exactly-once dispatch are core.

> **DEVIATION D8** _(shared with §2.1)_ — the approval decision is made under the session's
> `collaborate` authority, which is the same authority that lets a collaborator post.

### 2.7 MCP — two lanes, one tool

The shared lane is the deployment's own MCP servers, with the deployment's own credential, scoped by
the session's repositories against the server's `repo_scope`, exposing only the server's reviewed
read-only tools for its current revision. The personal lane is one person's OAuth credential,
reachable only through the owner's explicit grant to this session, with the reviewed catalog
re-checked in the broker before the provider is touched.

Both lanes are reached through the same model-visible tool, which names either a connection or a
server; the "exactly one" rule is enforced server-side.

> **CORE C6** — the connection row, the encrypted OAuth storage, the grant, the catalog snapshot
> hash, the reviewed catalog, the broker Durable Object, the owner-gated OAuth callback, and the
> credential-shape guard are all core.

> **DEVIATION D7** — one model-visible tool spans two credential domains, so a deployment-wide
> answer can land in one person's session. _Audit §3 D7._

### 2.8 Cross-session messaging

Source session → D1 authority → durable receipt → target session → target queue. No Pi-to-Pi hop.
The source decides, the target revalidates, and the receipt is written before the target is called,
with bounded fan-out and hop depth.

> **CORE C5** — this is a cross-session-boundary primitive and it is core by construction.

### 2.9 Browser

One page per request, no cookie jar, `read` and `screenshot` only, behind a session gateway that
checks the capability, the live mode, the turn's actor, and an operator-reviewed host list. `login`,
`upload`, and `download` are refused by name. The transport is the Workers Browser Rendering
binding.

> **GAP** — the persistent `agents` `Browser` capability (a session-scoped context, a live view, a
> logged-in session) is not integrated, and the transport is one-shot by design. _Audit §1.3 row 32;
> `features/pi-first-class/MULTIPLAYER-COMPATIBILITY-AUDIT.md:96-108`._

### 2.10 Skills

The same managed installation the other harnesses receive, contributed through the upstream `agents`
skills extension and installed only when the session actually has skills.

### 2.11 Memory — **GAP**

Pi has no memory tools. The canonical names are reserved in the shared contract with the note that
"its authorized memory extension remains future work". Open-Inspect's memory service and its D1
stores exist and are harness-neutral; the Pi path does not use them.

_Audit §1.3 row 24._

### 2.12 Attachments and images — **GAP**

Pi refuses attachments outright with an explicit, named error, at the point where a message carrying
attachments is queued.

_Audit §1.3 row 25._

---

## 3. Lifecycle, as built

| Operation | The design as built                                                                                                                                                     | Marker           |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Delete    | the Pi Durable Object is destroyed and its whole storage wiped, then the session row is deleted                                                                         | —                |
| Archive   | the session's archive path runs; its only preservation step is the _sandbox_ hook, and a Pi session never warms a sandbox, so the Pi runtime has no archive step at all | **DEVIATION D6** |
| Export    | the export reads D1; the Pi-native transcript, the task graph, the compaction boundaries and the VFS contents are not in D1 and are not exported — silently             | **DEVIATION D6** |

> **DEVIATION D6** — Pi sessions keep the "archive, delete, export" invariant for delete only.
> _Audit §3 D6; hazard #18._

---

## 4. The deviation register

The short form. The full reasoning, the exploit paths and the fixes are in the audit. The
**D-numbers are identifiers, not an order**; the table is in severity order.

| Order | ID     | Severity | One line                                                                                                                                         | Audit             |
| ----- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| 1     | **D1** | HIGH     | Code Mode scripts keep the model-catalog globals and the two model-call tools, so model-written code can spend the session's provider credential | §3 D1, hazard #14 |
| 2     | **D2** | MEDIUM   | The Code Mode nested-call restriction fails open when the durable parent record does not match                                                   | §3 D2, hazard #3  |
| 3     | **D3** | MEDIUM   | Pi's context and document caches are not zeroed; the built-in ten-minute defaults apply                                                          | §3 D3, hazard #8  |
| 4     | **D4** | MEDIUM   | The agent-writable VFS, Pi's runtime tables and Open-Inspect's Pi outboxes share one SQLite file                                                 | §3 D4, hazard #9  |
| 5     | **D6** | MEDIUM   | Archive and export do not cover the Pi transcript, the task graph or the VFS                                                                     | §3 D6, hazard #18 |
| 6     | **D5** | LOW-MED  | The Pi outbox tables are created at runtime, outside the tracked migration registry                                                              | §3 D5, hazard #9  |
| 7     | **D8** | LOW      | `collaborate` authority covers both posting and resetting/handoff/forking the agent                                                              | §3 D8             |
| 8     | **D7** | LOW      | One MCP tool spans the shared (deployment) lane and the personal (owner) lane                                                                    | §3 D7             |

Five hazards fail: **#3, #8, #9, #14, #18**.

---

## 5. The gap register

| Gap                                            | Status                      | Why it is a gap and not a defect                                                                                                                              |
| ---------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi memory tools                                | absent by decision          | the names are reserved; the service exists and is harness-neutral                                                                                             |
| Pi attachments and images                      | absent by decision          | an explicit refusal, at the queue boundary                                                                                                                    |
| MCP resources and prompts                      | absent by design            | a reviewed-resource model does not exist; promoting a server's prompts to model instructions needs its own effect class                                       |
| MCP elicitation                                | absent by design            | the approval ledger carries _effects_, not questions; an elicitation needs a durable interaction receipt and an answer-delivery mechanism                     |
| The owner's half of the MCP OAuth lifecycle    | open                        | the broker can produce an authorization URL and receive the callback; the browser surface for the URL, the refresh, the revoke and the tombstone do not exist |
| The persistent browser context                 | absent by decision          | the one-shot transport is deliberately the stronger isolation; the product decision on continuity has not been taken                                          |
| Native execution in a real deployment          | dormant                     | every provider is `canary_blocked` until a live isolation canary passes                                                                                       |
| The Pi-native transcript in the session export | **DEVIATION D6**, not a gap | the export succeeds and silently omits it                                                                                                                     |

---

## 6. The comparison with the repository's own documents

### 6.1 `GO-LIVE-INTEGRATION-PLAN.md`

| Plan item                                                                                                     | Plan says       | The code says                                                                                                                          | Verdict                                                                                                          |
| ------------------------------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Invariant 4 (`:22-23`): "PiSessionDO has no public route and receives no D1 binding"                          | —               | namespace binding only, no `onRequest`, no D1 binding                                                                                  | **confirmed**                                                                                                    |
| Invariant 7 (`:28-29`): "Credentials never enter Pi SQLite, Computer VFS, Code Mode, …"                       | —               | the broker token is memory-only; but D1 shows the Code Mode script surface can reach a provider _with_ the session's credential (D1)   | **partly contradicted** by D1                                                                                    |
| Slice 7A (`:334-344`), all five boxes unchecked                                                               | not done        | the ledger, the pending list, the coalescing, the provenance, the expiry, the cancellation and the emergency deny are all in the code  | **stale — the code is ahead**                                                                                    |
| Slice 7B (`:348-351`), both boxes unchecked                                                                   | not done        | the pending list, the decision UI, the grant list/create/revoke                                                                        | **stale — the code is ahead**                                                                                    |
| Slice 7C (`:355-360`), all four boxes unchecked                                                               | not done        | the four provider definitions, the marker reconciliation, the fault-injection conformance suite, the canary script                     | **stale — the code is ahead**; only the _live_ canary is open                                                    |
| Slice 8 (`:364-371`), all four boxes unchecked                                                                | not done        | the D1 foundation (0091), the pins (0094), the reviewed catalog, the gateway, the broker, the live transport, the OAuth callback route | **stale — the code is ahead**; the _UI_ and the _live canary_ are open                                           |
| Slice 9 (`:375-380`), all four boxes unchecked                                                                | not done        | the durable receipts (0093), the source → D1 → target path, the fan-out and depth limits                                               | **stale — the code is ahead**; the browser journey and the soak are open                                         |
| Slice 8's migration number (`:364`): "Add D1 migration 0093 …"                                                | MCP takes 0093  | 0093 is the cross-session receipts migration; MCP took 0091 and 0094                                                                   | **the plan's numbering is wrong**, and it also disagrees with itself, since `:375` assigns 0094 to cross-session |
| `:59-60`: "Browser capability is not implemented in this repository"                                          | not implemented | the transport, the gateway, the tool and the `BROWSER` binding all exist                                                               | **stale — the code is ahead**                                                                                    |
| Slice 5 (`:291-293`): "Replace call identity with authoritative taskId/parentTaskId; enforce truthful policy" | done            | the parent record is durable, but the _lookup_ fails open                                                                              | **half true — see D2**                                                                                           |

### 6.2 `INTEGRATION-CONTRACTS.md`

| Contract                           | Says                                                                                                                                                 | The code says                                                                                                                                                                                                   | Verdict                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Extension slots (`:98-108`)        | eleven slots, ending at `mcp`, with a `workspace` slot                                                                                               | thirteen slots: `policy`, `core`, `delegation`, `agent_messaging`, `skills`, `scratch_workspace`, `repository_editing`, `code_mode`, `sandbox_execution`, `external_actions`, `mcp`, `cross_session`, `browser` | **stale** — `cross_session` and `browser` are missing, and `workspace` was renamed `scratch_workspace` |
| Capability list (`:37-39`)         | `workspace`, `repositoryEditing`, `codeMode`, `sandboxExecution`, `externalActions`, `mcp`                                                           | `scratchWorkspace`, `repositoryEditing`, `codeMode`, `sandboxExecution`, `externalActions`, `mcp`, `crossSessionMessaging`, `browser`                                                                           | **stale** — `workspace` → `scratchWorkspace`, plus two new capabilities                                |
| Migration reservations (`:71-82`)  | SessionDO 58–62, 64; D1 0090, 0091, 0092, 0095                                                                                                       | SessionDO 58–66; D1 0090–0095                                                                                                                                                                                   | **stale** — 63, 65, 66, 0093 and 0094 are unlisted                                                     |
| Tool effects (`:19-33`)            | a unique name, one of six effect kinds, explicit callers, explicit replay; assembly rejects drift                                                    | exactly as implemented                                                                                                                                                                                          | **confirmed**                                                                                          |
| Capability gates (`:42-65`)        | a versioned snapshot, idempotent initialize, live emergency deny, "nested authority matches both the authoritative parent task ID and call identity" | the snapshot and the deny are as described; the nested-authority sentence describes an intent the code does not deliver — the lookup is a comparison, not a proof                                               | **half true — see D2**                                                                                 |
| Product-session boundary (`:9-15`) | SessionDO is canonical; Pi's state is subordinate; no parallel room or public transcript                                                             | as implemented                                                                                                                                                                                                  | **confirmed**                                                                                          |

### 6.3 `MULTIPLAYER-COMPATIBILITY-AUDIT.md`

| Claim                                                                                                | Says             | The code says                                                                                                               | Verdict                                                                                  |
| ---------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `:22`: "No BFF, browser, bot, public route, or Pi tool holds a public PiSessionDO address"           | —                | namespace binding only, no public route                                                                                     | **confirmed**                                                                            |
| `:63-75`: the Computer VFS is scoped by the DO and deleted with it                                   | —                | `deleteAll` on delete                                                                                                       | **confirmed**; but the VFS shares a database file with the transcript — **DEVIATION D4** |
| `:74-75`: "Trace export includes canonical events/diffs/usage, not raw VFS contents"                 | as designed      | the export is D1-only; the Pi-native transcript is not in it either                                                         | **confirmed as designed, but the omission is silent** — **DEVIATION D6**                 |
| `:77-82`: "Browser Run, Agents Browser, and Kitesurf (not implemented)"                              | not implemented  | the one-shot Browser Rendering transport and the tool now exist; the persistent `Browser` and Kitesurf do not               | **partly stale**                                                                         |
| `:92`, `:100-108`: Kitesurf is stateless, one-shot, unsuitable for persistent authenticated browsing | research finding | still not integrated; the one-shot transport is a different binding                                                         | **confirmed**                                                                            |
| `:126`: "MCP … no token in Pi"                                                                       | —                | the token never enters Pi; the _grant_ and the reviewed catalog do                                                          | **confirmed**                                                                            |
| `:129-132`: "Tool calls are never evidence of human permission by themselves"                        | —                | the policy hook and the session gateways implement exactly this                                                             | **confirmed**                                                                            |
| `:152-157`: "PiSessionDO A must never call PiSessionDO B"                                            | —                | the source goes through the source session, D1, and the target session                                                      | **confirmed**                                                                            |
| `:169`: "Durable inbox/scheduling — SessionDO message queue and alarms"                              | —                | the scheduler resolves a harness through `getValidHarnessOrDefault`, and Pi is admitted only when the deployment enables it | **confirmed**                                                                            |

### 6.4 `STATE-AND-HANDOVER.md`

| Claim                                                                                                        | Says               | The code says                                                                                                            | Verdict                                               |
| ------------------------------------------------------------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `:38-39`: Pi collaborators keep the same "archive, delete, export"                                           | all three          | delete only                                                                                                              | **contradicted — D6**                                 |
| `:170-172`: "there is no per-user external-service credential anywhere in Open-Inspect"                      | none               | the personal MCP lane is a per-person OAuth credential                                                                   | **self-contradicted by the same document's "Lane 2"** |
| `:545`: "Code Mode's nested-call restriction lived only in memory and failed open after an eviction — fixed" | fixed              | fixed against eviction; still fails open on a parent-record mismatch                                                     | **half true — D2**                                    |
| `:546`: "The two Code Mode model tools were declared but could never be called"                              | by design          | they are installed and reachable by the `tools` caller; only a policy delegate blocks them, and that delegate fails open | **contradicted — D1, D2**                             |
| `:514-518`: "The transport is installed … What remains is the owner's half"                                  | —                  | the broker, the transport and the callback route exist                                                                   | **confirmed**                                         |
| `:508-510` vs `:523`: the browser transport "does not exist" / "exists"                                      | self-contradictory | it exists                                                                                                                | **the code supports `:523`**                          |
| `:161`: "Native execution — Unavailable by construction"                                                     | —                  | the tools exist but every provider is `canary_blocked`                                                                   | **confirmed**                                         |
| `:180-181`: "A workspace administrator without current owning-team membership … refused"                     | —                  | the decision route requires `collaborate` plus `external_actions.approve`                                                | **confirmed**                                         |
| `:193`: "Every new D1 or Durable Object migration is additive and forward-only"                              | —                  | the D1 and SessionDO migrations are tracked; the two Pi outbox tables are created at runtime                             | **partly true — D5**                                  |

---

## 7. What must not change

These are the properties the current design gets right, and any future work must keep them.

1. **The tool registry stays closed.** No tool may be installed without a declaration, a caller set,
   and a replay decision, and no declaration may exist without a tool.
2. **A mutation without an owner cannot be installed.**
3. **The Pi Durable Object stays unreachable and unbound from D1.**
4. **The credential stays a brokered, short-lived, memory-only token**, and no capability may reach
   a provider with a credential that came from a model, a tool argument, Pi storage, a VFS file, or
   a log line — which is exactly what **D1** violates, and why D1 is first in the queue.
5. **The session stays the only authority.** Pi proposes; the session disposes.
6. **Every capability defaults off and fails closed**, and the live emergency deny blocks new
   admission without stranding admitted work.
7. **Existing harnesses keep the existing path.** OpenCode, Claude and Codex never call
   `PiRuntimeDispatch`.

---

## 8. The order of the work

Derived from the audit's dependency-ordered list (§6 there).

1. **D1** — disable the Code Mode model surface. One option, two declarations, and it removes the
   only HIGH item.
2. **D2** — make the nested restriction fail closed. Same delegate as D1; land them together.
3. **D3** — zero the retention settings. One option object.
4. **D5** — move the two outbox tables into the tracked migration registry.
5. **D6** — decide, then implement, archive and export for Pi.
6. **D4** — give the VFS its own Durable Object.
7. **D7** — split the MCP tool by lane. Hardening.
8. **D8** — separate the agent-lifecycle authority from `collaborate`. A permission-model change.

The gaps in §5 are designs before they are implementations, and each of them is already analysed in
the repository's own audits.

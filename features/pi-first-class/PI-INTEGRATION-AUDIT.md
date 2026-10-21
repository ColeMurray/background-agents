# The Pi integration audit

**Repository:** `colemurray/background-agents` (local clone at
`/Users/param/.local/share/opencode/worktree/0e6d72/pi-go-live-v2`) **Branch:**
`feat/pi-go-live-integration-v2` **Code under audit:** `11383ce1`
(`fix: follow the Computer SDK's own replay policy for the workspace tools`) — the five commits
after it are documentation-only (`2b46d851`, `3ccf5595`, `309d2a70`, `76c45bb5`, `a6ab76de`,
`f82351bf`), so the audited tree is the tree at `11383ce1`. **Date of audit:** 2026-10-21
**Method:** read-only. No source file was modified. This document and `PI-DESIGN-CURRENT.md` are the
only files this audit creates.

## 0. How to read this

Every claim below carries a `file:line`. A claim that could not be checked against the code is in
the **UNVERIFIED** list (§9) and is not asserted anywhere else in this document.

The repository's own documents under `features/pi-first-class/` are **claims to be checked, not
evidence**. Where this audit disagrees with them, it says so explicitly, in §10 and in the second
artifact.

### The buckets

| Bucket                     | Meaning                                                                                                                                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — harness parity**     | The Pi SDK primitive is used the way upstream intends; Open-Inspect adds no behaviour to it.                                                                                                                          |
| **B — adapter / plumbing** | Open-Inspect glue that makes a Pi primitive obey the existing authority, without changing what the primitive does.                                                                                                    |
| **C — core extension**     | A primitive that lives in Open-Inspect's core (`packages/shared`, `packages/control-plane/src/session`, `db/`, `routes/`) rather than inside the harness, because the authority must not live in the agent's runtime. |
| **D — boundary deviation** | A place where Pi's reach differs from the reach every other harness has. Each (D) item carries a severity and a concrete exploit path.                                                                                |

### The spine, as actually implemented

```
Pi tool call
  → PiSessionDO's composite policy hook              (packages/control-plane/src/pi/tool-policy-extension.ts:48)
     → effect registry lookup (no declaration ⇒ block) (packages/control-plane/src/pi/tool-policy-extension.ts:53)
     → caller allow-list (model | tools)               (packages/control-plane/src/pi/tool-policy-extension.ts:54-58)
     → deployment emergency deny                      (packages/control-plane/src/pi/deployment-emergency-policy.ts)
     → owning SessionDO, over the internal bridge     (packages/control-plane/src/session/contracts.ts:110-124)
        → D1 / session SQL resolves current authority
        → capability gateway executes (external action, cross-session, MCP, browser)
        → result returns through the session's audit / timeline / budget
  → Pi receives a bounded, credential-free result
```

The spine is real and it is enforced at every hop that this audit checked. The (D) items in §3 are
all places where **one additional reach** exists that the spine does not cover.

---

## 1. Inventory

Every row is classified into exactly one bucket. "Evidence" is the `file:line` that shows it.

### 1.1 The runtime itself

| #   | Component                                                                                                                      | Bucket     | Evidence                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `PiSessionDO` — the per-session Durable Object                                                                                 | **B**      | `packages/control-plane/src/cloudflare/pi-durable-object.ts:227`; bindings are only `SESSION`, `CODEMODE_SANDBOX`, `BROWSER` (`:167`) — no D1                                                                              |
| 2   | `PiHarness` + `Lifecycle` wiring                                                                                               | **A**      | `packages/control-plane/src/cloudflare/pi-durable-object.ts:606-609`; upstream capability at `node_modules/agents/dist/harness/pi/index.js:326`                                                                            |
| 3   | Transcript / inbox / tasks / conversations / compaction / task graph                                                           | **A**      | upstream `pi-durable` primitives, driven at `packages/control-plane/src/cloudflare/pi-durable-object.ts:806-1063`                                                                                                          |
| 4   | Subagent delegation (`subagent` tool)                                                                                          | **A**      | `packages/control-plane/src/pi/open-inspect-extension.ts:298-330`; declared `control`/`model`-only at `packages/shared/src/pi-tool-effects.ts:39`                                                                          |
| 5   | Agent messaging (`send_agent_message`, `follow_up_agent`, `steer_agent`, `cancel_agent`, `inspect_agents`, `get_last_message`) | **A**      | `packages/control-plane/src/cloudflare/pi-durable-object.ts:301-304, 380-384`; declarations `packages/shared/src/pi-tool-effects.ts:40-44`                                                                                 |
| 6   | Extension assembly + slot order                                                                                                | **B**      | `packages/control-plane/src/pi/extension-assembler.ts:16-30, 79-114`; contributions at `packages/control-plane/src/cloudflare/pi-durable-object.ts:308-519`                                                                |
| 7   | The composite policy hook (before/after tool)                                                                                  | **B**      | `packages/control-plane/src/pi/tool-policy-extension.ts:48-90`                                                                                                                                                             |
| 8   | The Pi tool-effect registry (effect / callers / replay)                                                                        | **C** (C1) | `packages/shared/src/pi-tool-effects.ts:20-22, 35-186`                                                                                                                                                                     |
| 9   | SessionDO's internal bridge routes for the Pi runtime                                                                          | **C** (C2) | `packages/control-plane/src/session/contracts.ts:110-124`; handler `packages/control-plane/src/session/http/handlers/pi-bridge.handler.ts:176`                                                                             |
| 10  | Latched capability snapshot + live emergency deny                                                                              | **C** (C3) | `packages/shared/src/pi-feature-capabilities.ts`; read at `packages/control-plane/src/cloudflare/pi-durable-object.ts:272-274, 1554-1562`; emergency policy `packages/control-plane/src/pi/deployment-emergency-policy.ts` |
| 11  | Pi-native control receipts (idempotent human control)                                                                          | **C** (C9) | `packages/control-plane/src/session/http/handlers/pi-control.handler.ts:76-101`; `packages/control-plane/src/session/pi-control-repository.ts`                                                                             |
| 12  | Projection outbox (Pi events → session timeline)                                                                               | **B**      | `packages/control-plane/src/pi/projection-outbox.ts:17, 257-258`; wired `packages/control-plane/src/cloudflare/pi-durable-object.ts:261-265`                                                                               |
| 13  | Repository-diff outbox and publication                                                                                         | **B**      | `packages/control-plane/src/pi/repository-diff-outbox.ts:10, 268`; `packages/control-plane/src/cloudflare/pi-durable-object.ts:266-269`                                                                                    |
| 14  | Telemetry spans                                                                                                                | **B**      | `packages/control-plane/src/pi/pi-telemetry.ts:148-207` (published to the structured logger)                                                                                                                               |
| 15  | Wake / hibernation control                                                                                                     | **B**      | `packages/control-plane/src/pi/pi-harness-wake.ts`; `packages/control-plane/src/cloudflare/pi-durable-object.ts:163, 233`                                                                                                  |
| 16  | Model catalog + credential broker facade                                                                                       | **B**      | `packages/control-plane/src/cloudflare/pi-durable-object.ts:234-237, 522`; `packages/control-plane/src/pi/codex-credential-store.ts:31-123`                                                                                |

### 1.2 The two MCP lanes

| #   | Component                                                      | Bucket     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 17  | `mcp_read` tool (one tool, two lanes)                          | **B**      | `packages/control-plane/src/pi/mcp-extension.ts:59-118`; declaration `packages/shared/src/pi-tool-effects.ts:163-170`                                                                                                                                                                                                                                                                                                  |
| 18  | Exactly-one-target refinement                                  | **B**      | `packages/shared/src/types/mcp-read.ts:119-133`; enforced server-side at `packages/control-plane/src/session/http/handlers/mcp-session.handler.ts:197`                                                                                                                                                                                                                                                                 |
| 19  | **Lane 1 — shared lane** (deployment credential, `repo_scope`) | **C** (C6) | resolver `packages/control-plane/src/db/mcp-servers.ts:347`; scope `packages/control-plane/src/session/components.ts:736, 816-823`; call `packages/control-plane/src/session/components.ts:834-865`; reviewed-only `packages/control-plane/src/session/components.ts:1721`                                                                                                                                             |
| 20  | **Lane 2 — personal lane** (per-owner OAuth)                   | **C** (C6) | `packages/control-plane/src/db/mcp-connections.ts`; `packages/control-plane/src/db/mcp-session-pins.ts`; `packages/control-plane/src/mcp/encrypted-oauth-provider.ts`; broker DO `packages/control-plane/src/cloudflare/mcp-connection-durable-object.ts`; D1 `terraform/d1/migrations/0092_mcp_oauth_foundation.sql`, `0095_mcp_session_pins.sql`                                                                     |
| 21  | Reviewed read-only catalog                                     | **C** (C6) | `packages/control-plane/src/db/mcp-server-reviews.ts`; `terraform/d1/migrations/0092_mcp_oauth_foundation.sql`                                                                                                                                                                                                                                                                                                         |
| 22  | MCP result credential-shape guard                              | **C** (C6) | `packages/control-plane/src/session/http/handlers/mcp-session.handler.ts:283-306, 397-420`                                                                                                                                                                                                                                                                                                                             |
| 23  | **Which lane a Pi tool call uses**                             | —          | The Pi tool names _either_ a `connectionId` (lane 2) or a `serverId` (lane 1); the Pi DO forwards verbatim (`packages/control-plane/src/cloudflare/pi-durable-object.ts:511-518`) and the SessionDO re-validates in both lanes (`packages/control-plane/src/session/http/handlers/mcp-session.handler.ts:221-289` for lane 1, `:397-420` for lane 2). The two lanes coexist inside one tool and never mix credentials. |

### 1.3 Memory, workspace, code mode, execution, browser

| #   | Component                                                      | Bucket      | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 24  | **Pi memory tools** — absent                                   | —           | no memory extension exists under `packages/control-plane/src/pi/`; the canonical names are reserved with the note "its authorized memory extension remains future work" (`packages/shared/src/memory-tools.ts:69-71`). Open-Inspect's memory lives in D1 (`packages/control-plane/src/db/memory-records.ts`, `db/session-memory-selections.ts`, `db/memory-preferences.ts`, `db/memory-queries.ts`) behind `packages/control-plane/src/memory/session-memory-service.ts` and the sandbox route `packages/control-plane/src/routes/session-memories.ts`                            |
| 25  | **Attachments / images** — refused                             | —           | `packages/control-plane/src/session/message-queue.ts:1332-1333` (`HarnessModelIncompatibleError("Pi Durable does not support attachments yet.")`)                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 26  | Computer VFS / scratch workspace (`scratchWorkspace`)          | **A**       | `packages/control-plane/src/cloudflare/pi-durable-object.ts:1277-1296`; `@cloudflare/computer` `Workspace` at `node_modules/@cloudflare/computer/dist/index.js:95-137`                                                                                                                                                                                                                                                                                                                                                                                                            |
| 27  | Repository-editing overlay + bounded quota                     | **A**       | `packages/control-plane/src/pi/repository-editing-capability.ts`; wired `packages/control-plane/src/cloudflare/pi-durable-object.ts:395-457`                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 28  | Code Mode — the extension and its policy delegate              | **B**       | `packages/control-plane/src/pi/codemode-extension.ts:223-288`; slot `packages/control-plane/src/cloudflare/pi-durable-object.ts:458-467`                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 29  | Code Mode — the sandbox itself (separate Worker)               | **A**       | `packages/control-plane/src/cloudflare/pi-durable-object.ts:1392-1403` (`RemoteCodemodeSandbox` → `CODEMODE_SANDBOX` namespace); the sandbox Worker `packages/pi-codemode-sandbox/src/index.ts:1`; Terraform `terraform/environments/production/workers-control-plane.tf:254-259`                                                                                                                                                                                                                                                                                                 |
| 30  | Native execution tools (`run_shell`, `run_build`, `run_tests`) | **C** (C10) | `packages/control-plane/src/pi/sandbox-execution-extension.ts`; `packages/control-plane/src/session/pi-sandbox-execution.ts`; handler `packages/control-plane/src/session/http/handlers/pi-sandbox-execution.handler.ts`                                                                                                                                                                                                                                                                                                                                                          |
| 31  | Browser tool + one-shot transport                              | **B**       | `packages/control-plane/src/pi/browser-extension.ts`, `packages/control-plane/src/pi/browser-transport.ts:1-50`; the transport is the Workers **Browser Rendering binding**, one request per page, no cookie jar (`packages/control-plane/src/cloudflare/browser-rendering-transport.ts:29-60`); the binding is staged at `terraform/environments/production/workers-control-plane.tf:78`; the gate is `packages/control-plane/src/session/http/handlers/browser-gateway.handler.ts`; the slot is `packages/control-plane/src/cloudflare/pi-durable-object.ts:493-505`            |
| 32  | "Kitesurf"                                                     | —           | **Absent.** `grep -rni "kitesurf" packages/` returns nothing. Kitesurf is a Cloudflare Browser Run product — stateless, one-shot, CDP-WebSocket scoped, and (per the repository's own browser research) unsuitable for persistent authenticated browsing (`features/pi-first-class/MULTIPLAYER-COMPATIBILITY-AUDIT.md:77-108`). What exists instead is the Workers Browser Rendering binding, one-shot and cookie-free (row 31), which is the same _shape_ as the one-shot Kitesurf model but a different binding. The persistent `agents` `Browser` capability is not integrated |

### 1.4 Effects, messaging, skills, scheduling, budget

| #   | Component                                        | Bucket     | Evidence                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 33  | External actions (publication) + approval ledger | **C** (C4) | `packages/control-plane/src/session/external-action-gateway.ts`; `packages/control-plane/src/routes/session-external-actions.ts`; provider definitions `packages/control-plane/src/session/external-action-providers/`; D1 `terraform/d1/migrations/0091_external_actions.sql`                                                                                           |
| 34  | Cross-session messaging + durable receipts       | **C** (C5) | `packages/control-plane/src/session/cross-session-authority.ts`; `packages/control-plane/src/session/http/handlers/cross-session.handler.ts`; D1 `terraform/d1/migrations/0094_cross_session_receipts.sql`                                                                                                                                                               |
| 35  | Skills                                           | **A**      | `packages/control-plane/src/pi/managed-skills-extension.ts:16-24` (wraps upstream `agents/harness/pi` `skills()`); installed only when the session has skills (`packages/control-plane/src/cloudflare/pi-durable-object.ts:385-394`)                                                                                                                                     |
| 36  | Scheduling / automations                         | **B**      | `packages/control-plane/src/scheduler/scheduler.ts:621-627` (harness resolved by `getValidHarnessOrDefault`, `packages/shared/src/harnesses.ts:95-97`); admission `packages/control-plane/src/harness-admission.ts:40`                                                                                                                                                   |
| 37  | Budgets, usage, cost                             | **C** (C8) | `packages/control-plane/src/session/budget-service.ts`; `packages/control-plane/src/pi/accounting.ts`; trusted pricing `packages/control-plane/src/pi/pricing.ts`; admission `packages/control-plane/src/cloudflare/pi-durable-object.ts:1419-1426`                                                                                                                      |
| 38  | Provider / model resolution                      | **A**      | `packages/control-plane/src/pi/runtime-contract.ts:166-172` (`toPiModel` accepts only `openai/*` → provider `openai-codex`); the only provider registered is `openaiCodexProvider()` (`packages/control-plane/src/cloudflare/pi-durable-object.ts:522`); harness catalog `packages/shared/src/harnesses.ts:75-81` (`pi`: strict, `openai` only, `provider_account` only) |
| 39  | Provider credential path                         | **C** (C7) | `packages/control-plane/src/session/pi-credential-service.ts`; broker facade `packages/control-plane/src/pi/codex-credential-store.ts:31-123`; the DO fetches a short-lived token from the owning session (`packages/control-plane/src/cloudflare/pi-durable-object.ts:1564-1620`)                                                                                       |
| 40  | Session-bound credential never leaves            | —          | `CodexBrokerCredentialStore.delete` is a no-op by design (`packages/control-plane/src/pi/codex-credential-store.ts:70-75`); the token is memory-only (`:32-35`)                                                                                                                                                                                                          |

### 1.5 The core surfaces Pi consumes (unchanged by the Pi work)

| #   | Component                                                                          | Bucket | Evidence                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 41  | SessionDO's authorization, RBAC, multiplayer, timeline, ordering, callbacks, audit | **A**  | `packages/control-plane/src/session/components.ts`; Pi reaches it only through the internal bridge (`packages/control-plane/src/session/contracts.ts:110-124`) |
| 42  | D1 session index, grants, OAuth storage                                            | **A**  | `packages/control-plane/src/db/`; PiSessionDO has no D1 binding (`packages/control-plane/src/cloudflare/pi-durable-object.ts:167`)                             |

---

## 2. What the spine gets right

Four properties of the implementation are worth stating positively, because they are the reason the
(D) list is short:

1. **The tool registry is closed by construction.** The assembler refuses to install a runtime where
   a tool has no effect declaration
   (`packages/control-plane/src/pi/extension-assembler.ts:185-187`), where the tool's callers differ
   from the declaration's (`:188-190`), where the tool's replay flag differs (`:191-193`), or where
   a declaration has no tool (`:195-197`). A new tool cannot appear without an effect, a caller set,
   and a replay decision.
2. **A mutation with no owner cannot be installed.** `validateMutationOwnership`
   (`packages/control-plane/src/pi/extension-assembler.ts:129-143`) throws for any
   `external_mutation` that no contribution claims, and the policy extension is mandatory
   (`:95-102`).
3. **The Pi Durable Object is not reachable from the internet.** `PI_SESSION` is a Durable-Object
   namespace binding only (`packages/control-plane/src/cloudflare/platform.ts:23`), it is addressed
   only through `namespace.getByName(sessionId)` RPC
   (`packages/control-plane/src/cloudflare/pi-runtime-dispatch.ts:13`), and `PiSessionDO` defines no
   `onRequest` (`packages/control-plane/src/cloudflare/pi-durable-object.ts:227`). The `agents`
   `Lifecycle` installs a `fetch` handler on any host that lacks one
   (`node_modules/agents/dist/lifecycle-DGorpAmA.js:919-936`), but no installed capability claims an
   HTTP request, so the fallback is `404 Not implemented`
   (`node_modules/agents/dist/lifecycle-DGorpAmA.js:995-1011`).
4. **The credential path is a broker, not a key.** Pi holds a short-lived access token in memory and
   cannot write to the store (`packages/control-plane/src/pi/codex-credential-store.ts:55-75`).

---

## 3. (D) Boundary deviations, severity-ordered

The **D-numbers are identifiers, not an order**. The severity order is:

| Order | ID     | Severity   | One line                                                                                      |
| ----- | ------ | ---------- | --------------------------------------------------------------------------------------------- |
| 1     | **D1** | HIGH       | Code Mode scripts keep the model-catalog globals and the two model-call tools enabled         |
| 2     | **D2** | MEDIUM     | The Code Mode nested-call restriction fails open when the durable parent record is missing    |
| 3     | **D3** | MEDIUM     | Pi's context and document caches are not zeroed                                               |
| 4     | **D4** | MEDIUM     | Three table families share one SQLite database inside `PiSessionDO`                           |
| 5     | **D6** | MEDIUM     | Archive and export do not cover the Pi transcript, the task graph, or the VFS                 |
| 6     | **D5** | LOW-MEDIUM | Pi's DO-local tables are created at runtime instead of through the tracked migration registry |
| 7     | **D8** | LOW        | One authority covers both prompting and agent-lifecycle control                               |
| 8     | **D7** | LOW        | One tool, two trust domains: `mcp_read` spans the shared lane and the personal lane           |

### D1 — HIGH — Code Mode scripts keep the model-catalog globals and the model-call tools enabled

**What.** The Code Mode extension is created without disabling the model surface:
`createCodemodeExtension({ sandbox })` (`packages/control-plane/src/pi/codemode-extension.ts:243`).
Upstream's `models` option defaults to `true`
(`node_modules/@earendil-works/pi-durable/dist/codemode/codemode.d.ts:161-162`), so the extension
installs the two model-call tools
(`node_modules/@earendil-works/pi-durable/dist/codemode/codemode.js:110`, tools defined at
`node_modules/@earendil-works/pi-durable/dist/codemode/models.js:198-229`) and exposes the catalog
globals `models.getModelsOfType`, `models.getAvailableOfType`, `models.getModelOfType` to every
script (`node_modules/@earendil-works/pi-durable/dist/codemode/models.js:13-17`, wired at
`node_modules/@earendil-works/pi-durable/dist/codemode/codemode.js:224-227`).

Open-Inspect registers the two tools as `external_read` / `replay: unsafe` / `callers: ["tools"]`
(`packages/shared/src/pi-tool-effects.ts:78-100`) and blocks them in the Code Mode policy delegate
(`packages/control-plane/src/pi/codemode-extension.ts:229-232`). A _policy_ block is not an effect
classification: the tools remain installed, callable by the `tools` caller, and are blocked only
while the Code Mode parentage can be proven (see D2).

**Why this is a boundary deviation.** The invariant is "a capability never reaches a provider with a
credential that came from a model, a tool argument, Pi storage, a VFS file, or a log line"
(`features/pi-first-class/STATE-AND-HANDOVER.md:48-50`). `models.classify(...)` sends a
model-written context to the provider **using the session's Codex broker credential**
(`packages/control-plane/src/cloudflare/pi-durable-object.ts:234-237, 522`). The arguments are
model-written script arguments; the credential is the session's. No other harness's script surface
can do this, because no other harness has a script surface.

**Today the blast radius is bounded, and that bound is accidental.** The only provider registered is
`openai-codex` (`packages/control-plane/src/cloudflare/pi-durable-object.ts:522`), and that
provider's catalog contains **only chat models** — `gpt-5.3-codex-spark`, `gpt-5.5`, `gpt-5.6-luna`,
`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-6-astra`, `gpt-6-luna`, `gpt-6-sol`, `gpt-6.1-sol`
(`node_modules/@earendil-works/pi-ai/dist/providers/data/openai-codex.json`). `resolveModel`
therefore rejects a classifier or an image model
(`node_modules/@earendil-works/pi-durable/dist/codemode/models.js:164-180`), so no paid call is
possible _today_. The catalog globals do still expose the chat catalog to script code, and the
`tools` caller is already a second model-call path the moment any image or classifier model is
registered.

**Exploit scenario (the day a second provider is registered, or the catalog gains an image or
classifier model):**

- _Actor:_ the model inside a Pi session, through the Code Mode tool.
- _Steps:_ (1) the model writes a Code Mode script that calls
  `models.classify({provider: "<provider>", id: "<image-model-id>"}, {state: {...}})`; (2) the
  script runs in the QuickJS sandbox with the `tools` caller, so the model-call tools' caller
  allow-list is satisfied; (3) the tool executes against the session's Codex broker credential
  (`packages/control-plane/src/pi/codex-credential-store.ts:42-48`); (4) because the tool is
  declared `replay: "unsafe"` but nothing enforces replay-safety on the script path, a resumed run
  repeats the charge.
- _Unauthorized reach:_ the session's provider credential is spent on an operation the model
  invented, outside the turn's cost accounting, bypassing the `requirePricedModel` admission at
  `packages/control-plane/src/cloudflare/pi-durable-object.ts:1419-1426` (which only guards the
  turn's own model).

**Fix.** Pass `models: false` to `createCodemodeExtension`
(`packages/control-plane/src/pi/codemode-extension.ts:243`), and drop the two registrations from
`PI_CODEMODE_TOOL_EFFECT_REGISTRATIONS` (`packages/shared/src/pi-tool-effects.ts:78-100`). The
assembler already enforces that a declaration has a tool and a tool has a declaration
(`packages/control-plane/src/pi/extension-assembler.ts:185-197`), so the change is symmetric. If
image or classifier support is ever wanted, it must come through the session's own gateway the way
every other provider call does.

### D2 — MEDIUM — the Code Mode nested-call restriction fails open when the durable parent record is missing

**What.** The Code Mode policy delegate decides whether a call is a nested Code Mode call by
_proving_ the parentage:

```ts
const parentCallId = await state.parents.get(call.parent.taskId);
if (parentCallId !== call.parent.callId) return undefined; // ← allow
```

(`packages/control-plane/src/pi/codemode-extension.ts:225-233`). The registry is durable
(`packages/control-plane/src/pi/codemode-extension.ts:78-93`, wired at
`packages/control-plane/src/cloudflare/pi-durable-object.ts:283`), and the parent record is written
before the tool executes and removed after (`:273-281`). But the check is _prove-then-restrict_: if
the record is absent or stale, the nested call is treated as a top-level call and the "Code Mode may
call only replay-safe read tools" rule (`packages/control-plane/src/pi/codemode-extension.ts:231`)
never applies.

**Why this is a boundary deviation.** The repo's own handover records the opposite intent — "Code
Mode's nested-call restriction lived only in memory and failed open after an eviction" was recorded
as a _fixed_ gap (`features/pi-first-class/STATE-AND-HANDOVER.md:545`). It is fixed against
eviction; it is not fixed against a _parent/child identity mismatch_, which is the remaining
fail-open.

**Exploit scenario:**

- _Actor:_ the model inside a Pi session, through the Code Mode tool.
- _Steps:_ (1) the model writes a script; (2) the script calls a tool that the Code Mode restriction
  would block — the two `pi.codemode.models.*` tools (`callers: ["tools"]`, `replay: "unsafe"`,
  `packages/shared/src/pi-tool-effects.ts:84-100`) or `activate_skill` (`effect: "control"`,
  `callers: ["model", "tools"]`, `packages/shared/src/pi-tool-effects.ts:58-62`); (3) the script's
  parent task id does not match the record the parent wrote — which happens when the parent task is
  resumed under a different task id after a restart, or when the nested call is issued from a task
  the parent never registered; (4) the delegate returns `undefined` (allow) and the tool runs.
- _Unauthorized reach:_ the script escapes the read-only restriction that the Code Mode boundary
  exists to enforce, reaching a control-effect tool and the two replay-unsafe model-call tools that
  D1 leaves installed.

**Second layer, and what still holds.** The caller allow-list is independent and still applies
(`packages/control-plane/src/pi/tool-policy-extension.ts:54-58`): `codemode` and `mcp_read` are
`callers: ["model"]` only (`packages/shared/src/pi-tool-effects.ts:79-83, 163-170`), so a script
cannot re-enter Code Mode or call MCP through this path. The exposure is limited to the tools whose
caller set already includes `tools`.

**Fix.** Invert the test: treat "a nested call whose parent cannot be proven" as blocked, and bind
the record to the call id as well as the task id (the record already stores the call id at
`packages/control-plane/src/pi/codemode-extension.ts:86-88`; the _lookup_ is what is
non-authoritative). Removing the `return undefined` fail-open branch is a three-line change.

### D3 — MEDIUM — Pi's context and document caches are not zeroed

**What.** `Harness.open` is called with only `models` and `registry`
(`packages/control-plane/src/cloudflare/pi-durable-object.ts:524-531`). `settings` is optional
(`node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts:519-523`) and therefore
`contextRetentionMs` falls back to `DEFAULT_CONTEXT_RETENTION_MS = 600_000`
(`node_modules/@earendil-works/pi-durable/dist/harness/agent.js:32-33, 50`) and
`documentRetentionMs` to its built-in default (`…/agent.js:51`). The standing hazard expects both to
be `0` for Pi (`features/pi-first-class/PI-REMAINING-AUDIT-BRIEFS.md:46`).

**Why this is a boundary deviation.** Every other harness's context lives in a sandbox process that
dies with the run. Pi's context lives in a Durable Object that stays resident between turns. A
non-zero retention means a conversation's rendered context is held in the DO's memory for ten
minutes after it goes idle
(`node_modules/@earendil-works/pi-durable/dist/harness/scheduler.js:357-399`), and documents stay
cached for their default window.

**Exploit scenario (bounded, and it needs a second actor in the same session):**

- _Actor:_ a collaborator with read authority on the session who is not the turn's actor.
- _Steps:_ (1) actor A's turn renders a context into the DO's cache; (2) the turn ends and the
  conversation goes idle; (3) actor B's turn starts within the retention window and the harness
  reads the retained context instead of re-reading from storage; (4) actor B therefore receives
  content that was rendered for actor A's turn.
- _Unauthorized reach:_ the retained context is the _rendered_ context of another actor's turn.
  Whether it crosses into actor B's model request depends on the harness's read path, which this
  audit did not trace end to end (see §9, UNVERIFIED-6).

**Fix.** Pass `settings: { contextRetentionMs: 0, documentRetentionMs: 0 }` in the `Harness.open`
options (`packages/control-plane/src/cloudflare/pi-durable-object.ts:524-531`).

### D4 — MEDIUM — three table families share one SQLite database inside `PiSessionDO`

**What.** The Pi Durable Object's storage is used by three independent writers:

| Family                     | Owner                  | Table prefix | Evidence                                                                                                              |
| -------------------------- | ---------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------- |
| Pi's own runtime state     | `agents`/`pi-durable`  | `pi_`        | `node_modules/agents/dist/harness/pi/index.js:29, 32`                                                                 |
| Open-Inspect's Pi outboxes | this repo              | `oi_pi_*`    | `packages/control-plane/src/pi/projection-outbox.ts:17`, `packages/control-plane/src/pi/repository-diff-outbox.ts:10` |
| The Computer VFS           | `@cloudflare/computer` | `vfs_*`      | `node_modules/@cloudflare/computer/dist/index.js:95-137`                                                              |

The VFS is opened on the same `this.ctx.storage`
(`packages/control-plane/src/cloudflare/pi-durable-object.ts:1279-1282`), so all three live in one
SQLite file.

**Why this is a boundary deviation.** The VFS holds model-written content (the scratch files and the
repository overlay). The Pi tables hold the authoritative transcript and the task state. The
`oi_pi_*` tables hold the audit/outbox trail. Open-Inspect's own invariant is that the agent's
writable content and the session's authority live in separate stores — the sandbox's `/workspace` is
a different filesystem from the session's records. Inside one SQLite file, a failure that affects
the database (a full volume, a corrupt page, a long-running write) affects the transcript and the
audit trail together, and the untrusted VFS shares the file with both.

**Exploit scenario:** not a direct takeover; a durability and blast-radius deviation.

- _Actor:_ an adversary who can make the sandbox write a large or pathological file set.
- _Steps:_ (1) the model writes into the scratch VFS through the workspace tools
  (`packages/control-plane/src/pi/computer-workspace-extension.ts`); (2) the VFS's blob and chunk
  tables (`node_modules/@cloudflare/computer/dist/index.js:121-137`) grow inside the DO's database;
  (3) the database's write capacity is consumed.
- _Unauthorized reach:_ the Pi transcript and the projection outbox — the session's audit trail —
  become unwritable in the same failure envelope as the attacker-controlled content.

**Fix.** Give the VFS its own Durable Object (its own storage), so the agent's writable bytes never
share a file with the transcript. If that is too large, at minimum put the `oi_pi_*` outboxes in the
SessionDO's database, which is already migration-tracked.

### D5 — LOW-MEDIUM — Pi's DO-local tables are created at runtime instead of through the tracked migration registry

**What.** `PiProjectionOutbox` and `RepositoryDiffOutbox` create their tables with
`CREATE TABLE IF NOT EXISTS` at construction
(`packages/control-plane/src/pi/projection-outbox.ts:257-258`,
`packages/control-plane/src/pi/repository-diff-outbox.ts:268`), rather than through the SessionDO's
numbered migration registry, which does track the Pi migrations by id
(`packages/control-plane/src/session/schema.ts:444-452, 939-1060`;
`packages/shared/src/pi-migration-reservations.ts`).

**Why this is a boundary deviation.** The stated invariant is "every new D1 or Durable Object
migration is additive and forward-only. Rollback disables admission first and never deletes a
binding or stored data" (`features/pi-first-class/STATE-AND-HANDOVER.md:46-48`). Runtime
`IF NOT EXISTS` creation is additive, so the letter of the invariant holds, but the tables are
invisible to the schema's own tests and to the rollback story: an older binary that lacks the outbox
code finds the tables already present and keeps using them.

**Fix.** Move both table definitions into the migration registry as tracked migrations with reserved
ids, and let the outbox assert that the tables exist rather than create them.

### D6 — MEDIUM — archive and export do not cover the Pi transcript, the task graph, or the VFS

**What.** Three lifecycle operations behave differently for Pi:

| Operation | Sandbox harness                         | Pi                                                                                                      | Evidence                                                                                                                                                    |
| --------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delete    | sandbox teardown + session delete       | Pi Durable Object destroyed and its storage wiped                                                       | `packages/control-plane/src/routes/session-index.ts:469-476` → `packages/control-plane/src/cloudflare/pi-durable-object.ts:1212-1261` (`:1258` `deleteAll`) |
| Archive   | `sandboxLifecycle.preserveForArchive()` | **no Pi hook** — the sandbox hook is the only preservation step, and a Pi session never warms a sandbox | `packages/control-plane/src/session/http/handlers/session-lifecycle.handler.ts:165-176`                                                                     |
| Export    | D1 trace export                         | **D1 only** — the Pi-native transcript, task graph, compaction state and VFS contents are not in D1     | `packages/control-plane/src/routes/session-export.ts:376-387`, `packages/control-plane/src/db/session-export-store.ts`                                      |

**Why this is a boundary deviation.** The non-regression invariant says Pi collaborators keep the
same "archive, delete, and export" behaviour
(`features/pi-first-class/STATE-AND-HANDOVER.md:38-39`). Delete is honoured; archive and export are
not.

**Exploit scenario (data loss, not takeover):**

- _Actor:_ a session owner who archives a Pi session and later exports it, or an operator asked to
  produce a trace for a Pi session.
- _Steps:_ (1) the owner archives the Pi session; (2) the operator runs the session export.
- _Unauthorized reach:_ the export contains the projected messages but not the Pi-native transcript,
  the task graph, the compaction boundaries, or the scratch/repo VFS contents — so the durable
  record of what the agent did is incomplete, and it is incomplete _silently_ (the export succeeds).

**Fix.** Either extend the export with the Pi DO's own read surface (there is one: `lookup` and
`status` on `packages/control-plane/src/cloudflare/pi-runtime-dispatch.ts:23-25`), or state plainly
in the export response that Pi-native state is not included, and add a preservation step to the
archive path.

### D7 — LOW — one tool, two trust domains: `mcp_read` spans the shared lane and the personal lane

**What.** `mcp_read` accepts either a `connectionId` or a `serverId`
(`packages/control-plane/src/pi/mcp-extension.ts:63-75`). Lane 2 uses one person's OAuth credential;
lane 1 uses a deployment-wide credential with the session's `repo_scope`
(`packages/control-plane/src/session/components.ts:816-865`). Both are re-validated server-side
(`packages/control-plane/src/session/http/handlers/mcp-session.handler.ts:197, 221-289, 397-420`),
and the "exactly one target" rule is enforced there, not in the tool
(`packages/shared/src/types/mcp-read.ts:131-133`).

**Why this is a boundary deviation.** A single model-visible tool with two credential domains is a
wider reach than every other harness's MCP surface, which has exactly one. The reach is bounded —
the SessionDO gates both lanes and the result is credential-free
(`packages/control-plane/src/session/http/handlers/mcp-session.handler.ts:283-306`) — but the
_scope_ of the shared lane is the deployment's, not a person's, so its answers are deployment-wide
data landing in one person's session.

**Fix (optional, hardening).** Split into two tools (`mcp_read_shared`, `mcp_read_connection`) so
the model cannot confuse the domains, and keep the "exactly one" rule at the tool boundary as well
as the server boundary.

### D8 — LOW — one authority covers both prompting and agent-lifecycle control

**What.** The Pi control route requires `requireSession("collaborate")` for the write actions
(`packages/control-plane/src/routes/pi-controls.ts:85-92`), and the same route admits `fork`,
`reset`, `handoff`, `compact`, `steer`, `follow_up` and `cancel_exact`
(`packages/control-plane/src/session/http/handlers/pi-control.handler.ts:30-39`). The Pi DO bounds
them (32 conversations, 4 active tasks, 16 pending agent messages:
`packages/control-plane/src/cloudflare/pi-durable-object.ts:811, 943, 962, 991, 1003`), and the
handler refuses controls on a non-promptable session
(`packages/control-plane/src/session/http/handlers/pi-control.handler.ts:69-73`).

**Why this is a boundary deviation.** A collaborator who may post a message also may reset the
agent's conversation, hand it off, or fork it. For a sandbox harness, `/compact` and `/clear` belong
to the same person who types the message, so this is not unusual — but for Pi, `fork` and `handoff`
create and reshape _durable_ conversations inside a shared multiplayer session, and those
conversations are visible to every collaborator.

**Exploit scenario (bounded):**

- _Actor:_ a collaborator with `collaborate` authority on the session.
- _Steps:_ (1) the collaborator sends `reset` for the agent's live conversation
  (`packages/control-plane/src/cloudflare/pi-durable-object.ts:931-941`); (2) the agent's context is
  destroyed for every other collaborator watching the same conversation.
- _Unauthorized reach:_ loss of the agent's working context, by a collaborator who was only
  authorised to post. Not a credential or authority breach; a destructive action under a messaging
  authority.

**Fix.** Give the agent-lifecycle actions (`fork`, `reset`, `handoff`, `compact`) their own
permission, or require the turn's actor rather than session-level `collaborate`.

---

## 4. (C) Core-extension register

Each entry answers: what primitive, why it is necessary, where the single-tenant design pulls,
whether it should be pushed further into core, and who else needs it.

### C1 — The tool-effect registry and the assembler invariants

- **Primitive.** A per-tool declaration of `effect` (`local_read`, `local_mutation`,
  `external_read`, `external_mutation`, `sandbox_execution`, `control`), `callers` (`model` |
  `tools`), and `replay` (`safe` | `unsafe`), in a shared package
  (`packages/shared/src/pi-tool-effects.ts:1-186`), plus an assembler that refuses a runtime whose
  tools and declarations disagree (`packages/control-plane/src/pi/extension-assembler.ts:79-198`).
- **Why necessary.** Pi is the first harness whose tool set is assembled at runtime from many
  independent extensions. Without a closed registry, a contributed tool could be installed with no
  owner, no caller restriction, or an unclassified effect, and nothing would notice.
- **Single-tenant tension.** Low. The registry is about _tools_, not _people_. The one genuine
  tension is the effect taxonomy itself: `external_mutation` lumps "publish a comment" and "message
  another session" together, which forced the owner-claim mechanism
  (`packages/control-plane/src/pi/extension-assembler.ts:129-143`) rather than a per-effect
  authority.
- **Could it be pushed into core?** It already lives in `packages/shared`, but it is named
  `pi-tool-effects` and consumed only by Pi. Rename it to a harness-neutral `tool-effects` contract
  and let Claude and Codex declare their tools in it. That is a real improvement, not a cosmetic
  one: the caller allow-list and the replay flag are properties that every harness's tools need.
- **Who else needs it.** Claude Agent (whose tools are rendered by the runtime), Codex (whose
  dynamic tools are namespaced), and the MCP client.

### C2 — The session's internal harness-authority seam

- **Primitive.** A set of session-owned internal routes that a harness runtime may call
  (`packages/control-plane/src/session/contracts.ts:110-124`), served by
  `packages/control-plane/src/session/http/handlers/pi-bridge.handler.ts:176` and dispatched to Pi's
  runtime over the `PI_SESSION` namespace
  (`packages/control-plane/src/cloudflare/pi-runtime-dispatch.ts:13`).
- **Why necessary.** The agent must not hold credentials or decide its own authorization. The
  session is the only place that knows the current actor, the team, and the live capability mode.
- **Single-tenant tension.** The seam is session-scoped and identity-bearing: a shared runtime would
  need a per-session principal on every call, and the Pi Durable Object currently has no D1 binding
  at all (`packages/control-plane/src/cloudflare/pi-durable-object.ts:167`) — it identifies itself
  only by which session it was fetched for. A future shared deployment would have to carry a session
  token on these calls.
- **Could it be pushed into core?** Yes, and it should be: the same seam already exists for the
  sandbox (`/internal/*`), so the shape is core; only the Pi-specific route set is new.
- **Who else needs it.** The MCP client inside a harness runtime; any future harness that owns a
  Durable Object.

### C3 — The latched per-session capability snapshot and the live emergency deny

- **Primitive.** A versioned per-session capability matrix stored in D1 and read by the session
  (`packages/shared/src/pi-feature-capabilities.ts`,
  `packages/control-plane/src/pi/capability-authority.ts`,
  `packages/control-plane/src/pi/capability-authority-client.ts`), consulted by the Pi DO at every
  call site (`packages/control-plane/src/cloudflare/pi-durable-object.ts:276-277, 285, 338-346`),
  with a live deployment deny that can be applied without a session restart
  (`packages/control-plane/src/pi/deployment-emergency-policy.ts`).
- **Why necessary.** "Every capability defaults to off and fails closed"
  (`features/pi-first-class/STATE-AND-HANDOVER.md:48`). A latched snapshot gives a session a stable
  answer across restarts; the live deny gives an operator a brake.
- **Single-tenant tension.** The capability matrix is per session, but the live mode is per
  deployment. In a single-tenant deployment the deployment mode _is_ the tenant's mode, so the split
  is invisible; in a multi-tenant deployment the same emergency switch would have to become
  per-tenant, and the D1 read on every call
  (`packages/control-plane/src/cloudflare/pi-durable-object.ts:276-277`) would have to become
  per-tenant-scoped.
- **Could it be pushed into core?** It is already core; the generalization is to drop the `pi`
  prefix from the contract and let every harness have a capability matrix.
- **Who else needs it.** Any capability that must be switchable without a redeploy.

### C4 — The external-action approval ledger and the exactly-once dispatch gateway

- **Primitive.** A durable ledger of effects with states, an approval record with provenance (human
  vs automation grant), a bounded approval TTL, a cancellation path distinct from denial, and a
  lease-based exactly-once dispatch
  (`packages/control-plane/src/session/external-action-gateway.ts:16-26, 714-733`;
  `packages/control-plane/src/routes/session-external-actions.ts`;
  `packages/control-plane/src/session/schema.ts` migration 66;
  `terraform/d1/migrations/0091_external_actions.sql`).
- **Why necessary.** "An MCP mutation never becomes a tool, it becomes an external action that a
  person approves" (`packages/shared/src/pi-tool-effects.ts:119-123`). Publication to GitHub,
  GitLab, Slack or Linear is an effect on the world, and it needs exactly-once semantics plus a
  human or an automation grant.
- **Single-tenant tension.** This is where the deployment model shows: the credential source is the
  _deployment's_, minted per call
  (`packages/control-plane/src/session/external-action-credentials.ts`), and the automation grant is
  bound to an automation that runs as that automation's own executor. In a multi-tenant deployment,
  "the deployment's credential" becomes "the tenant's credential" and the grant hierarchy becomes
  per-tenant.
- **Could it be pushed into core?** It is core. The generalization is to let non-Pi harnesses
  publish too: the gateway is harness-neutral, but the Pi delegation is what exposes it to a model
  (`packages/control-plane/src/pi/external-action-policy-extension.ts`).
- **Who else needs it.** Any harness that can write outside the session — Codex's MCP mutations,
  Claude's computer use.

### C5 — Cross-session messaging authority and durable receipts

- **Primitive.** A source-side authority check (the actor must hold `collaborate` on the target), a
  target-side revalidation, a durable receipt written before the target is called, typed provenance,
  and bounded fan-out and hop depth
  (`packages/control-plane/src/session/cross-session-authority.ts`;
  `packages/control-plane/src/session/http/handlers/cross-session.handler.ts`;
  `terraform/d1/migrations/0094_cross_session_receipts.sql`).
- **Why necessary.** Pi child conversations are subordinate activity inside one session and never
  become separate multiplayer rooms (`features/pi-first-class/STATE-AND-HANDOVER.md:40-42`), but a
  session sometimes must talk to another session. That is a cross-tenant-boundary primitive, so it
  cannot live in the agent.
- **Single-tenant tension.** The design has the source session decide and the target revalidate,
  with no direct Pi-to-Pi hop (`features/pi-first-class/STATE-AND-HANDOVER.md:394-398`). In a
  multi-tenant deployment this primitive is exactly where tenant isolation would be enforced — which
  is why it is core and not Pi-side.
- **Could it be pushed into core?** It is core, and it should stay there.
- **Who else needs it.** Any harness that can address another session.

### C6 — Personal MCP connections, encrypted OAuth storage, grants, pins, reviewed catalog, broker

- **Primitive.** A connection row with a status machine, encrypted OAuth token storage, a
  per-session grant, a catalog snapshot hash, a reviewed read-only tool projection, a live transport
  in a broker Durable Object, and an owner-gated OAuth callback
  (`packages/control-plane/src/db/mcp-connections.ts`,
  `packages/control-plane/src/db/mcp-session-pins.ts`,
  `packages/control-plane/src/mcp/encrypted-oauth-provider.ts`,
  `packages/control-plane/src/db/mcp-server-reviews.ts`,
  `packages/control-plane/src/cloudflare/mcp-connection-durable-object.ts`,
  `packages/control-plane/src/routes/mcp-connections.ts`,
  `packages/control-plane/src/routes/mcp-session-pins.ts`;
  `terraform/d1/migrations/0092_mcp_oauth_foundation.sql`, `0095_mcp_session_pins.sql`).
- **Why necessary.** An OAuth-protected MCP server cannot be reached with a shared static
  credential. The rule that keeps it safe is that "a personal credential never widens the
  deployment's scope" — the session's repositories against the server's `repo_scope` decide
  (`packages/control-plane/src/session/components.ts:736, 816-865`).
- **Single-tenant tension.** **This is the sharpest tension in the whole integration.** The
  repository's own design statement is that "there is no per-user external-service credential
  anywhere in Open-Inspect, because Open-Inspect is single-tenant by design"
  (`features/pi-first-class/STATE-AND-HANDOVER.md:170-172`). Lane 2 introduces exactly that: a
  credential that belongs to one person, held in a deployment that is not multi-tenant. The tension
  is real and unresolved — who is "the owner" in a single-tenant deployment, and what does the
  provider see when a person connects their own account to a shared session?
- **Could it be pushed into core?** It is core. The generalization is a tenancy dimension on the
  connection row (`owner_tenant_id`), which does not exist today and which a multi-tenant deployment
  would need before the second tenant could ever connect an account.
- **Who else needs it.** Claude Agent and Codex reach MCP today through the shared lane only; the
  personal lane is the only path either of them has to a personal OAuth server.

### C7 — The session-bound provider credential broker

- **Primitive.** A broker that mints a short-lived access token for the session's connected provider
  account and hands it to the harness, which holds it in memory only
  (`packages/control-plane/src/session/pi-credential-service.ts`;
  `packages/control-plane/src/pi/codex-credential-store.ts:31-123`; the fetch at
  `packages/control-plane/src/cloudflare/pi-durable-object.ts:1564-1620`).
- **Why necessary.** The agent must never hold a long-lived credential
  (`features/pi-first-class/STATE-AND-HANDOVER.md:22-23`), and a Durable Object that can be
  re-driven by a model must not be able to write its own credential.
- **Single-tenant tension.** The broker binds the credential to the session; the connected account
  belongs to a person. In a multi-tenant deployment the broker becomes the natural tenancy boundary
  — and it already reads as one, because it is a _session_-bound token, not a _deployment_ token.
- **Could it be pushed into core?** It is core, and the store is the harness-neutral part
  (`CredentialStore` from `pi-ai`), so the same broker could serve Claude and Codex.
- **Who else needs it.** Codex already uses a provider-account path
  (`packages/shared/src/harnesses.ts:68-74`).

### C8 — Trusted server-side pricing and the cost cap

- **Primitive.** A server-side pricing catalog with a `requirePricedModel` admission check, and
  per-operation cost accounting with a baseline captured before the turn
  (`packages/control-plane/src/pi/pricing.ts`;
  `packages/control-plane/src/cloudflare/pi-durable-object.ts:1419-1426, 1428-1443`;
  `packages/control-plane/src/session/budget-service.ts`).
- **Why necessary.** The cost cap is a budget control, and a model-chosen model with no trusted
  price would make the cap uncomputable.
- **Single-tenant tension.** The pricing catalog is the deployment's, so a multi-tenant deployment
  would need per-tenant pricing if it ever offered different contracts.
- **Could it be pushed into core?** Yes — the sandbox harness has the same need and currently prices
  differently.
- **Who else needs it.** Every harness with a per-session cost cap.

### C9 — Durable receipts for human control actions

- **Primitive.** A request-id-keyed receipt store with a request fingerprint, so a retried control
  action is delivered once
  (`packages/control-plane/src/session/http/handlers/pi-control.handler.ts:76-101`;
  `packages/control-plane/src/session/pi-control-repository.ts`).
- **Why necessary.** A human pressing "stop" twice, or a Slack retry, must not cancel two different
  things or fork twice.
- **Single-tenant tension.** None beyond the usual: the receipt is scoped to a session.
- **Could it be pushed into core?** It should be — the same primitive is needed for every
  human-initiated mutation of a session, and Pi is currently the only consumer.
- **Who else needs it.** Any harness with an agent-control surface.

### C10 — The sandbox execution isolation boundary and generation fence

- **Primitive.** An execution request that must be authorized by the session, an execution
  `runtime_mode` that is checked before work starts, an `assertExecutionIsolationSupported`
  boundary, and a generation fence (`packages/control-plane/src/session/pi-sandbox-execution.ts`;
  `packages/control-plane/src/session/http/handlers/pi-sandbox-execution.handler.ts`;
  `packages/control-plane/src/sandbox/lifecycle/manager.ts:571+`).
- **Why necessary.** The native execution tools (`run_shell`, `run_build`, `run_tests`) are declared
  `sandbox_execution` (`packages/shared/src/pi-tool-effects.ts:102-116`) and are the only Pi tools
  that run model-authored code on a remote machine.
- **Single-tenant tension.** Every provider is `canary_blocked` until a live isolation canary passes
  (`features/pi-first-class/STATE-AND-HANDOVER.md:161`), so the feature is off in every deployment
  today. That is a property of the deployment, not of the tenant.
- **Could it be pushed into core?** It is core, and it should serve the sandbox harness's own
  execution path too.
- **Who else needs it.** Claude's computer-use and Codex's local execution.

---

## 5. The eighteen hazard checks

Each check states the expectation, the verdict (**PASS** / **FAIL** / **ABSENT**), and the evidence.
`ABSENT` means the hazard does not apply because the surface does not exist.

| #   | Hazard                                                                                   | Verdict                                             | Evidence                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The Pi Durable Object is not client-reachable                                            | **PASS**                                            | `packages/control-plane/src/cloudflare/platform.ts:23`; `packages/control-plane/src/cloudflare/pi-runtime-dispatch.ts:13`; `packages/control-plane/src/cloudflare/pi-durable-object.ts:227` (no `onRequest`); `node_modules/agents/dist/lifecycle-DGorpAmA.js:919-936, 995-1011`                                                                                                            |
| 2   | Every installed tool has an explicit caller allow-list                                   | **PASS**                                            | `packages/shared/src/pi-tool-effects.ts:20-22`; `packages/control-plane/src/pi/tool-policy-extension.ts:53-58`; parity enforced at `packages/control-plane/src/pi/extension-assembler.ts:185-197`                                                                                                                                                                                           |
| 3   | Every nested Code Mode call is authorized individually, and the restriction fails closed | **FAIL**                                            | `packages/control-plane/src/pi/codemode-extension.ts:225-233` returns `undefined` (allow) when the durable parent record is missing → D2                                                                                                                                                                                                                                                    |
| 4   | A replayed run re-authorizes; an approval revoked mid-flight stops the effect            | **PASS**                                            | approvals live in the session's ledger, not in the Pi runtime (`packages/control-plane/src/session/external-action-gateway.ts:714-733`); Pi always goes through prepare → status → execute (`packages/control-plane/src/cloudflare/pi-durable-object.ts:2141-2165`); the execute path re-reads the row. See UNVERIFIED-4 for the narrow mid-flight race                                     |
| 5   | The approval primitive lives in core, not in the harness                                 | **PASS**                                            | `packages/control-plane/src/session/external-action-gateway.ts`; `packages/control-plane/src/routes/session-external-actions.ts`; session migration 66 (`packages/control-plane/src/session/schema.ts`)                                                                                                                                                                                     |
| 6   | Replay-unsafe tools are declared unsafe on purpose                                       | **PASS**                                            | browser `packages/shared/src/pi-tool-effects.ts:137-146`; Code Mode model tools `:78-100`; the assembler refuses a mismatch (`packages/control-plane/src/pi/extension-assembler.ts:191-193`)                                                                                                                                                                                                |
| 7   | Abort signals reach every authority call                                                 | **PASS**                                            | `context.abortSignal` is threaded into the client calls (`packages/control-plane/src/pi/mcp-extension.ts:99`; `packages/control-plane/src/pi/codemode-extension.ts:254`; `packages/control-plane/src/pi/sandbox-execution-extension.ts`) and into the DO's internal fetches (`packages/control-plane/src/cloudflare/pi-durable-object.ts:1564-1620`)                                        |
| 8   | `contextRetentionMs` and `documentRetentionMs` are `0` for Pi                            | **FAIL**                                            | no `settings` passed (`packages/control-plane/src/cloudflare/pi-durable-object.ts:524-531`); defaults are 600 000 ms and the built-in document default (`node_modules/@earendil-works/pi-durable/dist/harness/agent.js:32-33, 50-51`) → D3                                                                                                                                                  |
| 9   | Pi writes durable state through the shared, migration-tracked adapter                    | **FAIL**                                            | raw SQL on `ctx.storage.sql` (`packages/control-plane/src/pi/projection-outbox.ts:73, 88, 257-258`; `packages/control-plane/src/pi/repository-diff-outbox.ts:69, 87, 268`) instead of `packages/control-plane/src/session/sql-storage.ts`'s tracked migrations, and the VFS creates its own tables in the same database (`node_modules/@cloudflare/computer/dist/index.js:95-137`) → D4, D5 |
| 10  | Code Mode runs in a separate Worker, not inside the Pi Durable Object                    | **PASS**                                            | `packages/control-plane/src/cloudflare/pi-durable-object.ts:1392-1403`; `packages/pi-codemode-sandbox/src/index.ts:1`; `terraform/environments/production/workers-control-plane.tf:254-259`                                                                                                                                                                                                 |
| 11  | `env()` is undefined until a harness is authorized                                       | **PASS**                                            | `HarnessOptions.env` is optional and "never called on the Session line" (`node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts:523-525`); Pi passes no `env` (`packages/control-plane/src/cloudflare/pi-durable-object.ts:526-529`), so `api.env` is `undefined` (`:163-164`)                                                                                                    |
| 12  | The extension set is an exact allow-list, never `{remove}`                               | **PASS**                                            | `packages/control-plane/src/pi/open-inspect-extension.ts:311-319` filters the parent's explicit list, with the reason in the comment; the same pattern at `packages/control-plane/src/cloudflare/pi-durable-object.ts:966-970`                                                                                                                                                              |
| 13  | Forking a Pi conversation cannot carry an approval across                                | **PASS**                                            | the fork copies the conversation and its extension list only (`packages/control-plane/src/cloudflare/pi-durable-object.ts:960-981`); approvals live in the session's ledger (`packages/control-plane/src/session/external-action-gateway.ts`), not in the conversation                                                                                                                      |
| 14  | Code Mode's model globals are disabled                                                   | **FAIL**                                            | `packages/control-plane/src/pi/codemode-extension.ts:243` omits `models: false`; upstream default is `true` (`node_modules/@earendil-works/pi-durable/dist/codemode/codemode.d.ts:161-162`) → D1                                                                                                                                                                                            |
| 15  | Telemetry is an adapter into the shared log; the audit trail is a separate store         | **PASS**                                            | spans are published to the structured logger (`packages/control-plane/src/pi/pi-telemetry.ts:148-207`); the session's audit trail is separate (SessionDO/D1); upstream Pi telemetry is not enabled — the published `HarnessOptions` has no telemetry field (`node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts:519-538`)                                                      |
| 16  | Pi does not adopt upstream `tool_search`                                                 | **ABSENT**                                          | no `tool_search` in `packages/shared/src/pi-tool-effects.ts`; upstream ships `createToolSearchExtension` (`node_modules/@earendil-works/pi-durable/dist/tool-search/`); the decision is recorded at `features/pi-first-class/PI-UPSTREAM-PARITY.md:29, 116`                                                                                                                                 |
| 17  | Provider routing is pinned: Pi can only reach `openai-codex`                             | **PASS**                                            | `packages/control-plane/src/pi/runtime-contract.ts:166-172`; `packages/control-plane/src/cloudflare/pi-durable-object.ts:522`; `packages/shared/src/harnesses.ts:75-81, 144-150`                                                                                                                                                                                                            |
| 18  | Delete, archive and export are honoured for Pi                                           | **FAIL** (delete passes, archive and export do not) | delete: `packages/control-plane/src/routes/session-index.ts:469-476` → `packages/control-plane/src/cloudflare/pi-durable-object.ts:1258`; archive: `packages/control-plane/src/session/http/handlers/session-lifecycle.handler.ts:165-176` has no Pi branch; export: `packages/control-plane/src/routes/session-export.ts:376-387` is D1-only → D6                                          |

**Failing hazards: 5** — #3, #8, #9, #14, #18.

---

## 6. Remaining work, dependency-ordered

Each item names what it unblocks. Nothing here is a design; it is the order the work must take.

1. **D1 — disable the Code Mode model surface.** One option and two declaration lines. It is first
   because it is the only **HIGH** item, it is a one-line change, and it removes the exposure that
   D2 depends on. Unblocks: the Code Mode paid canary.
2. **D2 — make the Code Mode nested restriction fail closed.** Three lines in the same delegate.
   Depends on nothing, but is best landed together with (1) so the delegate is exercised once.
3. **D3 — zero the retention settings.** One option object in `Harness.open`. Depends on nothing; it
   changes Pi's memory profile, so it should land before the live canary so the canary measures the
   shipped behaviour.
4. **D5 — move the two outbox tables into the migration registry.** Depends on nothing; it is
   mechanical, and it makes the schema tests cover the Pi tables. Do it before any further Pi
   storage is added.
5. **D6 — decide archive and export for Pi.** This is a product decision, not an implementation
   task: either extend the export with the Pi read surface, or document the omission in the export
   response and add a preservation step to the archive path. Depends on (4) only in that the export
   shape should be settled first.
6. **D4 — separate the VFS from the Pi transcript.** The largest of the (D) items: it needs the VFS
   in its own Durable Object, which means its own binding, its own Terraform, and its own migration.
   Depends on (4) (the storage story should be settled before the VFS moves).
7. **D7 — split `mcp_read` into two tools.** Hardening only; it can land any time after the shared
   lane's live canary proves the scope rule holds.
8. **D8 — separate the agent-lifecycle authority from `collaborate`.** A permission-model change; it
   touches the web client and the Slack path, so it is last.
9. **Open, not (D):** the MCP resources and prompts surface and the MCP elicitation receipt (both
   absent, both analysed in the repository's own audits), the owner's half of the MCP OAuth
   lifecycle (surfacing the authorization URL, refresh, revoke, tombstone), the browser's persistent
   session context, the browser accessibility review, Pi memory tools, and Pi attachments. Each is a
   design before it is an implementation.

---

## 7. What is deliberately absent

These are absences by decision, not gaps. They are listed so that a reader does not read them as
oversights.

| Absent                             | Where the decision is recorded                                                                                                                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi memory tools                    | `packages/shared/src/memory-tools.ts:69-71` ("its authorized memory extension remains future work")                                                                                                                                                             |
| Pi attachments and images          | `packages/control-plane/src/session/message-queue.ts:1332-1333` (explicit refusal)                                                                                                                                                                              |
| Upstream `tool_search`             | `features/pi-first-class/PI-UPSTREAM-PARITY.md:29, 116`                                                                                                                                                                                                         |
| Native execution in any deployment | `features/pi-first-class/STATE-AND-HANDOVER.md:161` (every provider `canary_blocked`)                                                                                                                                                                           |
| MCP resources and prompts          | `features/pi-first-class/PI-MCP-RESOURCES-AUDIT.md`                                                                                                                                                                                                             |
| MCP elicitation                    | `features/pi-first-class/PI-MCP-ELICITATION-AUDIT.md`                                                                                                                                                                                                           |
| "Kitesurf"                         | no occurrence of the string in `packages/`; the browser that exists is the Workers Browser Rendering binding (`packages/control-plane/src/cloudflare/browser-rendering-transport.ts:29-60`), and the persistent `agents` `Browser` capability is not integrated |

---

## 8. Where Pi touches core

Pi's additions to the _core_ (as opposed to the Pi adapter) are the (C) items. Their files:

| Primitive               | Core files                                                                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 tool effects         | `packages/shared/src/pi-tool-effects.ts`                                                                                                                                                                                                         |
| C2 authority seam       | `packages/control-plane/src/session/contracts.ts`, `packages/control-plane/src/session/http/handlers/pi-bridge.handler.ts`                                                                                                                       |
| C3 capabilities         | `packages/shared/src/pi-feature-capabilities.ts`, `packages/control-plane/src/pi/capability-authority.ts`                                                                                                                                        |
| C4 external actions     | `packages/control-plane/src/session/external-action-gateway.ts`, `packages/control-plane/src/routes/session-external-actions.ts`, `packages/control-plane/src/session/external-action-credentials.ts`                                            |
| C5 cross-session        | `packages/control-plane/src/session/cross-session-authority.ts`, `packages/control-plane/src/session/http/handlers/cross-session.handler.ts`                                                                                                     |
| C6 personal MCP         | `packages/control-plane/src/db/mcp-connections.ts`, `db/mcp-session-pins.ts`, `db/mcp-server-reviews.ts`, `packages/control-plane/src/mcp/encrypted-oauth-provider.ts`, `packages/control-plane/src/cloudflare/mcp-connection-durable-object.ts` |
| C7 credential broker    | `packages/control-plane/src/session/pi-credential-service.ts`                                                                                                                                                                                    |
| C8 pricing              | `packages/control-plane/src/pi/pricing.ts`, `packages/control-plane/src/session/budget-service.ts`                                                                                                                                               |
| C9 control receipts     | `packages/control-plane/src/session/pi-control-repository.ts`                                                                                                                                                                                    |
| C10 execution isolation | `packages/control-plane/src/session/pi-sandbox-execution.ts`                                                                                                                                                                                     |

Every one of these is a place where upstream `main` will eventually touch the same file for an
unrelated reason. §11 quantifies that.

---

## 9. UNVERIFIED

Items this audit could not settle from the code. They are not asserted anywhere above.

- **UNVERIFIED-1 — the `sync-upstream` branch.** No branch named `sync-upstream` exists locally or
  on `origin` (`git branch -a --list "*sync*"` is empty; `git ls-remote --heads origin` has no
  matching ref). `origin/main` is `824d6788`, which is exactly the merge base of the Pi branch
  (`git merge-base main HEAD` → `824d6788`), and `git diff --name-only 824d6788..origin/main` is
  empty. §11 is therefore a _file-level conflict-surface analysis_, not a diff against a real
  branch.
- **UNVERIFIED-2 — live MCP behaviour.** No live MCP server canary artifact exists in the
  repository. The code path is verified; the behaviour against a real OAuth server is not.
- **UNVERIFIED-3 — provider canaries for external actions.** The conformance suite exists and "never
  calls a provider" (`features/pi-first-class/STATE-AND-HANDOVER.md:377-378`). Whether a live canary
  has ever been run is not recorded in the repository.
- **UNVERIFIED-4 — the mid-flight revocation race.** The gateway's execute path re-reads the effect
  row, so a revoked approval is observed before dispatch
  (`packages/control-plane/src/session/external-action-gateway.ts`). Whether a revocation that lands
  _between_ that read and the provider write is caught is not established by the code alone; the
  reconciliation-by-marker path is the designed answer
  (`features/pi-first-class/STATE-AND-HANDOVER.md:371-374`) but was not traced to a test.
- **UNVERIFIED-5 — the Code Mode attestation.** The handover claims "observed attestation"
  (`features/pi-first-class/STATE-AND-HANDOVER.md:160`); the mechanism was not traced.
- **UNVERIFIED-6 — D3's cross-actor exposure.** The retention cache is per conversation and the
  scheduler drops it on the documented path
  (`node_modules/@earendil-works/pi-durable/dist/harness/scheduler.js:357-399`). Whether a retained
  context is re-read into the _next actor's_ model request was not traced end to end.
- **UNVERIFIED-7 — the MCP elicitation surface.** Confirmed absent by the absence of any elicitation
  handler in the control plane and by `features/pi-first-class/PI-MCP-ELICITATION-AUDIT.md`; the
  `@modelcontextprotocol/client` v2 surface was not exhaustively enumerated.
- **UNVERIFIED-8 — the browser's accessibility review and the browser journeys.** Not code facts.

---

## 10. Where this audit disagrees with the repository's own documents

1. **`features/pi-first-class/STATE-AND-HANDOVER.md:545`** records "Code Mode's nested-call
   restriction lived only in memory and failed open after an eviction" as _fixed_. It is fixed
   against eviction. The restriction still fails open when the parent record does not match
   (`packages/control-plane/src/pi/codemode-extension.ts:225-233`) — D2.
2. **`features/pi-first-class/PI-REMAINING-AUDIT-BRIEFS.md:46`** states that
   `settings.contextRetentionMs` / `documentRetentionMs` are `0` in Pi. They are not: no `settings`
   is passed at all, so the defaults apply
   (`packages/control-plane/src/cloudflare/pi-durable-object.ts:524-531`) — D3.
3. **`features/pi-first-class/STATE-AND-HANDOVER.md:38-39`** claims Pi collaborators keep the same
   "archive, delete, and export" behaviour. Delete is honoured; archive and export are not — D6.
4. **`features/pi-first-class/STATE-AND-HANDOVER.md:546`** records "The two Code Mode model tools
   were declared but could never be called" as _by design_. They are declared, installed, and
   reachable by the `tools` caller; they are blocked only by a policy delegate that fails open — D1
   and D2.
5. **`features/pi-first-class/STATE-AND-HANDOVER.md:170-172`** states that "there is no per-user
   external-service credential anywhere in Open-Inspect". The personal MCP lane is exactly that: a
   per-person OAuth credential in a single-tenant deployment. The document itself introduces the
   lane (§ "Lane 2 — the personal lane"), so the two statements are in tension, and the tension is
   unresolved rather than answered — C6.
6. **`features/pi-first-class/STATE-AND-HANDOVER.md:508-510`** describes the browser transport as
   not existing and lists its Worker bindings as remaining work, while `:523` says "The transport
   exists". The code has the transport (`packages/control-plane/src/pi/browser-transport.ts`,
   `packages/control-plane/src/cloudflare/browser-rendering-transport.ts`) and the binding
   (`terraform/environments/production/workers-control-plane.tf:78`). The document contradicts
   itself; the code supports the later statement.

---

## 11. Mirror impact: what happens when `origin/main` moves

The upstream remote is `colemurray/background-agents` (`origin`); the user's fork is `fork`
(`par4m/background-agents`). There is no `sync-upstream` ref today (UNVERIFIED-1), and `origin/main`
has not moved since the Pi branch's merge base. The table below is the conflict surface that a
future upstream merge would hit, per (C)/(D) item, and whether the item can be kept behind our
adapter.

"Isolatable" means: upstream's change to the Pi/agents SDK can be absorbed inside
`packages/control-plane/src/pi/**`, `packages/pi-codemode-sandbox/**`, and
`packages/control-plane/src/cloudflare/pi-durable-object.ts`, without changing a core file.

| Item                    | Conflict surface (our files upstream would touch)                                                                                                               | Isolatable           | Note                                                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 tool effects         | `packages/shared/src/pi-tool-effects.ts`, `packages/control-plane/src/pi/extension-assembler.ts`                                                                | **Yes**              | the whole contract sits in `packages/shared`, and the only shared consumer is the Pi assembler; renaming it to a harness-neutral contract later is a rename in one directory |
| C2 authority seam       | `packages/control-plane/src/session/contracts.ts`, `session/http/handlers/pi-bridge.handler.ts`                                                                 | **No** — core        | `contracts.ts` is the shared internal-path registry; upstream changes to it collide directly. The seam's _shape_ is stable, but the file is hot                              |
| C3 capabilities         | `packages/shared/src/pi-feature-capabilities.ts`, `packages/control-plane/src/pi/capability-authority.ts`                                                       | **Yes**              | self-contained in `shared` and `pi/`                                                                                                                                         |
| C4 external actions     | `session/external-action-gateway.ts`, `routes/session-external-actions.ts`, `session/external-action-credentials.ts`                                            | **No** — core        | a large core surface with its own migration; upstream changes to session authorization collide here                                                                          |
| C5 cross-session        | `session/cross-session-authority.ts`, `session/http/handlers/cross-session.handler.ts`                                                                          | **No** — core        | same reasoning; the receipts table is a D1 migration upstream does not know about                                                                                            |
| C6 personal MCP         | `db/mcp-connections.ts`, `db/mcp-session-pins.ts`, `db/mcp-server-reviews.ts`, `mcp/encrypted-oauth-provider.ts`, `cloudflare/mcp-connection-durable-object.ts` | **Partly**           | the broker DO and the OAuth provider are Pi-adjacent and isolatable; the three D1 stores are core and collide with upstream's `db/` work                                     |
| C7 credential broker    | `session/pi-credential-service.ts`                                                                                                                              | **Partly**           | the store (`pi/codex-credential-store.ts`) is isolatable; the service is core                                                                                                |
| C8 pricing              | `pi/pricing.ts`, `session/budget-service.ts`                                                                                                                    | **Partly**           | the catalog is isolatable; the budget service is core                                                                                                                        |
| C9 control receipts     | `session/pi-control-repository.ts`, `session/http/handlers/pi-control.handler.ts`                                                                               | **Partly**           | the repository is Pi-named and isolatable; the handler is core                                                                                                               |
| C10 execution isolation | `session/pi-sandbox-execution.ts`, `session/http/handlers/pi-sandbox-execution.handler.ts`, `sandbox/lifecycle/manager.ts`                                      | **No** — core        | `sandbox/lifecycle/manager.ts` is one of the busiest files upstream touches                                                                                                  |
| D1 Code Mode models     | `packages/control-plane/src/pi/codemode-extension.ts`, `packages/shared/src/pi-tool-effects.ts`                                                                 | **Yes**              | the fix is one option and two declaration lines; upstream's codemode changes land in `node_modules`, not in our files                                                        |
| D2 nested fail-open     | `packages/control-plane/src/pi/codemode-extension.ts`                                                                                                           | **Yes**              | same file as D1                                                                                                                                                              |
| D3 retention            | `packages/control-plane/src/cloudflare/pi-durable-object.ts`                                                                                                    | **Yes**              | one option object                                                                                                                                                            |
| D4 shared SQLite        | `packages/control-plane/src/cloudflare/pi-durable-object.ts`, plus a new binding and Terraform                                                                  | **No** — needs infra | the new Durable Object and its Terraform are the hard part; a conflict with upstream's `terraform/` is likely                                                                |
| D5 untracked tables     | `packages/control-plane/src/pi/projection-outbox.ts`, `packages/control-plane/src/pi/repository-diff-outbox.ts`, `packages/control-plane/src/session/schema.ts` | **Partly**           | the outboxes are isolatable; `schema.ts` is core and hot                                                                                                                     |
| D6 archive/export       | `session/http/handlers/session-lifecycle.handler.ts`, `routes/session-export.ts`                                                                                | **No** — core        | both are core files that upstream changes routinely                                                                                                                          |
| D7 one tool, two lanes  | `packages/control-plane/src/pi/mcp-extension.ts`                                                                                                                | **Yes**              | Pi-side only                                                                                                                                                                 |
| D8 control authority    | `packages/control-plane/src/routes/pi-controls.ts`, `session/http/handlers/pi-control.handler.ts`                                                               | **No** — core        | the web client and Slack path are involved too                                                                                                                               |

**Summary of the mirror impact.** Eight of the ten (C) primitives touch core files that upstream
`main` also changes (C2, C4, C5, C6, C7, C8, C9, C10 — four of them wholly, four partly); only C1
and C3 are wholly inside the shared package and the Pi adapter. Four of the eight (D) items are
isolatable behind the Pi adapter (D1, D2, D3, D7); the other four need core or infrastructure
changes (D4, D5, D6, D8). The two structural risks are:

- **The (C) primitives are core, so they are not protected by the adapter.** C2, C4, C5 and C10 are
  the files upstream is most likely to rewrite. The mitigation is not code organisation but keeping
  the Pi _call sites_ thin, so that when upstream rewrites a core file the Pi change is a small diff
  rather than a redesign.
- **D4 and D6 require core or infrastructure changes**, so they are the two (D) items that an
  upstream merge will make expensive. They should be scheduled against a known-good upstream base,
  not against a moving one.

---

## 12. Human decisions this audit cannot make

1. **Is the Code Mode model surface wanted at all?** D1's fix removes `models.classify` and
   `models.generateImages` from Pi. If image generation or classification is a product requirement,
   the answer is not "delete the declaration" but "give the capability its own gateway" — a larger
   piece of work with its own effect class.
2. **Does a shared MCP lane answer belong in one person's session?** D7 is a hardening proposal; the
   product question is whether the shared lane should be offered to Pi at all, given that its scope
   is the deployment's.
3. **What does "archive" mean for a Pi session?** D6 offers two readings: preserve and export
   everything, or preserve nothing and say so. The second is cheaper and honest; the first is what
   the invariant currently claims.
4. **Who owns a personal MCP connection in a single-tenant deployment?** C6's single-tenant tension
   is not a bug to be fixed in code; it is a statement the deployment has to make, and the answer
   changes whether the personal lane can be enabled by default.
5. **Should agent-lifecycle control (fork, reset, handoff) need its own authority?** D8 is a
   permission-model question with a user-facing consequence.

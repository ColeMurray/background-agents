# Pi memory tools — audit and design

**Feature:** `memory_read`, `memory_write`, `memory_search` for Pi Durable sessions. **Repository
audited:** `/Users/param/.local/share/opencode/worktree/0e6d72/pi-go-live-v2` **Branch / HEAD:**
`feat/pi-go-live-integration-v2` / `a6ab76de98045c74d36dff7b3e8fffb62f02f422` **Method:** read-only.
Every claim below carries `file:line`. The repository's own documents are treated as claims to be
checked, not as evidence. Where the code cannot settle a question, it is on the
[UNVERIFIED list](#vi-unverified-list).

**Organizing principle (the authority spine):** _Pi proposes → the owning SessionDO authorizes → D1
resolves the current user/team/workspace/resource authority → the capability gateway executes → the
result returns through SessionDO audit / timeline / budget → Pi receives only the bounded,
credential-free result._

> **How to read the line numbers.** Sections **(i)–(viii)** are the pre-implementation audit, read
> at commit `a6ab76de`; their `file:line` references point at that commit. Section **(ix)** records
> what was actually built, with `file:line` references at the implementation commit. Where the two
> disagree — because the implementation changed a file the audit cited — **(ix) is the later word**.

---

## (i) What Open-Inspect's memory already is, verified

### The one authority

There is exactly one memory authority in the codebase, and it is **not** in the SessionDO. It is a
framework-neutral service composed **per request** in the control-plane HTTP router:

- `packages/control-plane/src/routes/session-memories.ts:34-42` — `sessionMemoryService(ctx)` builds
  `SessionMemoryService` over four D1-backed dependencies plus a request id.
- `packages/control-plane/src/memory/session-memory-service.ts:33-47` — the dependency contract
  (`selections`, `records`, `factIndex`, `access`, `requestId`).
- `packages/control-plane/src/memory/session-memory-service.ts:54-290` — the service itself:
  `renderedContext` (58-74), `read` (81-126), `write` (134-165), `search` (168-180), `loadSession`
  (182-186), `mayAccessShared` (189-195), `selectRepositories` (198-209), `writeTarget` (211-252),
  `searchPartitions` (255-290).

### The storage (all D1)

| Concern                                                            | Store                         | Location                                                        |
| ------------------------------------------------------------------ | ----------------------------- | --------------------------------------------------------------- |
| Records, revisions, lifecycle, audit                               | `MemoryRecordStore`           | `packages/control-plane/src/db/memory-records.ts:131`           |
| Pinned selection, manifest, pin membership, session-as-memory-view | `SessionMemorySelectionStore` | `packages/control-plane/src/db/session-memory-selections.ts:60` |
| Per-user personal-memory default                                   | `MemoryPreferenceStore`       | `packages/control-plane/src/db/memory-preferences.ts:5`         |
| Lexical fact search                                                | `LexicalFactIndex`            | `packages/control-plane/src/db/lexical-fact-index.ts:50`        |

Tables: `memories`, `memory_revisions`, `memory_preferences`, `session_memory_manifests`,
`session_memory_items` — `terraform/d1/migrations/0084_memories.sql:4,56,74,80,93`. Audit rows go to
the shared `authorization_audit_events` table
(`terraform/d1/migrations/0073_rbac_audit_decision_outcomes.sql:3-38`).

### The identity model

- A memory belongs to a **partition**, not a scope: `{type:"personal"|"repository"|"environment"}` —
  `packages/control-plane/src/memory/partition.ts:13-16`. The partition is the _identity_; the scope
  is _display_ (`packages/control-plane/src/memory/partition.ts:71-89`). Repository partitions are
  keyed by the stable repository id, so a renamed repository keeps its memories
  (`packages/control-plane/src/memory/sources.ts:4-8`).
- A **session** is what memory operations see: `MemorySession` =
  `{id, principal, sources, harness, isChildSession, personalAutoSaveEligible}` —
  `packages/control-plane/src/memory/types.ts:75-90`.
- A **principal** is `{userId, ownerTeamId}` — `packages/control-plane/src/memory/types.ts:69-72`.

### The three entry points today

1. **Agent (sandbox) route** — `packages/control-plane/src/routes/session-memories.ts:98-121`.
   `GET /sessions/:id/sandbox-memory` (rendered boot context),
   `GET /sessions/:id/sandbox-memory/:memoryId` (read), `POST /sessions/:id/sandbox-memory` (write),
   `POST /sessions/:id/sandbox-memory/search` (search). All four are admitted with
   `{...SCM_AGNOSTIC_SANDBOX_ROUTE, authorization: NO_AUTHORIZATION}`
   (`routes/session-memories.ts:98-102`).
2. **Human management route** — `packages/control-plane/src/routes/memories.ts:282-305`: list,
   create, get, revise, revisions, and the four lifecycle actions (approve/reject/archive/restore).
3. **Boot-time materializer (sandbox side)** —
   `packages/sandbox-runtime/src/sandbox_runtime/memories.py:68-101` fetches the rendered context
   with the session's sandbox bearer token; the runtime writes it to `oi-memory.md`
   (`memories.py:121-138`).

### The tool contract (shared)

- `packages/shared/src/memory-tools.ts:23-56` — `MEMORY_TOOL_NAMES` and the three tool definitions
  (description, zod input schema, HTTP method, sandbox path).
- `packages/shared/src/memory-tools.ts:59-77` — `harnessMemoryToolName`; the `pi` case returns the
  canonical names, with the comment _"Pi reserves the canonical names; its authorized memory
  extension remains future work"_ (lines 69-71).
- `packages/shared/src/memory-tools.ts:96-115` — `buildMemorySandboxContract()` derives a
  JSON-Schema contract from the zod schemas via
  `z.toJSONSchema(..., {io:"input", unrepresentable:"any"})`.
- `packages/shared/src/memory-tools.ts:117-131` — the generator writes the contract into the sandbox
  runtime (`memory_contract.json` and `_memory-contract.js`).
- `packages/shared/src/memory-tools.test.ts:13-21` — the staleness test that fails when the
  generated artifacts drift from the source of truth.

### The selection is already pinned for every session, Pi included

`packages/control-plane/src/routes/session-create.ts:325-334` resolves and pins the memory selection
for **every** session at creation, with no harness branch. The manifest is written in the same
atomic batch as the session insert (`packages/control-plane/src/db/session-index.ts:317-319` →
`packages/control-plane/src/db/session-memory-selections.ts:69-111`). Children copy the parent's
selection (`session-memory-selections.ts:113-129`).

> **A Pi session therefore already has a `session_memory_manifests` row and a pinned item set.**
> What Pi lacks is only the _consumption_ surface: the rendered context never reaches Pi's prompt,
> and the three tools are not in Pi's registry.

### What Pi has today

- The Pi session context carries repositories, skills, agent-messaging flag and external actions —
  `packages/control-plane/src/pi/session-context-contract.ts:51-65`, assembled at
  `packages/control-plane/src/session/http/handlers/pi-bridge.handler.ts:238-298`. **It carries no
  memory.**
- Pi's extension slots are
  `policy, core, delegation, agent_messaging, skills, scratch_workspace, repository_editing, code_mode, sandbox_execution, external_actions, mcp, cross_session, browser`
  — `packages/control-plane/src/pi/extension-assembler.ts:16-30`. **There is no memory slot and no
  memory tool.**
- `grep -n "memory|Memory" packages/control-plane/src/pi/*.ts` returns only in-memory test doubles
  (`MemoryStorage`, `createMemoryCodeModeParentRegistry`). **There is no Pi memory path.**

---

## (ii) Answers to questions 1–7

### Q1. What `SessionMemoryService` enforces today, and what is per-principal vs per-session

| #   | Rule                                                                                                                                                                                                                                                                                                                                            | Where enforced                                                                                                                                        | Principal or session?                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Partitions.** A record lives in exactly one partition: personal (by user id), repository (by stable repo id), environment (by env id). Scope names never authorize.                                                                                                                                                                           | `memory/partition.ts:13-16,36-47,49-56`; `memory/sources.ts:10-21`                                                                                    | **Both.** The partition is chosen per principal (the session's owner/team) and pinned per session.                                                                         |
| 2   | **The session's selection.** `read` only returns a fact whose partition is one of the session's source partitions (`sourcePartitions(session.sources)`); a child session sees personal records only if pinned in the selection it inherited.                                                                                                    | `session-memory-service.ts:104-111`; `memory/session-rules.ts:8-11`                                                                                   | **Session.**                                                                                                                                                               |
| 3   | **Shared-memory access policy, rechecked per operation.** `mayAccessShared` is called before _and_ after the search SQL, and before every read and write. It resolves: team active, repository grant coverage, owner not suspended, environment ownership. Personal partitions always pass here.                                                | `session-memory-service.ts:140-141,172,178,189-195`; `authorization/memory-access.ts:305-337,340-368`                                                 | **Principal.** A pinned manifest never freezes access.                                                                                                                     |
| 4   | **Approval for shared writes.** Agent writes to a shared scope become `proposed`, not `active`; only a personal fact from an auto-save-eligible session is created `active`. A directive is always proposed. A human approves through `POST /memories/:id/approve`, which re-authorizes the reviewer against the record's own partition.        | `memory/lifecycle.ts:10-24`; `db/memory-records.ts:269-275`; `routes/memories.ts:188-218,304-305`; `authorization/memory-access.ts:153-155`           | **Both.** The _status_ follows the actor + scope (per-principal); the _approval_ is a per-record human act against the current authority (per-principal at approval time). |
| 5   | **Personal-memory opt-out.** The owner's saved default (`memory_preferences.include_personal_memories`) is read **once**, at session creation, and frozen into the manifest's `personal_owner_user_id`; the service reads the pinned owner, never the current preference. Opted-out sessions have `personalOwnerUserId = null` and see nothing. | `db/memory-preferences.ts:9-15`; `memory/session-memory-selector.ts:43-56`; `db/session-memory-selections.ts:230-285`; `memory/session-rules.ts:8-17` | **Principal at selection time, session thereafter.** A later preference change does not widen a live session.                                                              |
| 6   | **Personal write ownership.** Only the personal owner's own sessions may write to their personal store.                                                                                                                                                                                                                                         | `memory/session-rules.ts:14-17`; `session-memory-service.ts:239-248`                                                                                  | **Both.**                                                                                                                                                                  |
| 7   | **Commit-time revalidation.** The store re-checks, in SQL at insert time: the writing session still exists, is `created`/`active`, its owner is not suspended, it still reaches the target partition; personal auto-save eligibility; and the two per-session quotas.                                                                           | `db/session-memory-write-guard.ts:33-38,44-50,53-61`; `db/memory-records.ts:281-296`                                                                  | **Session.**                                                                                                                                                               |
| 8   | **Concealment.** Inaccessible records are indistinguishable from absent ones (`MemoryNotFoundError`).                                                                                                                                                                                                                                           | `memory/errors.ts:33-40`; `session-memory-service.ts:87-111`                                                                                          | —                                                                                                                                                                          |

**Answer in one line:** the _partitions_, the _shared access_ and the _approval_ are per-principal
and re-evaluated on every operation; the _selection_, the _pinned personal owner_, the _auto-save
eligibility_ and the _quotas_ are per-session and frozen into the session's manifest at creation.

### Q2. Is the Pi Durable Object the same kind of principal as the sandbox? What authenticates it?

**No. They are different kinds of principals with different admission mechanisms.**

**The sandbox** reaches the control-plane router over public HTTP with a bearer credential:

- The route is admitted as a sandbox principal: `SCM_AGNOSTIC_SANDBOX_ROUTE` =
  `{authentication:{kind:"sandbox", credentialClasses:["agent"], ...SESSION_ID_BINDING}}` —
  `packages/control-plane/src/routes/shared.ts:422-425`; the session id comes from the path's `:id`
  segment — `routes/shared.ts:365-367`.
- Admission calls `verifySandboxAuth` —
  `packages/control-plane/src/routing/route-admission.ts:150-195`. It requires
  `Authorization: Bearer <token>`, forwards the token to **the addressed session's own DO** at
  `/internal/verify-sandbox-token` (`route-admission.ts:158-166`), and only then sets
  `ctx.principal = {kind:"sandbox", sessionId, ...credential}` (`route-admission.ts:193`).
- The token is verified against the **session's sandbox row**, hashed, timing-safe compared, and
  lifetime-bounded for the `execution` credential class —
  `packages/control-plane/src/session/http/handlers/sandbox.handler.ts:256-299`;
  `packages/control-plane/src/session/sandbox-access.ts:48-78`.
- `NO_AUTHORIZATION` means _no permission requirement is added on top of that authentication_; it
  does **not** mean the route is unauthenticated —
  `packages/control-plane/src/routes/shared.ts:88-98`.

**The Pi Durable Object** has no such credential:

- It holds the Codex broker credential, not a sandbox token
  (`packages/control-plane/src/cloudflare/pi-durable-object.ts:234-237`).
- It reaches the session over the **Durable Object binding**, addressed by name:
  `this.env.SESSION.getByName(sessionId).fetch(...)` — `pi-durable-object.ts:1782-1793` (MCP read),
  `1814-1820` (MCP list), `1736-1747` (cross-session authorize), `1860-1871` (cross-session
  message), `1891-1899` (sandbox command), `2644-2656` (event projection). Every one of the 20+
  `getByName` call sites in that file follows this shape.
- The DO's name **is** the session id: `env.SESSION.idFromName(sessionId)` —
  `packages/control-plane/src/index.ts:135`.
- The Pi DO learns its session id exactly once, at initialization, and refuses a mismatch:
  `packages/control-plane/src/cloudflare/pi-durable-object.ts:611-652` (`SESSION_ID_KEY` written
  inside a storage transaction; `storedSessionId !== sessionId` → _"Pi Durable Object session
  identity mismatch"_; the same guard in `destroy` at 1214-1221).

**Therefore, if Pi called the sandbox-admitted route (`/sessions/:id/sandbox-memory`), the answer to
"what authenticates it as this session's runtime" would be: _nothing_.** The route's admission
requires a sandbox bearer token verified against a sandbox row; a Pi runtime has neither, and a Pi
session's runtime is not its sandbox (`packages/control-plane/src/session/message-queue.ts:583-591`
dispatches Pi turns to the Pi runtime, never to the sandbox path). Even if a Pi session happened to
own a sandbox row (it can, for code-mode/execution sandboxes), that row's token is the _sandbox's_
credential, not the Pi runtime's — using it would make the Pi DO a holder of a runtime credential,
which is exactly what the spine forbids.

**If Pi must call a NEW internal route, the actual mechanism used by every existing Pi internal
route is this — and it is named precisely:**

> **The Durable Object binding address.** The caller is the holder of the `SESSION` namespace
> binding; the addressee is the DO whose name is the session id; the caller may only address the
> session it was initialized for, because the id is latched in its own storage under an
> identity-mismatch guard. There is **no token, no signature, and no shared secret** on the internal
> route surface.

Supporting evidence that the internal surface itself is unauthenticated:

- `packages/control-plane/src/cloudflare/durable-object.ts:78-84` — `fetch` →
  `runtime.server.onRequest(request)`, no credential check.
- `packages/control-plane/src/session/http/dispatcher.ts:16-27` — match on exact path + method only.
- `packages/control-plane/src/session/http/routes.ts:100-310` — the whole internal route table; no
  authorization wrapper on any entry.
- `packages/control-plane/src/session/http/routes.ts:224-232` — the existing Pi MCP routes
  (`piMcpList`, `piMcpRead`), the exact precedent for a Pi memory route.
- The public router does **not** proxy the Pi-only internal paths, so they are unreachable from
  outside the worker: `packages/control-plane/src/routes/session-runtime-proxy.ts:380-499` proxies
  only an explicit allow-list.

**What the internal routes _do_ add is an activity fence, not an identity fence.** For example:

- `packages/control-plane/src/session/http/handlers/pi-bridge.handler.ts:698-706` —
  `activeOperation()` requires the header `X-Pi-Operation-ID` to match the session's
  currently-processing message or an active control operation, and the session's harness to be `pi`.
- `packages/control-plane/src/session/http/handlers/mcp-session.handler.ts:201-204` — an MCP read
  without an active operation is refused with 409.

A Pi memory route must carry the same fence.

**Summary answer to Q2:** Pi is _not_ the same kind of principal as the sandbox. It must not use the
sandbox-admitted public route. It must use a **new SessionDO internal route**, authenticated by the
**Durable Object binding address** (the same mechanism every existing Pi internal route uses),
fenced by `X-Pi-Operation-ID` + `activeOperation`. **No new auth path is introduced.**

### Q3. The shared contract's argument schemas and result shapes — every field

**`memory_read`** — input `sandboxMemoryReadSchema`
(`packages/shared/src/types/memories.ts:490-492`), strict object:

| Field      | Type   | Constraint                         |
| ---------- | ------ | ---------------------------------- |
| `memoryId` | string | min 1, max 200 (`memories.ts:225`) |

Result `SandboxMemoryReadResult` — discriminated union on `status` (`memories.ts:494-519`):

_Active variant:_ `id` (string), `status` (`"active"`), `memoryType` (`"fact"`), `scope`
(`{type:"personal"}` | `{type:"repository",repoOwner,repoName}` |
`{type:"environment",environmentId}`), `title` (string), `description` (string), `content` (string),
`revisionId` (string), `revisionNumber` (int), `authorKind` (`"user"|"agent"`), `authorUserId`
(string|null), `authorSessionId` (string|null).

_Archived variant:_ `id`, `status` (`"archived"`), `archiveKind`
(`"manual"|"rejected"|"superseded"`), `archivedAt` (number|null), `archiveNote` (string|null). **No
body, no title, no scope.**

**`memory_write`** — input `sandboxMemoryWriteSchema` (`memories.ts:526-536`), strict object:

| Field                | Type                                          | Constraint                                                                                                            |
| -------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `memoryType`         | `"fact" \| "directive"`                       | required                                                                                                              |
| `title`              | string                                        | trimmed, 1..200 (`memories.ts:6-13,200`)                                                                              |
| `description`        | string                                        | trimmed, 10..420 (`memories.ts:201-205`)                                                                              |
| `content`            | string                                        | 1..20 000 chars; UTF-8 bytes ≤ 4× the limit (`memories.ts:206-221`)                                                   |
| `scopeType`          | `"personal" \| "repository" \| "environment"` | **required** (`memories.ts:528-530`)                                                                                  |
| `repoOwner`          | string, optional                              | must be paired with `repoName`; only legal when `scopeType==="repository"` (`memories.ts:429-437`)                    |
| `repoName`           | string, optional                              | same                                                                                                                  |
| `supersedesMemoryId` | string, optional                              | 1..200; must reference an active record in the same partition (`memories.ts:532-534`; `db/memory-records.ts:259-268`) |

Result `SandboxMemoryWriteResult` (`memories.ts:539-542`), strict: `id` (string), `status`
(`"active" | "proposed"`), `revisionId` (string).

**`memory_search`** — input `memorySearchSchema` (`memories.ts:440-456`), strict object:

| Field       | Type                                                    | Constraint                                                                    |
| ----------- | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `query`     | string                                                  | trimmed, 2..256 chars, ≤ 8 whitespace-separated terms (`memories.ts:378-400`) |
| `scopeType` | `"personal" \| "repository" \| "environment"`, optional | omitted = every permitted session scope                                       |
| `repoOwner` | string, optional                                        | paired with `repoName`; only with `scopeType==="repository"`                  |
| `repoName`  | string, optional                                        | same                                                                          |
| `limit`     | int                                                     | 1..20, default 10 (`memories.ts:447-452`; `memories.ts:378-385`)              |

Result `MemorySearchResponse` (`memories.ts:467-473`), strict: `results` — array (max 20) of
`{id, revisionId, scope, title, description}` (`memories.ts:457-466`) — and `hasMore` (boolean).
**Never a body.** Response serialization is bounded at 24 000 chars (`memories.ts:384`;
`memory/fact-search.ts:57-77`).

**`renderedContext`** — `RenderedSessionMemory` (`memories.ts:481-488`): `schemaVersion` (literal
`1`), `manifestSha256` (string), `rendered` (string ≤ 240 000 chars).

**Do the shapes fit a Pi tool?**

- **The result shapes fit verbatim.** They are plain JSON and can be parsed by the same zod schemas
  on the Pi side — exactly the pattern already used for MCP: `mcpReadResultSchema.parse(body)` at
  `packages/control-plane/src/cloudflare/pi-durable-object.ts:1802`.
- **The input shapes fit as data, but not as Pi tool parameters.** Pi's `defineTool` takes a
  **TypeBox** schema (`Type.Object`) — `packages/control-plane/src/pi/mcp-extension.ts:63-75`,
  `packages/control-plane/src/pi/open-inspect-extension.ts:69-78`; `Type` is
  `export { Type } from "typebox"` (`node_modules/@earendil-works/pi-ai/dist/index.d.ts:2`).
- **The `method` and `path` fields of the contract are sandbox-transport facts and are meaningless
  for Pi.** `MEMORY_TOOLS.memory_read.path = "/sandbox-memory/{memoryId}"` with `method:"GET"`
  (`packages/shared/src/memory-tools.ts:35-41`) is the path _inside_ the sandbox runtime's own
  client (`packages/sandbox-runtime/src/sandbox_runtime/harness/memory_tools.py:34-49`), which
  prefixes the session base URL and attaches the bearer token. A Pi tool does not make that HTTP
  call at all.

### Q4. What is shared verbatim, and what must be reproduced in the Pi extension

| Piece                                                           | Verdict                                           | Why / where                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool **names** (`memory_read`, `memory_write`, `memory_search`) | **Shared verbatim**                               | `harnessMemoryToolName("pi", …)` already returns them — `packages/shared/src/memory-tools.ts:69-71`. The rendering already uses them for Pi (`memory/render.ts:18-26`, with `"pi"` in `HARNESS_IDS` — `packages/shared/src/harnesses.ts:29`).                                                                                                                                                                                                               |
| Tool **descriptions**                                           | **Shared verbatim**                               | `MEMORY_TOOLS[name].description` — `packages/shared/src/memory-tools.ts:36-55`. They are already Pi-correct ("the server infers the session environment or sole repository", "Respect the user's personal-memory opt-out").                                                                                                                                                                                                                                 |
| **Result shapes**                                               | **Shared verbatim**                               | `sandboxMemoryReadResultSchema`, `sandboxMemoryWriteResultSchema`, `memorySearchResponseSchema`, `renderedSessionMemorySchema` — `packages/shared/src/types/memories.ts:481-542`. The Pi side parses them with the same zod schemas.                                                                                                                                                                                                                        |
| **Input shape semantics**                                       | **Shared verbatim (as the server-side contract)** | The session-side handler validates the Pi tool's arguments with the _same_ zod schemas (`sandboxMemoryWriteSchema`, `memorySearchSchema`, `sandboxMemoryReadSchema`), so the shared contract stays the single source of truth — the same discipline the sandbox uses (`packages/sandbox-runtime/src/sandbox_runtime/harness/memory_tools.py:36-39` forwards only declared keys).                                                                            |
| **Input shape as Pi tool parameters**                           | **Must be reproduced**                            | Pi's `defineTool` needs a TypeBox `Type.Object`, not a zod schema. The JSON Schema _is_ available verbatim (`buildMemorySandboxContract().tools[i].inputSchema` — `packages/shared/src/memory-tools.ts:98-110`), and TypeBox exposes `Type.Unsafe` (`node_modules/typebox/build/typebox.d.mts:68`), so the schema can be embedded rather than retyped. Whether the Pi/Codex provider path serializes an `Unsafe` schema faithfully is **UNVERIFIED** (§vi). |
| The **effect registration**                                     | **Must be new**                                   | `PI_MEMORY_TOOL_EFFECT_REGISTRATIONS` — the assembler refuses any tool without an effect declaration (`packages/control-plane/src/pi/extension-assembler.ts:185-197`) and refuses an `external_mutation` with no owning delegate (`extension-assembler.ts:129-143`).                                                                                                                                                                                        |
| The **tool implementation**                                     | **Must be new**                                   | The Pi extension: a `MemoryClient` interface + `defineTool` ×3, exactly the shape of `createMcpExtension` — `packages/control-plane/src/pi/mcp-extension.ts:7-121`.                                                                                                                                                                                                                                                                                         |
| The **transport**                                               | **Must be new**                                   | A SessionDO internal route + a Pi-DO client method over `env.SESSION.getByName(sessionId).fetch(...)` — the shape of `piMcpRead` (`packages/control-plane/src/cloudflare/pi-durable-object.ts:1769-1803`).                                                                                                                                                                                                                                                  |
| The **boot context**                                            | **Must be new (the surface only)**                | `renderedContext` already exists and already renders for Pi (`memory/render.ts:59-88` with `session.harness === "pi"`); what is missing is a place to put it in Pi (the session context + an extension section).                                                                                                                                                                                                                                            |

### Q5. Does the memory service depend on the harness's document cache? (answer from the code)

**No. It is purely D1-backed.**

- Every dependency of `SessionMemoryService` is a D1 store: `SessionMemorySelectionStore(ctx.db)`,
  `MemoryRecordStore(ctx.db)`, `LexicalFactIndex(ctx.db)` —
  `packages/control-plane/src/routes/session-memories.ts:34-42`.
- The service never reads a session setting, a harness cache, a file, or a sandbox artifact. Its
  only non-D1 input is `requestId` (`session-memory-service.ts:46`), used as audit provenance.
- The rendered context is produced from D1 rows at call time (`session-memory-service.ts:58-74` →
  `memory/render.ts:59-88`); nothing is cached between calls.
- The _harness_ only affects the **format** of the rendered text
  (`renderMemorySection(..., session.harness)` → `memory/render.ts:59-88`), not the authority, the
  data, or the bounds.

**And the premise of the question is itself wrong in this repository.** `contextRetentionMs` and
`documentRetentionMs` **do not exist anywhere in the codebase** — a grep over `packages/**/*.ts` and
`packages/**/*.md` (outside `features/`) returns no match.
`features/pi-first-class/PI-UPSTREAM-PARITY.md:34` records them as upstream Pi settings that are
**"Not adopted"**, and line 119 explains why. The brief's "are 0 in Pi (per the standing hazard
list)" (`features/pi-first-class/PI-REMAINING-AUDIT-BRIEFS.md:46`) refers to a hazard list that does
not exist in the repository. The answer to the question is unaffected: the service is D1-backed, so
neither setting could matter.

### Q6. Does the memory write path emit anything the session's timeline or audit needs? Is a write a mutation?

**Audit — yes, already.** Every mutation writes an `authorization_audit_events` row inside the same
atomic batch as the write, fenced by the operation claim:

- `packages/control-plane/src/db/memory-records.ts:299-331` — the batch: insert record → insert
  revision → set current revision → **audit** → (optional) supersede predecessor.
- `packages/control-plane/src/db/memory-records.ts:469-492` — the audit statement: `action`
  (`memory.created` / `memory.revised` / `memory.archived` / …), `resource_type = 'memory'`,
  `resource_id = <memory id>`, `principal_kind`, `actor_user_id_snapshot`, `reason_code = action`,
  `operation_result = 'applied'`, and `metadata_json.after = {revisionId, status, sessionId}`. **No
  memory text is ever written to the audit** (the comment at line 468 says so explicitly).
- The audit action vocabulary exists in shared code:
  `packages/shared/src/types/audit-events.ts:78-84`; the principal-kind enum is
  `["user","service","sandbox"]` (`audit-events.ts:25`); the table has **no CHECK** on
  `principal_kind` (`terraform/d1/migrations/0073_rbac_audit_decision_outcomes.sql:7`).

**Timeline — the _tool call_ appears; the _memory record_ does not.**

- For Pi, every tool call is translated into a `tool_call` ingress event and delivered to the
  SessionDO (`packages/control-plane/src/pi/event-translator.ts:326-345`; delivery at
  `packages/control-plane/src/cloudflare/pi-durable-object.ts:2636-2656`), which persists it on the
  session timeline (`packages/control-plane/src/session/http/handlers/pi-event.handler.ts:51` →
  `packages/control-plane/src/session/sandbox-events/processor.ts:174-176` →
  `packages/control-plane/src/session/sandbox-events/streaming.handler.ts:92-104`).
- No _session event_ is emitted by a memory write itself — for Pi or for the sandbox. The durable
  effect is visible only through the audit row and through the memory catalog. **This is parity, not
  a gap:** the sandbox path behaves identically.

**Is a memory write a mutation that belongs in the session's activity?** Yes, and it already is a
mutation in the ledger sense:

- It creates a durable row in `memories` + `memory_revisions` — `db/memory-records.ts:299-320`.
- It is a **mutation of a store that outlives the session and that other sessions read** (the pinned
  selection of any later session can include it — `memory/session-memory-selector.ts:43-57`). That
  is the same class of effect as `message_session` (which writes into another session's inbox and is
  declared `external_mutation` — `packages/shared/src/pi-tool-effects.ts:153-160`).
- Therefore it must be declared as a mutating tool with an owning policy delegate, or the assembler
  will refuse the runtime (`packages/control-plane/src/pi/extension-assembler.ts:95-103,129-143`).

**Budget.** A memory write consumes **no** session budget today — neither for the sandbox nor for
Pi. The Pi spend accounting is a token/cost ledger over the Pi harness's own usage state
(`packages/control-plane/src/pi/accounting.ts:4-48`; wired at
`packages/control-plane/src/cloudflare/pi-durable-object.ts:151-155,708`), and the memory write is a
D1 effect with its own quota (§Q7). The spine's "budget" leg is therefore satisfied by the
_existing_ per-session memory quotas rather than by the session spend budget. No new budget
primitive is needed — but this must be stated explicitly in the design, because "a memory write is a
mutation that belongs in the session's activity" implies the write must be visible somewhere.

### Q7. What is the existing bound on a memory write?

**Per record (bytes / characters)** — `packages/shared/src/types/memories.ts:6-13`, `197-221`:

| Bound                         | Value                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `title`                       | ≤ 200 chars (trimmed, ≥ 1)                                                       |
| `description`                 | 10..420 chars (trimmed)                                                          |
| `content` for a **fact**      | ≤ 20 000 chars, and UTF-8 bytes ≤ 80 000 (`limit * 4`, `memories.ts:209-220`)    |
| `content` for a **directive** | ≤ 2 000 chars, bytes ≤ 8 000 (the same superRefine with the type-specific limit) |
| `archiveNote`                 | ≤ 1 000 chars (management path only)                                             |

**Per session (record counts)** — `packages/shared/src/types/memories.ts:23-27`:
`MEMORY_AGENT_WRITE_QUOTAS = {records: 20, pendingProposals: 5}`, enforced as SQL guards at commit:
`packages/control-plane/src/db/session-memory-write-guard.ts:53-61`, applied at
`packages/control-plane/src/db/memory-records.ts:282-292`. A lost guard surfaces as
`MemoryConflictError("Memory write limit, session access or replacement changed; reload and retry")`
(`memory-records.ts:327-330`).

**Per principal: there is none.** Both quotas count `author_session_id = <sessionId>`
(`session-memory-write-guard.ts:54,59-60`). There is **no per-user, per-team, or per-owner cap** on
the number of memory records or the total bytes a principal may write. (The selection budget
`MEMORY_SELECTION_BUDGET` — 100 directives / 200 catalog records / 240 000 rendered chars —
`memories.ts:15-22` — bounds what a session _pins_, not what is written.)

**Read bounds:** a read returns the whole fact body (≤ 20 000 chars) with no truncation
(`session-memory-service.ts:112-125`); an archived record returns a body-free notice
(`session-memory-service.ts:92-103`). A search returns ≤ 20 summaries, ≤ 24 000 serialized chars
(`memories.ts:378-385`; `memory/fact-search.ts:57-77`).

---

## (iii) The derived design

### The verdict

**Pi's memory tools CAN be a thin adapter over the existing service, with no new table, no new
scope, and no new auth path.** The memory authority, the partitions, the quotas, the lifecycle, the
audit and the D1 backing are all reused **verbatim**. The new surface is entirely Pi-side plus one
transport seam inside the session's own runtime.

Two consequences of the Pi assembler rule out "adapter only", and both are **Pi-side**, not
memory-core:

1. `memory_write` is a mutating tool, so it needs an **effect registration** and an **owning policy
   delegate** (`packages/control-plane/src/pi/extension-assembler.ts:95-103,129-143`).
2. The harness-parity boot context (the rendered memory) needs a **place to live** in Pi, because
   Pi's prompt is assembled from extensions, not from a materialized file.

### The reuse table

| #   | Piece                                              | Exact reuse                                                                                                                                                                                                                                        | New?                              | Bucket |
| --- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------ |
| R1  | The memory authority itself                        | `SessionMemoryService` — `packages/control-plane/src/memory/session-memory-service.ts:54-290`                                                                                                                                                      | No                                | **A**  |
| R2  | Partition resolution                               | `writeTarget` (`session-memory-service.ts:211-252`), `searchPartitions` (255-290), `partition.ts:13-16`                                                                                                                                            | No                                | **A**  |
| R3  | Shared-memory access policy                        | `SessionMemoryAccessPolicy.check` — `packages/control-plane/src/authorization/memory-access.ts:305-337`; factory `memory-access-factory.ts:30-38`                                                                                                  | No                                | **A**  |
| R4  | Personal rules                                     | `memory/session-rules.ts:8-17`                                                                                                                                                                                                                     | No                                | **A**  |
| R5  | Records, revisions, lifecycle, quota guards, audit | `MemoryRecordStore` — `packages/control-plane/src/db/memory-records.ts:131-522`; `db/session-memory-write-guard.ts:33-61`                                                                                                                          | No                                | **A**  |
| R6  | Pinned selection + session-as-memory-view          | `SessionMemorySelectionStore` — `packages/control-plane/src/db/session-memory-selections.ts:60-296`                                                                                                                                                | No                                | **A**  |
| R7  | Lexical search                                     | `LexicalFactIndex` — `packages/control-plane/src/db/lexical-fact-index.ts:50-77`; `memory/fact-search.ts:57-77`                                                                                                                                    | No                                | **A**  |
| R8  | Rendered boot context                              | `renderedContext` — `session-memory-service.ts:58-74`; `memory/render.ts:18-26,59-88` (already renders the canonical Pi tool names)                                                                                                                | No                                | **A**  |
| R9  | Tool names + descriptions                          | `MEMORY_TOOLS` — `packages/shared/src/memory-tools.ts:34-56`; `harnessMemoryToolName` (59-77)                                                                                                                                                      | No                                | **A**  |
| R10 | Result shapes                                      | `packages/shared/src/types/memories.ts:481-542` (parsed on the Pi side, exactly as `mcpReadResultSchema` is parsed at `pi-durable-object.ts:1802`)                                                                                                 | No                                | **A**  |
| R11 | Input semantics (server side)                      | the same zod schemas validate the Pi tool's arguments in the session handler                                                                                                                                                                       | No                                | **A**  |
| R12 | The Pi internal-route transport + admission        | `env.SESSION.getByName(sessionId).fetch(...)` + `X-Pi-Operation-ID` + `activeOperation` — `pi-durable-object.ts:1782-1793`; `pi-bridge.handler.ts:698-706`                                                                                         | No (new path, existing mechanism) | **B**  |
| R13 | The Pi extension shape                             | `createMcpExtension` — `packages/control-plane/src/pi/mcp-extension.ts:7-121`                                                                                                                                                                      | New file, copied shape            | **B**  |
| R14 | The Pi policy delegate shape                       | `createCrossSessionPolicyDelegate` / `createBrowserPolicyDelegate` — `packages/control-plane/src/pi/cross-session-extension.ts`, `pi/browser-policy-extension.ts`; consumed by `createPiToolPolicyExtension` (`pi/tool-policy-extension.ts:48-98`) | New file, copied shape            | **B**  |
| R15 | The effect registration                            | `packages/shared/src/pi-tool-effects.ts:38-70,153-169` (the declaration list)                                                                                                                                                                      | New entries                       | **B**  |
| R16 | The extension slot                                 | `PI_EXTENSION_SLOTS` — `packages/control-plane/src/pi/extension-assembler.ts:16-30`                                                                                                                                                                | New slot `memory` (appended last) | **B**  |
| R17 | The session-side handler                           | the shape of `McpSessionHandler` — `packages/control-plane/src/session/http/handlers/mcp-session.handler.ts:110-441`                                                                                                                               | New file                          | **B**  |
| R18 | The internal route wiring                          | `SessionInternalPaths` (`session/contracts.ts:81-154`), `SessionInternalRouteHandlers` + `createSessionInternalRoutes` (`session/http/routes.ts:22-310`), `components.ts:1502-1596`                                                                | New entries                       | **B**  |
| R19 | The Pi session context (for the boot context)      | `piSessionContextSchema` — `packages/control-plane/src/pi/session-context-contract.ts:51-65`; assembled at `pi-bridge.handler.ts:238-298`                                                                                                          | New optional field                | **B**  |
| R20 | The Pi timeline redaction policy                   | `REDACTED_OUTPUT_TOOLS` / `redactToolArguments` — `packages/control-plane/src/pi/event-translator.ts:347-373`                                                                                                                                      | New entries (a **fix**, see D2)   | **B**  |

### The new surface, precisely

**N1 — Pi tool-effect registrations** (shared): `PI_MEMORY_TOOL_EFFECT_REGISTRATIONS` in
`packages/shared/src/pi-tool-effects.ts`: `memory_read` → `external_read`, `memory_search` →
`external_read`, `memory_write` → `external_mutation`. `memory_write` is `external_mutation` because
it mutates a durable store that outlives the Pi DO and that other sessions read — the same class as
`message_session` (`pi-tool-effects.ts:153-160`).

**N2 — the Pi memory extension** (control plane, Pi side):
`packages/control-plane/src/pi/memory-extension.ts`, shaped like `createMcpExtension`: a
`MemoryClient` interface (`read`, `write`, `search`) and three `defineTool`s whose parameters are
the shared contract's JSON Schema embedded as a TypeBox schema, and whose results are the shared zod
result schemas parsed by the Pi DO.

**N3 — the memory policy delegate** (control plane, Pi side):
`packages/control-plane/src/pi/memory-policy-extension.ts`, shaped like
`createCrossSessionPolicyDelegate`. It **owns `memory_write`** (its name appears in the
contribution's `ownedToolNames`, `extension-assembler.ts:129-143`) and, in `beforeTool`, asks the
owning session whether the _specific_ write is permitted, blocking with the reason when it is not.
It is installed in the `policy` slot's delegate list (`pi-durable-object.ts:348-367`).

**N4 — the SessionDO internal route(s)** (control plane, session side): New entries in
`SessionInternalPaths` (e.g. `piMemoryRead`, `piMemoryWrite`, `piMemorySearch`,
`piMemoryAuthorize`), each wired through `createSessionInternalRoutes` and `components.ts`. The
handler (`packages/control-plane/src/session/http/handlers/pi-memory.handler.ts`) does exactly what
`routes/session-memories.ts:34-95` does, but inside the session's own runtime:

- build `SessionMemoryService` over the **SessionDO's D1 binding** (`db` from
  `packages/control-plane/src/session/platform.ts:52-53`, supplied by
  `packages/control-plane/src/cloudflare/session-platform.ts:22-29`) — the same D1 the router uses;
- require `X-Pi-Operation-ID` and `activeOperation(request)` (409 otherwise), exactly like
  `mcp-session.handler.ts:201-204`;
- derive the session id from **the session itself** (`getPublicSessionId`, `components.ts:1519`),
  never from the request body — the identity rule the service already documents
  (`session-memory-service.ts:49-52`: _"Identity and scope are always derived from the session,
  never from request bodies"_);
- call `service.read/write/search(sessionId, ...)` and translate `MemoryError` to a status
  (`routes/memory-errors.ts:5-16`).

**N5 — the Pi DO client** (control plane, Pi side): Four `fetch` methods over
`env.SESSION.getByName(sessionId)`, each carrying `X-Pi-Operation-ID` and the trace header — the
exact shape of `readMcpTool` (`pi-durable-object.ts:1769-1803`).

**N6 — the boot context**: `renderedContext` is fetched at Pi bootstrap and delivered in the session
context; the Pi extension renders it as a `section(...)` (the lazy section pattern —
`mcp-extension.ts:50-57`). The rendered text already names `memory_read` / `memory_search` for Pi
(`memory/render.ts:18-26`).

**N7 — the timeline redaction fix** (see D2).

### What is explicitly **not** in the design

- No new D1 table, column, index or migration. The Pi path writes to the existing `memories`,
  `memory_revisions` and `authorization_audit_events` tables.
- No new memory scope or partition. The three existing partitions are the only ones.
- No new public route. The Pi memory paths are **not** added to
  `packages/control-plane/src/routes/session-runtime-proxy.ts`, so they are unreachable from outside
  the worker, exactly like `piMcpRead`.
- No new auth path. The Pi DO reaches the session over the DO binding, with the operation fence.
- No Pi-native memory store. Nothing is written to the Pi DO's SQLite.
- No new deployment capability flag _by default_ (see §vii decision 3).

### The answer to "can it be a thin adapter with NO new table, NO new scope, and NO new auth path?"

**Yes — with the two Pi-side additions above (N3's owning delegate and N6's boot context), and with
one Pi-specific fix (N7).** What is missing is _nothing in the memory core_: the service already
enforces the partitions, the selection, the shared-access policy, the approval rule, the personal
opt-out and the quotas; it already writes the audit row; it already renders a Pi-correct boot
context. The Pi path needs a **transport seam and a tool surface**, not a new primitive.

**Bucket verdict for the feature as a whole: B** (a new adapter surface over an unchanged
authority), with sub-buckets A for everything reused, B for N1–N6, and a D-item (D2) for the
timeline redaction that must be fixed as part of the change.

---

## (iv) The authority-spine walk

### A Pi memory **write**

| Step                                                              | What happens                                                                                                                                                                                                                                                                                                                                                                                           | Where                                                                                                                                                                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. **Pi proposes.**                                               | The model calls the Pi tool `memory_write` with `{memoryType, title, description, content, scopeType, repoOwner?, repoName?, supersedesMemoryId?}`. The tool's parameters are the shared contract's schema.                                                                                                                                                                                            | `packages/control-plane/src/pi/memory-extension.ts` (new); contract at `packages/shared/src/memory-tools.ts:42-48` and `packages/shared/src/types/memories.ts:526-536`                                                              |
| 2. **The policy delegate gates the call.**                        | The tool's `beforeTool` hook runs; the memory delegate asks the owning session to authorize _this_ write and blocks with the reason if the session refuses. The delegate owns the tool name, so the assembler installed it.                                                                                                                                                                            | `packages/control-plane/src/pi/memory-policy-extension.ts` (new); ownership rule at `packages/control-plane/src/pi/extension-assembler.ts:129-143`; delegate hook at `packages/control-plane/src/pi/tool-policy-extension.ts:57-79` |
| 3. **The Pi DO calls its own session.**                           | `this.env.SESSION.getByName(sessionId).fetch(new Request("http://session/internal/pi-memory/write", {method:"POST", headers:{"Content-Type":"application/json","X-Pi-Operation-ID":operationId, ...piTraceHeader(operationId)}, body}))`. The session id comes from `this.ctx.storage.get(SESSION_ID_KEY)` — latched at initialization under an identity-mismatch guard.                               | `packages/control-plane/src/cloudflare/pi-durable-object.ts:1778-1793` (pattern), `611-652` (identity guard)                                                                                                                        |
| 4. **The SessionDO admits the request.**                          | The route is dispatched by path+method; the handler requires `X-Pi-Operation-ID` to match the session's processing message or an active control operation, and the session's harness to be `pi`. Otherwise 409.                                                                                                                                                                                        | `packages/control-plane/src/session/http/dispatcher.ts:16-27`; `packages/control-plane/src/session/http/handlers/pi-bridge.handler.ts:698-706`; `session/http/routes.ts:100-310`                                                    |
| 5. **The SessionDO derives the identity from itself.**            | The session id is `getPublicSessionId()` — the session's own row — never a body field.                                                                                                                                                                                                                                                                                                                 | `packages/control-plane/src/session/components.ts:1519`; `packages/control-plane/src/session/public-session-id.ts:11-16`                                                                                                            |
| 6. **D1 resolves the current authority.**                         | `SessionMemoryService.loadSession(sessionId)` reads the D1 `sessions` row and the session's manifest in one batch: `principal = {userId: sessions.user_id, ownerTeamId: sessions.owner_team_id}`, `sources` (repositories by stable repo id, environment id, pinned personal owner), `harness`, `isChildSession`, `personalAutoSaveEligible`.                                                          | `packages/control-plane/src/db/session-memory-selections.ts:230-285`; `packages/control-plane/src/memory/types.ts:69-90`                                                                                                            |
| 7. **The write target is resolved and authorized.**               | `writeTarget` maps the caller-relative `scopeType` to a partition: repository → the session's own repository (multi-repo sessions must name one), environment → the session's environment, personal → the pinned personal owner (and only if the principal _is_ that owner). A personal owner mismatch is refused.                                                                                     | `packages/control-plane/src/memory/session-memory-service.ts:211-252`; `memory/session-rules.ts:14-17`; `memory/sources.ts:4-8`                                                                                                     |
| 8. **The current authority is rechecked.**                        | `mayAccessShared(session, [partition])` → `SessionMemoryAccessPolicy.check`: for a team session the team must be active and its grants must cover the repository; for a workspace session the owner must be unsuspended and hold the grant; the environment must still be owned by the principal's team. Personal partitions always pass here and are governed by the pinned owner instead.            | `session-memory-service.ts:140-141,189-195`; `packages/control-plane/src/authorization/memory-access.ts:305-337,340-368`                                                                                                            |
| 9. **The lifecycle decides active vs proposed.**                  | `initialStatus`: an agent write is `proposed` unless it is a personal **fact**, the session is auto-save-eligible, and it does not replace a directive. A shared write is therefore always a proposal a human approves.                                                                                                                                                                                | `packages/control-plane/src/memory/lifecycle.ts:10-24`                                                                                                                                                                              |
| 10. **The store commits atomically with the commit-time guards.** | One batch: insert the record (guarded), insert the hashed revision, set the current revision, write the audit, and archive the predecessor when the replacement won. The guards re-check: the session still exists and is `created`/`active`, its owner is not suspended, it still reaches the partition, the personal auto-save flag still holds, and both per-session quotas are under their limits. | `packages/control-plane/src/db/memory-records.ts:250-332`; `packages/control-plane/src/db/session-memory-write-guard.ts:33-61`                                                                                                      |
| 11. **The audit is written.**                                     | An `authorization_audit_events` row: `action = "memory.created"`, `resource_type = "memory"`, `resource_id = <memory id>`, `principal_kind`, `actor_user_id_snapshot = session.principal.userId`, `metadata_json.after = {revisionId, status, sessionId}`. **No memory text.**                                                                                                                         | `packages/control-plane/src/db/memory-records.ts:469-492`; table `terraform/d1/migrations/0073_rbac_audit_decision_outcomes.sql:3-38`                                                                                               |
| 12. **The result returns through the SessionDO.**                 | `{id, status: "active"                                                                                                                                                                                                                                                                                                                                                                                 | "proposed", revisionId}`— the shared`sandboxMemoryWriteResultSchema`.                                                                                                                                                               | `packages/control-plane/src/memory/session-memory-service.ts:164`; `packages/shared/src/types/memories.ts:539-542` |
| 13. **Budget.**                                                   | The write consumes no session spend budget; it consumes the **per-session memory quotas** (20 records, 5 pending proposals). This is the existing bound, enforced at step 10.                                                                                                                                                                                                                          | `packages/shared/src/types/memories.ts:23-27`; `db/session-memory-write-guard.ts:53-61`                                                                                                                                             |
| 14. **The timeline.**                                             | The Pi tool call is projected to the session timeline as a `tool_call` event (with the redaction of D2 applied). The memory _record_ is not a timeline event — parity with the sandbox path.                                                                                                                                                                                                           | `packages/control-plane/src/pi/event-translator.ts:326-345`; `pi-durable-object.ts:2636-2656`; `session/sandbox-events/streaming.handler.ts:92-104`                                                                                 |
| 15. **Pi receives only the bounded, credential-free result.**     | The Pi DO parses the body with `sandboxMemoryWriteResultSchema` and returns it as the tool's `structuredOutput`. No credential, no token, no session secret crosses back.                                                                                                                                                                                                                              | `packages/shared/src/types/memories.ts:539-542`; the parse pattern at `packages/control-plane/src/cloudflare/pi-durable-object.ts:1802`                                                                                             |

**Where the actor's identity comes from:** the **session's own D1 row**, never the request body and
never the tool arguments. `session.principal.userId` is `sessions.user_id` and
`session.principal.ownerTeamId` is `sessions.owner_team_id`
(`db/session-memory-selections.ts:234-237,266-267`); the personal owner is the **pinned**
`session_memory_manifests.personal_owner_user_id` (`session-memory-selections.ts:235,269`); the
write's provenance is `{kind:"agent", userId: session.principal.userId, sessionId, requestId}`
(`session-memory-service.ts:154-160`); the _turn_ is the `X-Pi-Operation-ID` fence.

### A Pi memory **read**

| Step                                            | What happens                                                                                                                                                                                       | Where                                                                                |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1. **Pi proposes.**                             | `memory_read({memoryId})` — the shared schema, one field.                                                                                                                                          | `packages/shared/src/types/memories.ts:490-492`                                      |
| 2. **The Pi DO calls its own session.**         | Same transport as the write; a read needs no owning delegate (an `external_read` has no owner requirement — `extension-assembler.ts:137-142`).                                                     | `packages/control-plane/src/cloudflare/pi-durable-object.ts:1769-1803` (pattern)     |
| 3. **The SessionDO admits it.**                 | The operation fence (`X-Pi-Operation-ID` + `activeOperation`).                                                                                                                                     | `pi-bridge.handler.ts:698-706`                                                       |
| 4. **The session is loaded from D1.**           | `loadSession` — the same principal, sources, harness, child flag and auto-save eligibility.                                                                                                        | `db/session-memory-selections.ts:230-285`                                            |
| 5. **The record is loaded.**                    | `records.get(memoryId)` → the live record with its current revision.                                                                                                                               | `packages/control-plane/src/db/memory-records.ts:135-141`                            |
| 6. **Concealment rules apply.**                 | A `proposed` record is not found. A personal record is not found when the session has no personal owner, or when it is a child session and the record is not pinned in the selection it inherited. | `session-memory-service.ts:87-91`; `memory/session-rules.ts:8-11`                    |
| 7. **Archived records get a body-free notice.** | Only if the record is pinned **and** the session may still access the partition; the result is `{id, status:"archived", archiveKind, archivedAt, archiveNote}`.                                    | `session-memory-service.ts:92-103`                                                   |
| 8. **The partition is rechecked.**              | A fact is readable only if its partition is one of the session's source partitions **and** `mayAccessShared` grants it now. Otherwise not found.                                                   | `session-memory-service.ts:104-111`; `authorization/memory-access.ts:305-337`        |
| 9. **The bounded result returns.**              | The active-fact variant: `{id, status:"active", memoryType:"fact", scope, title, description, content, revisionId, revisionNumber, authorKind, authorUserId, authorSessionId}`.                    | `session-memory-service.ts:112-125`; `packages/shared/src/types/memories.ts:494-519` |
| 10. **Audit.**                                  | **A read writes no audit row** — the store's audit is mutation-only (`db/memory-records.ts:299-331`). The read is visible only as a `tool_call` on the timeline.                                   | `db/memory-records.ts:469-492`                                                       |
| 11. **Pi receives it.**                         | Parsed with `sandboxMemoryReadResultSchema`; the body is the model's to read.                                                                                                                      | `packages/shared/src/types/memories.ts:494-519`                                      |

---

## (v) Deviations from the spine

### D1 — The audit labels every agent write as a `sandbox` principal (fidelity, not a hole)

**What the code does.** `MemoryRecordStore.audit` writes
`principal_kind = actor.kind === "agent" ? "sandbox" : "user"`
(`packages/control-plane/src/db/memory-records.ts:482-483`), and the enum is
`["user","service","sandbox"]` (`packages/shared/src/types/audit-events.ts:25`). A Pi Durable write
is not a sandbox write: the Pi runtime is a Durable Object in the same worker
(`packages/control-plane/src/cloudflare/pi-durable-object.ts:227`).

**Why it matters.** The audit trail would attribute a Pi agent's memory write to a sandbox principal
that does not exist. There is no security hole — the row still carries
`actor_user_id_snapshot = session.principal.userId` and `metadata_json.after.sessionId`, so the
write is fully attributable.

**Exploit scenario: none.** (This is a fidelity defect, not a boundary defect. The `principal_kind`
column has no CHECK constraint — `terraform/d1/migrations/0073_rbac_audit_decision_outcomes.sql:7` —
so a new value would need no migration.)

**Recommendation: ACCEPT for this feature; file a separate, small fix.** Adding a harness to
`MemoryActor` (`packages/control-plane/src/memory/types.ts:42-49`) and a fourth principal kind is a
**memory-core change** and therefore out of scope for a Pi adapter. If the team wants the fidelity
now, the cheapest correct fix is: add `"pi"` to `AuditPrincipalKind`
(`packages/shared/src/types/audit-events.ts:25`), and have the _Pi route_ pass a distinct actor.
That requires the core actor type to grow a field, so it is a **C** item — a human decision (§vii,
decision 4).

### D2 — A Pi `memory_read` / `memory_write` would put memory content on the collaborator-visible timeline

**What the code does.** The Pi event translator emits a `tool_call` event with the tool's `args` and
`output` (`packages/control-plane/src/pi/event-translator.ts:326-345`), and it already has a
redaction policy with this exact rationale: _"A read can carry a secret that happened to be in a
file or a provider answer, and the timeline is visible to every collaborator of the session."_
(`event-translator.ts:363-370`). `REDACTED_OUTPUT_TOOLS` currently contains
`write, edit, read, mcp_read, repository_read` (`event-translator.ts:370`), and
`redactToolArguments` redacts `write`/`edit` bodies (`event-translator.ts:347-361`). **`memory_read`
and `memory_write` are not in either set**, so adding the tools without extending the sets would
violate the Pi path's own stated policy.

**Concrete exploit scenario.** User A starts a Pi session on their own repository with personal
memory included (the default — `packages/control-plane/src/db/memory-preferences.ts:14`) and adds
collaborator B to the session. A's personal records are readable by the session:
`personalReadAccess` returns `"all"` for a root session
(`packages/control-plane/src/memory/session-rules.ts:8-11`), and the personal store is owner-only
only against the _management_ surface
(`packages/control-plane/src/authorization/memory-access.ts:229-237`), not against the session. The
agent calls `memory_read` on A's personal record; the Pi translator projects the `tool_call` event
with `output` = the **full personal memory body**; the event is persisted on the session timeline
(`packages/control-plane/src/session/sandbox-events/streaming.handler.ts:92-104`), which B can read.
B thereby obtains personal memory content that the memory authority deliberately keeps out of every
shared surface. The same applies to `memory_write`: the arguments carry the memory body.

**Recommendation: FIX, in this feature.** Add `memory_read` and `memory_write` to
`REDACTED_OUTPUT_TOOLS` (`packages/control-plane/src/pi/event-translator.ts:370`) and redact the
`content` argument of `memory_write` in `redactToolArguments` (`event-translator.ts:347-361`),
mirroring `write`/`edit`. This is a **bucket B** change inside the Pi event translator, with a test.

**Adjacent pre-existing hole (not part of this feature, reported for completeness):** the _sandbox_
path has no equivalent redaction — the sandbox runtime puts the tool's `args` and `output` verbatim
into the `tool_call` event
(`packages/sandbox-runtime/src/sandbox_runtime/harness/opencode_stream.py:822-830`; the schema
carries `output` — `packages/shared/src/types/sandbox-events.ts:146`), and the session-side
processor persists it unchanged
(`packages/control-plane/src/session/sandbox-events/streaming.handler.ts:92-104`). A sandbox
harness's `memory_read` output therefore also lands on the collaborator-visible timeline today. That
is a separate defect on the existing path; the Pi feature must not widen it.

### D3 — The brief's premise about `contextRetentionMs` / `documentRetentionMs` is false in this repository

The brief asserts the settings "are 0 in Pi (per the standing hazard list)"
(`features/pi-first-class/PI-REMAINING-AUDIT-BRIEFS.md:46`). Neither setting exists in the code or
configuration; `features/pi-first-class/PI-UPSTREAM-PARITY.md:34` records both as upstream Pi
settings that are **"Not adopted"**, and line 119 gives the reason. The answer to Q5 is unchanged
(the service is purely D1-backed), but the "hazard list" the brief cites is not in the repository.

### D4 — The repo's documents describe the memory service as living in the SessionDO; it does not

- `features/pi-first-class/SPEC-MAP.md:58` — "Existing SessionDO memory policy through Pi proxy
  tools".
- `features/pi-first-class/MULTIPLAYER-COMPATIBILITY-AUDIT.md:173` — "Existing SessionDO/D1 memory
  service".
- `features/pi-first-class/STATE-AND-HANDOVER.md:260-263` — "The seam: the session's own internal
  routes, exactly like the other Pi routes, calling the same `SessionMemoryService`. The Pi Durable
  Object is the session's runtime, the same identity the sandbox has, so it gets the same access
  policy."

**Verified corrections.** (a) The memory service is **not** in the SessionDO: it is composed per
request in the control-plane router (`packages/control-plane/src/routes/session-memories.ts:34-42`)
and its stores are D1-backed. Moving it behind a SessionDO internal route is _new work_, not an
existing seam. (b) The Pi Durable Object is **not** "the same identity the sandbox has": the sandbox
is admitted by a bearer sandbox token verified against the session's sandbox row
(`packages/control-plane/src/routing/route-admission.ts:150-195`), while the Pi DO is admitted by
the **Durable Object binding address** — a different mechanism with a different (and, on its own,
weaker) authentication. The _access policy_ is shared; the _admission_ is not. (c) There is no "Pi
proxy tool" and no Pi memory surface today (verified in §i).

---

## (vi) UNVERIFIED list

| #                                                                                                        | Claim / question                                                                                                                                                                                                      | Why it could not be settled from the code                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1                                                                                                       | Whether Pi's `defineTool` accepts an embedded raw JSON Schema (`Type.Unsafe`) and the Codex provider path serializes it faithfully to the model.                                                                      | `Type` is TypeBox (`node_modules/@earendil-works/pi-ai/dist/index.d.ts:2`) and TypeBox exports `Unsafe` (`node_modules/typebox/build/typebox.d.mts:68`), but no Pi tool in this repo uses a non-`Type.*` schema, and the provider serialization is not in this repository. Needs a canary.                                 |
| U2                                                                                                       | Whether the Pi provider path accepts a strict schema with `additionalProperties: false` and a `default` value (both present in the shared contract's JSON Schema — `packages/shared/src/memory-tools.test.ts:27-32`). | No Pi tool today uses `additionalProperties:false` or a `default`. Needs a canary against a live model.                                                                                                                                                                                                                    |
| U3                                                                                                       | The runtime behaviour of the Pi `section(...)` mechanism for a large injected block (the rendered memory can be up to 240 000 chars — `packages/shared/src/types/memories.ts:21`).                                    | `section` is an upstream API (`packages/control-plane/src/pi/mcp-extension.ts:50-57`); its size behaviour is not observable here.                                                                                                                                                                                          |
| U4                                                                                                       | Whether a Pi session's collaborators can, in practice, read the session timeline.                                                                                                                                     | The timeline is a session event stream and the collaborators model exists (`packages/control-plane/src/session/components.ts:1466-1479`), but the web client's visibility rule for `tool_call` events was not traced in this audit. The _audit_ for D2 rests on the design intent stated in `event-translator.ts:363-369`. |
| U5                                                                                                       | Whether a Pi session can ever own a sandbox row that would make the sandbox-admitted route _appear_ usable.                                                                                                           | The code shows both that Pi turns never take the sandbox dispatch path                                                                                                                                                                                                                                                     |
| (`packages/control-plane/src/session/message-queue.ts:583-591`) and that the session's archive path      |
| distinguishes "Pi session with no sandbox" from "Pi session with a sandbox"                              |
| (`packages/control-plane/src/session/http/handlers/session-lifecycle.handler.ts:169-171`). The lifecycle |
| that would create such a row was not traced.                                                             |
| U6                                                                                                       | The exact wire shape the OpenAI/Codex provider sends for a Pi tool's `structuredOutput`, and whether a large `content` body survives.                                                                                 | The provider is `@earendil-works/pi-ai/providers/openai-codex` (`pi-durable-object.ts:16`); not in this repository.                                                                                                                                                                                                        |
| U7                                                                                                       | Whether `MEMORY_AGENT_WRITE_QUOTAS` is enforced anywhere else for Pi (e.g. a second write path).                                                                                                                      | The only agent write path found is `MemoryRecordStore.create` (`packages/control-plane/src/db/memory-records.ts:250-332`). A repo-wide search found no other `records.create` caller with an `agent` actor.                                                                                                                |
| U8                                                                                                       | The deployment-level effect of the `principal_kind` enum change proposed in D1 (whether any consumer switches on the literal `"sandbox"`).                                                                            | `packages/shared/src/types/audit-events.ts:25` defines the enum; the consumers of `principal_kind` were not exhaustively traced in this audit.                                                                                                                                                                             |

---

## (vii) Decisions that need a human

1. **Slot: a new `memory` slot, or the existing `core` slot?** `PI_EXTENSION_SLOTS`
   (`packages/control-plane/src/pi/extension-assembler.ts:16-30`) allows one contribution per slot.
   A new `memory` slot (appended last, preserving the existing order) keeps the memory surface
   independently gateable and independently removable. Folding the three tools into the existing
   `core` extension (`packages/control-plane/src/pi/open-inspect-extension.ts:105-140`) is fewer
   moving parts but couples memory to the repository tools' lifetime (the `core` extension is
   dropped for children in the fork filter at `pi-durable-object.ts:966-970`). _Recommendation: a
   new `memory` slot._

2. **Gate the memory tools by a deployment capability flag?** `PI_FEATURE_IDS`
   (`packages/shared/src/pi-feature-capabilities.ts:16-25`) has no `memory` entry. Adding one means
   bumping `PI_FEATURE_CAPABILITY_SNAPSHOT_VERSION` from 4 to 5 and adding a legacy-snapshot branch
   so older sessions keep the feature off (`packages/shared/src/pi-feature-capabilities.ts:38-183`).
   *Recommendation: **no flag for the first cut.** Memory is a read-mostly authority that already
   applies its own per-session quotas and re-checks access per operation; a flag is a
   shared-contract change with a migration-shaped cost. Add it later if the team wants a
   deployment-wide kill switch, and then bump the snapshot version deliberately.

   > **Resolved during implementation — the recommendation was wrong, and the code said so.** The
   > integration lane failed on the existing test *"keeps an all-off creation snapshot after
   >
   > > deployment flags enable before first prompt"*
   > > (`packages/control-plane/test/integration/pi-session-do.test.ts:314-352`): an
   > > always-installed memory surface breaks the invariant that a deployment with every capability
   > > off gets no optional capability. The Pi runtime gates every optional capability through the
   > > capability matrix, so memory became one: `memory` is a `PI_FEATURE_IDS` member
   > > (`packages/shared/src/pi-feature-capabilities.ts:16-26`), the snapshot version moved 4 → 5
   > > (`packages/shared/src/pi-feature-capabilities.ts:39-49`), and `PI_MEMORY_MODE` is the
   > > deployment switch. The cost the audit called "migration-shaped" is the repo's own pattern for
   > > a new capability (the browser feature did exactly this at version 3 → 4).

3. **Who authorizes a `memory_write` — a per-call pre-flight, or the write route alone?** The
   assembler requires an owning delegate for an `external_mutation`
   (`packages/control-plane/src/pi/extension-assembler.ts:129-143`). Two shapes: (a) the delegate
   calls an `authorize` route that resolves the target partition and answers allowed/refused, and
   the write route re-checks (the external-action shape — an extra D1 round trip); (b) the delegate
   is a _capability_ gate ("this session may write memory at all") and the write route is the sole
   per-call authority. *Recommendation: (a). It matches the stated principle — "the owner's policy
   delegate authorizes it" (`extension-assembler.ts:116-128`) — and gives the model a precise
   refusal reason instead of a post-hoc error.

4. **Fix the `principal_kind` fidelity defect (D1) now, or accept it?** *Recommendation: accept for
   this feature; schedule the fix separately. It needs a `MemoryActor` change (a core change) and an
   audit-consumer survey (U8).

5. **Should the Pi boot context be delivered in the session context, or fetched separately at
   bootstrap?** Adding an optional `memory` field to `piSessionContextSchema`
   (`packages/control-plane/src/pi/session-context-contract.ts:51-65`) is one round trip and reuses
   the existing bootstrap fetch (`packages/control-plane/src/cloudflare/pi-durable-object.ts:275`).
   A separate fetch is one more internal route but keeps the context schema stable. _Recommendation:
   the session-context field._

6. **Is a memory write required to appear on the session timeline as its own event (beyond the tool
   call)?** The sandbox path does not emit one (parity). The audit row already records the durable
   effect. _Recommendation: keep parity — no new event kind._

---

## (viii) Sized, dependency-ordered implementation plan

Sizes: **S** ≈ ≤ 100 lines + test; **M** ≈ 100–300 lines + test; **L** ≈ > 300 lines or a
cross-package contract change. The estimate is a rough order of magnitude, not a commitment.

| #   | Step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Size | Depends on | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Effect registrations.** Add `PI_MEMORY_TOOL_EFFECT_REGISTRATIONS` to `packages/shared/src/pi-tool-effects.ts` (3 entries: 2 × `external_read`, 1 × `external_mutation`, `callers:["model"]`, `replay` chosen per tool).                                                                                                                                                                                                                                                                                                 | S    | —          | `createToolEffectRegistry` rejects duplicate names (`pi-tool-effects.ts:172-183`); the names must not collide with `PI_TOOL_EFFECT_REGISTRATIONS` (`pi-tool-effects.ts:38-70`).                                                                                                                                                                                                                                                                                                                      |
| 2   | **Pi contract test.** A test asserting the Pi tools' parameter JSON Schema equals the shared contract's `buildMemorySandboxContract()` input schemas — the Pi analogue of `packages/shared/src/memory-tools.test.ts:13-21`. It fails when the shared contract drifts.                                                                                                                                                                                                                                                     | S    | 1          | This is the "generator test" the brief asks for.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 3   | **Session-side handler.** `packages/control-plane/src/session/http/handlers/pi-memory.handler.ts`: read / write / search / authorize. Compose `SessionMemoryService` over the SessionDO's D1 binding; enforce the operation fence; translate `MemoryError` → status.                                                                                                                                                                                                                                                      | M    | —          | Reuse the composition of `routes/session-memories.ts:34-42` and the error mapping of `routes/memory-errors.ts:5-16`. The service needs a `RequestContext`-shaped object for `createSessionMemoryAccessPolicy` (`authorization/memory-access-factory.ts:30-38`); the minimal object needs `db`, `trace_id`, `request_id`, `metrics`, `executionCtx` (`packages/control-plane/src/http/request-context.ts:27-49`) — all available inside the SessionDO (`platform.ts:52-53`, `components.ts:406-409`). |
| 4   | **Route wiring.** Add the path constants to `SessionInternalPaths` (`session/contracts.ts:81-154`), the handler slots to `SessionInternalRouteHandlers`, the entries to `createSessionInternalRoutes` (`session/http/routes.ts:22-310`), and the wiring in `components.ts:1502-1596`.                                                                                                                                                                                                                                     | S    | 3          | Do **not** add anything to `routes/session-runtime-proxy.ts` — the Pi memory paths must stay unreachable from outside the worker.                                                                                                                                                                                                                                                                                                                                                                    |
| 5   | **Pi extension.** `packages/control-plane/src/pi/memory-extension.ts`: a `MemoryClient` interface and three `defineTool`s, shaped like `packages/control-plane/src/pi/mcp-extension.ts:7-121`. Parse the results with the shared zod schemas.                                                                                                                                                                                                                                                                             | M    | 1, 2       | The result schemas are shared verbatim (`packages/shared/src/types/memories.ts:481-542`).                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6   | **Policy delegate.** `packages/control-plane/src/pi/memory-policy-extension.ts`: a delegate that owns `memory_write` and calls the session's authorize route in `beforeTool`.                                                                                                                                                                                                                                                                                                                                             | M    | 3, 5       | Shaped like `packages/control-plane/src/pi/cross-session-extension.ts`. Must be added to the policy extension's delegate list in `pi-durable-object.ts:348-367`.                                                                                                                                                                                                                                                                                                                                     |
| 7   | **Pi DO client.** Four `fetch` methods over `env.SESSION.getByName(sessionId)` in `packages/control-plane/src/cloudflare/pi-durable-object.ts`, each carrying `X-Pi-Operation-ID` and the trace header; and the bootstrap fetch of the rendered context.                                                                                                                                                                                                                                                                  | M    | 4          | Exactly the shape of `readMcpTool` (`pi-durable-object.ts:1769-1803`). The session id must come from `this.ctx.storage.get(SESSION_ID_KEY)`.                                                                                                                                                                                                                                                                                                                                                         |
| 8   | **Extension assembly.** Add the `memory` slot to `PI_EXTENSION_SLOTS` (`extension-assembler.ts:16-30`), contribute the extension + effects + `ownedToolNames` in `pi-durable-object.ts:308-520`, and install the delegate in the policy slot.                                                                                                                                                                                                                                                                             | S    | 1, 5, 6    | The assembler will refuse the runtime if a mutating tool has no owner (`extension-assembler.ts:129-143`) or if the callers/replay disagree with the declaration (`extension-assembler.ts:185-193`).                                                                                                                                                                                                                                                                                                  |
| 9   | **Boot context.** Add an optional `memory` field to `piSessionContextSchema` (`pi/session-context-contract.ts:51-65`), populate it in `pi-bridge.handler.ts:238-298` from `sessionMemoryService.renderedContext(sessionId)`, and render it as a `section(...)` in the Pi extension.                                                                                                                                                                                                                                       | M    | 3, 5       | The rendered text already names the canonical Pi tool names (`memory/render.ts:18-26`).                                                                                                                                                                                                                                                                                                                                                                                                              |
| 10  | **Timeline redaction (D2, mandatory).** Add `memory_read` and `memory_write` to `REDACTED_OUTPUT_TOOLS` and redact `memory_write`'s `content` argument in `packages/control-plane/src/pi/event-translator.ts:347-373`.                                                                                                                                                                                                                                                                                                    | S    | 1          | With a test asserting the body never reaches the projected event.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 11  | **Tests.** (a) Unit: the extension's parameter schema equals the shared contract's; the delegate blocks a refused write; the handler maps each `MemoryError` kind to its status. (b) Integration (`packages/control-plane/test/integration/`): a Pi-session write produces an `active`/`proposed` record plus an `authorization_audit_events` row with `resource_type='memory'`; a write to another session's partition is refused; a read of an out-of-partition record is not found; the quota refuses the 21st record. | L    | 3–10       | The integration suite runs against real D1 with migrations applied (`packages/control-plane/test/integration/`).                                                                                                                                                                                                                                                                                                                                                                                     |
| 12  | **Docs.** Update `features/pi-first-class/STATE-AND-HANDOVER.md` (§"The four spec features that are still absent"), `SPEC-MAP.md:58`, and `MULTIPLAYER-COMPATIBILITY-AUDIT.md:173` to say that the memory authority is **D1-backed in the router**, now reachable through a SessionDO internal route.                                                                                                                                                                                                                     | S    | 1–11       | The corrections in D4 must land, not just the new capability.                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**Dependency spine:** 1 → 2 → 5 → 8 → 6 → 3 → 4 → 7 → 9, with 10 landing alongside 8 and 11 covering
everything, 12 last.

**Rough total:** 12 steps, ≈ 8–10 focused commits, ≈ 3–5 engineer-days including the integration
tests and the canary from U1/U2. **No D1 migration. No new table. No new scope. No new auth path.**

---

## Where this reading differs from the repository's own documents

1. **`STATE-AND-HANDOVER.md:260-263`** — "The Pi Durable Object is the session's runtime, the same
   identity the sandbox has, so it gets the same access policy." **Not what the code shows.** The
   sandbox is admitted by a bearer sandbox token verified against the session's sandbox row
   (`packages/control-plane/src/routing/route-admission.ts:150-195`;
   `packages/control-plane/src/session/http/handlers/sandbox.handler.ts:256-299`); the Pi Durable
   Object is admitted by the **Durable Object binding address** and has no such credential
   (`packages/control-plane/src/cloudflare/pi-durable-object.ts:1778-1793,611-652`). The _access
   policy_ is shared; the _admission_ is not, and Pi **cannot** use the sandbox-admitted route.
2. **`STATE-AND-HANDOVER.md:260-262` / `SPEC-MAP.md:58` / `MULTIPLAYER-COMPATIBILITY-AUDIT.md:173`**
   — "the session's own internal routes … calling the same `SessionMemoryService`" as if that seam
   already existed. It does not: `SessionMemoryService` is composed **per request in the
   control-plane router** (`packages/control-plane/src/routes/session-memories.ts:34-42`) and is not
   reachable from the SessionDO. Routing it through a new internal route is _new work_.
3. **`PI-REMAINING-AUDIT-BRIEFS.md:46`** — "`settings.contextRetentionMs` / `documentRetentionMs`
   are 0 in Pi (per the standing hazard list)". Neither setting exists in this repository;
   `PI-UPSTREAM-PARITY.md:34` records both as **"Not adopted"**. The Q5 answer is unaffected (the
   service is purely D1-backed), but the cited hazard list does not exist here.
4. **`AUDIT-ROUND-6.md:156`** — "The contract exists for the sandbox harnesses; the Pi surface has
   none." **Verified true**, and the audit agrees: `grep` over `packages/control-plane/src/pi/`
   finds no memory tool, no memory slot, and no memory in the Pi session context.
5. **Any claim that a Pi memory path already exists.** **None does.** There is no Pi memory tool, no
   Pi memory extension, no Pi memory internal route, no memory field in `piSessionContextSchema`,
   and no memory in the Pi Durable Object. The shared contract _reserves_ the canonical names
   (`packages/shared/src/memory-tools.ts:69-71`) — that reservation is the only thing that exists.

---

## (ix) As implemented

**Verdict: bucket B, as designed** — a new adapter surface over an unchanged memory authority. One
core addition (a public pre-flight method on the service), one shared-contract addition (the
`memory` capability), and **no new table, no new scope, and no new auth path**.

### The reuse table, as built

| #   | Piece                                        | Exact reuse                                                                                                                       | New?                                   | Bucket            |
| --- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------- |
| R1  | The memory authority                         | `SessionMemoryService` — `packages/control-plane/src/memory/session-memory-service.ts:60-323`                                     | No                                     | **A**             |
| R2  | Partition resolution                         | `writeTarget` (`session-memory-service.ts:244`), `searchPartitions` (287), `partition.ts:13-16`                                   | No                                     | **A**             |
| R3  | Shared-memory access policy                  | `SessionMemoryAccessPolicy.check` — `authorization/memory-access.ts:305-337`; factory `authorization/memory-access-factory.ts:39` | No                                     | **A**             |
| R4  | Personal rules                               | `memory/session-rules.ts:8-17`                                                                                                    | No                                     | **A**             |
| R5  | Records, revisions, lifecycle, quotas, audit | `db/memory-records.ts:250-332,469-492`; `db/session-memory-write-guard.ts:33-61`                                                  | No                                     | **A**             |
| R6  | Pinned selection                             | `db/session-memory-selections.ts:155-296`                                                                                         | No                                     | **A**             |
| R7  | Lexical search                               | `db/lexical-fact-index.ts:50-77`; `memory/fact-search.ts:57-77`                                                                   | No                                     | **A**             |
| R8  | Rendered boot context                        | `renderedContext` — `session-memory-service.ts:58-74`; `memory/render.ts:59-88`                                                   | No                                     | **A**             |
| R9  | Tool names + descriptions                    | `packages/shared/src/memory-tools.ts:34-77`                                                                                       | No                                     | **A**             |
| R10 | Result shapes                                | `packages/shared/src/types/memories.ts:481-542`, parsed on the Pi side                                                            | No                                     | **A**             |
| R11 | Input semantics (server side)                | the same zod schemas validate the Pi tool's arguments in the session handler                                                      | No                                     | **A**             |
| R12 | Pi internal-route admission                  | the Durable Object binding address + the operation fence                                                                          | No (new path, existing mechanism)      | **B**             |
| R13 | The Pi extension                             | `packages/control-plane/src/pi/memory-extension.ts`                                                                               | New file                               | **B**             |
| R14 | The Pi policy delegate                       | `packages/control-plane/src/pi/memory-policy-extension.ts`                                                                        | New file                               | **B**             |
| R15 | The effect registrations                     | `packages/shared/src/pi-tool-effects.ts:187-224`                                                                                  | New entries                            | **B**             |
| R16 | The extension slot                           | `packages/control-plane/src/pi/extension-assembler.ts:16-31`                                                                      | New slot `memory`                      | **B**             |
| R17 | The session-side handler                     | `packages/control-plane/src/session/http/handlers/pi-memory.handler.ts`                                                           | New file                               | **B**             |
| R18 | The internal route wiring                    | `session/contracts.ts:81-158`, `session/http/routes.ts:70,239`, `session/components.ts:1268`                                      | New entries                            | **B**             |
| R19 | The Pi session context                       | `pi/session-context-contract.ts:51-73`; `pi-bridge.handler.ts:261,733`                                                            | New optional field                     | **B**             |
| R20 | The timeline redaction policy                | `pi/event-translator.ts:347-397`                                                                                                  | New entries (the D2 fix)               | **B**             |
| R21 | The capability gate                          | `packages/shared/src/pi-feature-capabilities.ts` (the `memory` feature, snapshot version 5)                                       | New feature id                         | **B**             |
| R22 | The write pre-flight                         | `SessionMemoryService.authorizeWrite` — `session-memory-service.ts:182`                                                           | **New public method on the authority** | **B** (see below) |
| R23 | The policy's construction context            | `RepositoryGrantContext` — `routes/workspace-repository-authorization.ts:25`                                                      | **Narrowed type**                      | **B** (see below) |

### The three departures from the audit's own design, and why

1. **The capability gate (R21).** The audit recommended _no_ deployment flag; the implementation has
   one, because the existing all-off integration test
   (`test/integration/pi-session-do.test.ts:314-352`) is the repo's guard on "a deployment with
   every capability off gets no optional capability", and an always-installed memory surface broke
   it. The gate is `PI_MEMORY_MODE` (`off` | `read_only` | `enabled`), and `read_only` admits the
   reads alone: the model may consult the tenant's memory and may not change it
   (`packages/control-plane/src/pi/memory-extension.ts:206`).
2. **A public pre-flight on the authority (R22).** The audit's design said the delegate's pre-flight
   would reuse the service's private target resolution. It does — but a private method cannot be
   called from outside, so the service grew one public method, `authorizeWrite(sessionId, input)`
   (`packages/control-plane/src/memory/session-memory-service.ts:182`), which resolves the target
   with the _same_ private `writeTarget` and applies the _same_ `mayAccessShared` the write applies.
   There is still one authority and one answer: the pre-flight cannot disagree with the write, and
   the write re-checks at commit.
3. **A narrowed policy context (R23).** The access policy was composed from an HTTP `RequestContext`
   that the SessionDO does not have. The policy never read more than the global store, the caller's
   own authorization, and a membership cache, so those three are now the declared contract
   (`routes/workspace-repository-authorization.ts:25`) and the SessionDO wires the same policy over
   its own D1 binding (`session/components.ts:1268-1277`). The policy is **not** widened: it still
   resolves the session's principal from D1, exactly as it does for a sandbox request.

### The authority spine, as built

**A write.** Pi's model calls `memory_write` → the tool asks the owning session through the Pi
Durable Object's binding (`pi-durable-object.ts:1898-1994`) → the SessionDO's internal route
`/internal/pi-memory/write` (`session/contracts.ts:128-131`, `session/http/routes.ts:239-255`) → the
handler fences on the live turn (`session/http/handlers/pi-memory.handler.ts:83`,
`pi-operation-fence.ts:23`) → the service loads the session from D1 and derives the principal, the
sources, and the pinned personal owner from the session's own row
(`db/session-memory-selections.ts:230-285`) → the target partition is resolved and the current
access rechecked (`session-memory-service.ts:244,221`) → the store commits atomically with the
commit-time guards and the audit row (`db/memory-records.ts:250-332,469-492`) → the bounded result
returns through the session (`{id, status, revisionId}`) → Pi receives it as the tool's
`structuredOutput` (`pi/memory-extension.ts:206-234`). The **actor's identity** is the session's own
D1 row: `session.principal.userId` is `sessions.user_id` and the personal owner is the **pinned**
`session_memory_manifests.personal_owner_user_id`; the **turn** is the `X-Pi-Operation-ID` fence.

**A read.** The same path, with `service.read` (`session-memory-service.ts:87`): the record is
loaded, the concealment rules apply (a proposed record, an out-of-partition record, and a personal
record outside the session's reach are all "not found"), the partition is rechecked, and the bounded
record returns. A read writes **no** audit row — the store's audit is mutation-only
(`db/memory-records.ts:299-331`).

### The D2 fix, as built

`memory_read`, `memory_search`, and `memory_write` are in the Pi event translator's redaction sets
(`packages/control-plane/src/pi/event-translator.ts:378-397`), and a memory write's body is redacted
from the projected arguments (`event-translator.ts:347-372`). The proof is
`packages/control-plane/src/pi/event-translator.test.ts:231-305`: a memory read's output and a
memory write's body never appear in the serialized timeline event, and the timeline keeps the shape.

### What was **not** done

- No D1 migration, no new table, no new column, no new index.
- No new memory scope or partition.
- No public route. The Pi memory paths are not proxied by
  `packages/control-plane/src/routes/session-runtime-proxy.ts`, so they are unreachable from outside
  the worker, exactly like `piMcpRead`.
- No new auth path. The Pi Durable Object reaches the session over the Durable Object binding; the
  policy is the same D1-backed policy the sandbox path uses.
- No Pi-native memory store. Nothing is written to the Pi Durable Object's SQLite.
- No change to the sandbox's memory path. The sandbox still reaches the service through the
  sandbox-admitted public route.

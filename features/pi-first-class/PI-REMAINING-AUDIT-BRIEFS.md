# The remaining work, as audit briefs

This file holds **questions, not designs**. It exists so that each feature's own audit is sharp and
fast, and so that no design is ever presumed before the code has been read. The answers come from
the code; the designs come from the answers.

The standing rule is in `STATE-AND-HANDOVER.md`: _audit what Open-Inspect already has and how it
works, then design the best way to add the thing, then implement it — one thing at a time._

Each brief below is a **question set for one feature's audit**, to be answered with `file:line`
evidence, and then turned into a design and an implementation. A feature is not started until its
own audit has been read.

---

## 1. Pi memory tools — `memory_read`, `memory_write`, `memory_search`

**Surfaces to read**

- `packages/control-plane/src/memory/session-memory-service.ts` — the whole service:
  `renderedContext`, `read`, `write`, `search`, `mayAccessShared`, `loadSession`.
- `packages/control-plane/src/db/memory-*.ts` — the record store, the selection store, the
  preferences store, the lexical fact index.
- `packages/control-plane/src/routes/session-memories.ts` — how the **sandbox** reaches it, and with
  what admission (`SCM_AGNOSTIC_SANDBOX_ROUTE`, `NO_AUTHORIZATION`).
- `packages/shared/src/memory-tools.ts` — the shared contract, `harnessMemoryToolName`, and the
  generator test that fails when the contract is stale.
- The memory context that the sandbox runtime renders (`docs`/`packages` paths under `src/memory`).

**Questions**

1. What exactly does `SessionMemoryService` enforce today — the partitions, the selection, the
   shared-memory access policy, the approval for shared writes, the personal-memory opt-out? Which
   of those are _per-principal_ and which are _per-session_?
2. The sandbox calls it through a **sandbox-admitted** route with **no authorization**
   (`NO_AUTHORIZATION`), because the sandbox is the session's own runtime. Is the Pi Durable Object
   the same kind of principal? If it calls through the same route, what authenticates it as _this_
   session's runtime rather than another session's?
3. The shared contract already reserves the canonical names for Pi (`harnessMemoryToolName("pi", …)`
   returns `memory_read`/`memory_write`/`memory_search`, with the comment "its authorized memory
   extension remains future work"). Does the contract's _shape_ (the JSON schemas, the method, the
   path) fit a Pi tool, or does the Pi tool need its own argument shape?
4. The sandbox's three tools are rendered by the runtime, not by Open-Inspect. For Pi, the tool must
   live in the Pi registry — so which part of the contract (the argument schema, the result shape)
   has to be reproduced in the Pi extension, and which can be shared verbatim?
5. `settings.contextRetentionMs` / `documentRetentionMs` are 0 in Pi (per the standing hazard list)
   — does the memory _service_ depend on the harness's document cache, or is it purely D1-backed?

**Decision the audit must enable**: whether Pi's memory tools can be a thin adapter over the
existing service with no new primitive (bucket A/B), or whether the Pi path needs something the
service does not have (bucket C, and then the single-tenant question).

**Done when**: a design exists that names the exact reuse, and the implementation adds no new table,
no new scope, and no new auth path — or it says plainly why it must.

---

## 2. Pi attachments and images

**Surfaces to read**

- `packages/control-plane/src/session/message-queue.ts` — where Pi refuses
  (`HarnessModelIncompatibleError("Pi Durable does not support attachments yet.")`), and what the
  sandbox path does instead.
- The attachment authority: the media bucket, the `MEDIA_BUCKET` binding, the bounded media routes
  (`createMediaArtifact`, `recordAttachment`), and the artifact/metadata stores.
- The model-request assembly for a sandbox harness: how an image reaches the provider.

**Questions**

1. What does the sandbox harness do with an attachment, step by step, and which of those steps are
   _Open-Inspect_ (the authority) and which are _harness_ (the transport)?
2. The Pi Durable Object holds the model credential (the Codex broker) — so the image bytes must
   reach the model through the _broker_, not through Pi. Is there an existing path for a harness to
   hand a model an image it fetched itself?
3. What is the existing bound on an attachment (bytes, dimensions, count per turn)? Is it a
   _session_ bound or a _message_ bound?

**Done when**: the design names the existing attachment authority it reuses, the bound it inherits,
and proves the bytes never cross into Pi's storage unencrypted.

---

## 3. MCP resources and prompts

**Surfaces to read**

- `packages/control-plane/src/db/mcp-server-reviews.ts` — the review flow and `mcp_reviewed_tools`.
- `packages/control-plane/src/db/mcp-connections.ts` — the catalog snapshot hash and the reviewed
  read-only projection.
- `terraform/d1/migrations/0092_mcp_oauth_foundation.sql` — the review table's shape.
- The MCP SDK client's `readResource` and prompt surface
  (`node_modules/@modelcontextprotocol/client`).

**Questions**

1. The review table covers **tools only**. What would a _reviewed resource_ be — a name, a URI, a
   mime type, a size bound? Is "read-only" even meaningful for a resource, or is every resource a
   read and the review only needs to record _which_ ones?
2. The catalog snapshot hash covers the reviewed tools. Does adding resources and prompts change the
   snapshot's meaning, and therefore invalidate the existing grants that were made against it? (If
   yes, that is a _migration + re-review_ event, and the audit must say so.)
3. The `mcp_server_revisions`/`mcp_reviewed_tools` model is per **server revision**. Is a resource
   review per server revision too, or per connection?

**Decision the audit must enable**: whether this is a forward-only migration of the review surface
(bucket C, and the single-tenant question is _"who may review a resource for the whole tenant"_), or
whether the resources can be projected from the _tools_' review without a new review kind.

---

## 4. MCP elicitation

**Surfaces to read**

- The MCP SDK's elicitation handler (`agents/mcp/client`, `MCPClientElicitationHandler`).
- Open-Inspect's existing durable-interaction shapes: the external-action approval ledger, the
  pending-action list, the browser approval path, and anything else that waits for a human.

**Questions**

1. What does the SDK's elicitation handler need — a callback per request, a stream, an abort? Does
   it survive the Durable Object being evicted mid-request (the answer decides whether a _durable
   receipt_ is mandatory)?
2. Does Open-Inspect already have a primitive for "a provider waits for a human, durably"? The
   external-action ledger is one candidate. If it is reusable, is an elicitation an external action
   with a different provider, or a different kind of ledger?
3. The review question: is an elicitation a **read** (it can only ask), or can it request an action
   (which would make it a mutation and put it behind the approval ledger)?

**Done when**: the design says whether an existing ledger carries it, and if not, what the new
primitive is and why.

---

## 5. The owner's half of the MCP OAuth lifecycle

**Surfaces to read**

- `packages/control-plane/src/routes/mcp-connections.ts` — the owner's routes.
- `packages/control-plane/src/mcp/connection-saga.ts` — the create/revoke saga.
- `packages/control-plane/src/db/mcp-connections.ts` — the metadata, the statuses, the OAuth
  storage.
- `packages/control-plane/src/cloudflare/mcp-connection-durable-object.ts` — the broker's status and
  the callback.

**Questions**

1. The broker can now produce an authorization URL and receive the callback. What is the _owner's_
   flow today — does the owner ever learn that the connection is waiting for an approval?
2. Refresh: the encrypted OAuth provider stores the token; who refreshes it, and when?
3. Revoke and tombstone: the saga's `revoke` deletes the row and the broker's tokens. Is a _refresh
   token_ left anywhere after a revoke?
4. What does the web client show for a connection that is `foundation_staged` versus one that is
   authorized? Is there a state in the metadata for "waiting for the owner"?

**Done when**: the owner's half is specified end to end, and the states that need to exist are
named.

---

## 6. The browser's session context

**Surfaces to read**

- `packages/control-plane/src/pi/browser-transport.ts` and
  `packages/control-plane/src/cloudflare/browser-rendering-transport.ts` — today's one-shot
  transport.
- The `agents` session-based browser: `agents/dist/browser` — `Browser`, `browserRun`, the
  guardrails, the session store, the live view.
- `packages/control-plane/src/session/http/handlers/browser-gateway.handler.ts` — the authorization
  seam that already exists.

**Questions**

1. The one-shot transport has _stronger_ isolation than a persistent context (no jar at all). What
   does a persistent per-session context actually buy the product — continuity, a logged-in session,
   a live view? Which of those does the product actually need?
2. The `agents` browser is a _Lifecycle capability_ like `PiHarness`, so it would live in the Pi
   Durable Object. Does that put the browser's session record in Pi's SQLite, beside Pi's tables?
   Does the browser's _scope_ then need the SessionDO's authority, the way every other capability
   does?
3. The guardrails are set at launch, per connection. Our SessionDO's gateway already has the
   reviewed host list. Which one is authoritative, and what happens if they disagree?
4. The live view is a **bearer credential for a human**. Where would it live so that it never
   reaches the model context?

**Done when**: the design says whether a persistent context is needed at all, and if it is, where
the browser's authority and its scope come from.

---

## 7. The `agents` 0.29.0 upgrade

Already answered; this is a _change_, not a feature. The audit is short:

1. `agents@0.29.0`'s pi harness returns `output` where `0.28.1` returns `content`; the pi-harness
   exports, the MCP-client exports, and the Lifecycle API are identical.
2. The only peer change is the narrowing of `@earendil-works/pi-ai` and `pi-durable` from `^1.0.0`
   to `~1.3.0`, which Open-Inspect's exact 1.3.0 pins already satisfy. The MCP peers
   (`@modelcontextprotocol/sdk@1.32.1`, `client@2.3.1`, `server@2.3.1`) are **identical in both
   versions** and already resolved, so **no peer is added** and the worker's MCP resolution does not
   change. npm's resolver crash ("Cannot read properties of null (reading 'edgesOut')") is an npm 10
   defect, not a peer conflict: it reproduces with `agents` still at 0.28.1 when only the two Pi
   peer ranges are narrowed, and it does not occur on the repository's declared node version (24).
   `--legacy-peer-deps` is **not** the fix and must not be used — it drops the auto-installed MCP
   peers the worker bundle needs to resolve.
3. It lets `adaptLegacyToolOutput` in `packages/control-plane/src/pi/managed-skills-extension.ts` be
   deleted, together with its rename guard `hasLegacyContent`.

**Done when**: the bump is its own commit, the bundle check passes, and the shim is gone.

**Done.** Taken in `feat/pi-agents-upgrade`; the audit, the evidence, and the UNVERIFIED list are in
`features/pi-first-class/PI-AGENTS-UPGRADE-AUDIT.md`.

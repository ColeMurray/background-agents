# MCP elicitation — audit

**Branch:** `feat/pi-mcp-elicitation` (worktree `pi-mcp-elicitation`, based on
`feat/pi-go-live-integration-v2`) **Brief:** `features/pi-first-class/PI-REMAINING-AUDIT-BRIEFS.md`
§4 "MCP elicitation" **Outcome in one line:** an elicitation is a **READ**, not a mutation, so it
does **not** belong behind the external-action approval ledger — but answering one durably needs a
**new primitive** (a durable interaction receipt plus a way for a human to answer), so this feature
is **bucket C** and is reported here as a product decision rather than implemented.

Everything below was read from the code in this worktree and from the installed SDKs. The
repository's own documents are quoted only where this audit **disagrees** with them (§9).

---

## 0. What was read

| Surface                              | Where                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The brief                            | `features/pi-first-class/PI-REMAINING-AUDIT-BRIEFS.md:112-132`                                                                                                                                                                                                                                                                                                                                                              |
| The Agents SDK MCP client            | `node_modules/agents@0.28.1` (`dist/client-BnYbNT3z.js`, `dist/agent-routing-BMvWTFEp.d.ts`)                                                                                                                                                                                                                                                                                                                                |
| The MCP client SDK (v2)              | `node_modules/@modelcontextprotocol/client@2.3.1` (`dist/index.mjs`, `dist/src-WCy6ifGf.mjs`, `dist/index.d.mts`, `dist/index-B-4n9P0J.d.mts`)                                                                                                                                                                                                                                                                              |
| The MCP core constants               | `node_modules/@modelcontextprotocol/core` (`dist/auth-BNDyLTqp.mjs`)                                                                                                                                                                                                                                                                                                                                                        |
| The MCP spec                         | `modelcontextprotocol.io/specification/2025-06-18/client/elicitation` and `…/2025-11-25/client/elicitation`                                                                                                                                                                                                                                                                                                                 |
| The private MCP lane                 | `packages/control-plane/src/cloudflare/mcp-connection-durable-object.ts`, `packages/control-plane/src/mcp/broker-contract.ts`                                                                                                                                                                                                                                                                                               |
| The shared MCP lane                  | `packages/control-plane/src/session/mcp-shared-client.ts`, `packages/control-plane/src/db/mcp-servers.ts`                                                                                                                                                                                                                                                                                                                   |
| The MCP read gateway                 | `packages/control-plane/src/session/http/handlers/mcp-session.handler.ts`, `packages/control-plane/src/session/components.ts:729-888`                                                                                                                                                                                                                                                                                       |
| The Pi surface                       | `packages/control-plane/src/pi/mcp-extension.ts`, `packages/control-plane/src/cloudflare/pi-durable-object.ts:1763-1838`                                                                                                                                                                                                                                                                                                    |
| The durable human-interaction shapes | `packages/control-plane/src/session/external-action-gateway.ts`, `packages/control-plane/src/session/schema.ts:73-142`, `packages/control-plane/src/session/http/handlers/pi-bridge.handler.ts:484-662`, `packages/control-plane/src/routes/session-external-actions.ts`, `packages/web/src/components/sidebar/external-actions-section.tsx`, `packages/control-plane/src/session/http/handlers/browser-gateway.handler.ts` |

---

## 1. The brief's question 1 — what does the SDK's elicitation handler need?

### 1.1 Its shape: one callback per request, with an abort, returning the whole result

`MCPClientElicitationHandler` is a single async callback per request:

- `node_modules/agents/dist/agent-routing-BMvWTFEp.d.ts:2743-2748` —
  `type MCPClientElicitationHandler = (request: ElicitRequest, serverId: string, signal?: AbortSignal) => Promise<ElicitResult>`
- `node_modules/agents/dist/agent-routing-BMvWTFEp.d.ts:2749-2752` — the handlers bag is keyed by
  **mode**: `{ form?: handler, url?: handler }`.
- `node_modules/agents/dist/client-BnYbNT3z.js:851-859` — the connection dispatches to
  `this.options.elicitationHandlers?.[mode]` and races the handler's promise against the abort
  signal. If no handler is registered for the mode it **throws**; it does not hang.

So the answer to "callback per request, a stream, or an abort?" is: **a callback per request, plus
an abort signal**. There is no stream and no subscription. The handler returns the complete
`ElicitResult` (`action: accept | decline | cancel`, optional `content`) — the MCP result schema is
`node_modules/@modelcontextprotocol/client/dist/index-B-4n9P0J.d.mts` (`ElicitResultSchema`,
`@modelcontextprotocol/sdk@1.32.1/dist/esm/types.d.ts:5381+`).

**There is no timeout on the client side.** The only bound is the caller's: the MCP request timeout
(`@modelcontextprotocol/sdk@1.32.1/dist/esm/shared/protocol.d.ts:74-89` — `timeout`,
`resetTimeoutOnProgress`, `maxTotalTimeout`) and the abort signal.

### 1.2 A trap in the SDK's own signature (worth knowing before any implementation)

The declared type says the second positional argument is `serverId`. The **connection-level** call
site does not pass it:

- `node_modules/agents/dist/client-BnYbNT3z.js:855` — `handler(request, signal)`; the second
  argument is the **AbortSignal**, not the server id.
- `node_modules/agents/dist/client-BnYbNT3z.js:1341-1350` —
  `MCPClientManager.scopedElicitationHandlers(serverId)` wraps the manager-level handler so that
  _it_ receives `(request, serverId, signal)`.

Consequence: the typed `(request, serverId, signal?)` shape only holds when the handler is
registered through `MCPClientManager.configureElicitationHandlers`
(`dist/client-BnYbNT3z.js:2203-2207`). The private lane uses the manager; the shared lane does not
use the Agents SDK at all (§3.2). Any implementation must not rely on argument 2 being a server id.

### 1.3 Registering a handler changes what Open-Inspect tells the server

- `node_modules/agents/dist/client-BnYbNT3z.js:153-161` — `elicitationCapabilitiesFromHandlers`
  turns registered handlers into an advertised capability (`{form:{}}` / `{url:{}}`).
- `node_modules/agents/dist/client-BnYbNT3z.js:185-199` — `createMcpSdkClient` puts it on the wire.
- `node_modules/agents/dist/client-BnYbNT3z.js:2218-2231` — `persistAdvertisedCapabilities` **writes
  the advertised capability set into every stored server row**, so configuring handlers changes the
  persisted registration of every connection the broker holds.
- `node_modules/@modelcontextprotocol/client/dist/index.mjs:3601-3605` — the v2 client refuses to
  register an `elicitation/create` handler at all unless the capability was declared:
  `Client does not support elicitation capability (required for elicitation/create)`.

So "supporting elicitation" is not a local code change: it **advertises a new capability to every
MCP server Open-Inspect talks to**, and it persists that advertisement. The MCP spec is explicit
that a client declaring the capability must actually support the mode
(`2025-11-25/client/elicitation`: "Clients declaring the `elicitation` capability **MUST** support
at least one mode").

### 1.4 Does it survive the Durable Object being evicted mid-request? **No.**

The pending promise lives only in the DO's memory; there is no receipt, no outbox, no replay. Two
independent facts make this decisive rather than theoretical:

1. **The call budget is far shorter than a human.** The private lane bounds a tool call at 30 s
   (`packages/control-plane/src/cloudflare/mcp-connection-durable-object.ts:16`
   `MCP_TOOL_TIMEOUT_MS = 30_000`, applied at `:217`), and the shared lane does the same
   (`packages/control-plane/src/session/mcp-shared-client.ts:28`
   `MCP_SHARED_CALL_TIMEOUT_MS = 30_000`, applied at `:52` via `AbortSignal.timeout(timeoutMs)` and
   `:55` via `client.callTool(..., { signal: deadline })`). A human answering a form does not answer
   inside 30 seconds, so **the in-flight wait cannot succeed even if the DO never restarts**. The
   MCP protocol's own default request timeout is 60 s — in the v1 SDK
   (`@modelcontextprotocol/sdk@1.32.1/dist/esm/shared/protocol.d.ts:57`) and in the v2 client the
   lanes actually use (`DEFAULT_REQUEST_TIMEOUT_MSEC`, read from
   `node_modules/@modelcontextprotocol/client` at runtime).
2. **Nothing persists the pending question.** There is no table, no row, no outbox for "a provider
   is waiting for a human". If the DO is evicted, the promise is gone and the provider's request
   dies with it.

**Therefore a durable receipt is mandatory** — but the receipt alone is not sufficient. The receipt
has to be paired with a _different time regime_ for the read (§5).

### 1.5 A newer protocol shape that changes the design (2026-07-28 era)

**Both lanes use the v2 client.** The shared lane imports it directly
(`packages/control-plane/src/session/mcp-shared-client.ts:1-2`), and so does the Agents SDK's own
MCP client (`node_modules/agents/dist/client-BnYbNT3z.js:9` imports `Client` from
`@modelcontextprotocol/client`; `agents@0.28.1` depends on both `@modelcontextprotocol/client@2.3.1`
and `@modelcontextprotocol/sdk@1.32.1`, and the client it builds on is the v2 one).

The v2 client supports the 2026-07-28 multi-round-trip (MRTR) protocol:

- `node_modules/@modelcontextprotocol/client/dist/index.d.mts:1941-1965` — on the 2026-07-28 era a
  server obtains client input by answering `tools/call` with an `input_required` result instead of
  sending a server→client request; the client then fulfils the embedded requests through the **same
  `setRequestHandler` handlers** and **retries the original call** with the collected
  `inputResponses` and a byte-exact echo of the opaque `requestState`, up to `maxRounds` (default
  10).
- `node_modules/@modelcontextprotocol/client/dist/index.d.mts:1327-1350` — `autoFulfill: false`
  switches to manual mode, where `input_required` surfaces as a typed error unless the call opts in
  with `allowInputRequired: true`.
- `node_modules/@modelcontextprotocol/client/dist/index-B-4n9P0J.d.mts:705-711` — the
  `input_required` result carries `inputRequests` (keyed by **server-assigned ids**) and an opaque
  `requestState` that the client echoes back verbatim.

This is important because in the MRTR shape **the provider does not block**: `tools/call` returns
promptly with `input_required`, the client answers, and the client retries. That is the shape that
makes an out-of-band human answer possible at all — the human's latency is not inside the provider's
open request.

**But the MRTR era is not reachable today.** `versionNegotiation` is opt-in
(`node_modules/@modelcontextprotocol/client/dist/index.d.mts:1859-1874`, default `'legacy'`), and
Open-Inspect's shared-lane client is constructed with no options at all
(`packages/control-plane/src/session/mcp-shared-client.ts:48`). The negotiated era therefore tops
out at 2025-11-25 (`node_modules/@modelcontextprotocol/core/dist/auth-BNDyLTqp.mjs:4-11`:
`LATEST_PROTOCOL_VERSION = "2025-11-25"`, `DEFAULT_NEGOTIATED_PROTOCOL_VERSION = "2025-03-26"`). In
the 2025 era, elicitation is the classic blocking server→client `elicitation/create` request — the
shape that §1.4 shows cannot work inside a 30-second budget.

**Audit answer to Q1:** the handler is a per-request callback with an abort and no timeout of its
own. It does not survive eviction, and — more fundamentally — it cannot survive the 30-second read
budget that Open-Inspect imposes on every MCP call. A durable receipt is mandatory; the receipt must
be paired with either the MRTR era (out-of-band answer + retry) or a raised read budget.

---

## 2. The brief's question 2 — does Open-Inspect already have "a provider waits for a human, durably"?

### 2.1 The inventory of durable human-interaction shapes

| #   | Primitive                                              | Where                                                                                                                                                                           | Scope                                                                                 | What it is for                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **External-action approval ledger**                    | `packages/control-plane/src/session/external-action-gateway.ts:185`, tables at `packages/control-plane/src/session/schema.ts:73-142`                                            | **SessionDO SQLite, session-scoped** (`session_id` column; every query filters on it) | A durable ledger of _outward effects_ awaiting a human's approval, with leases, reconciliation, history, and an audit outbox                                                                                                                                                                 |
| 2   | **External-action pending list + decision route + UI** | `pi-bridge.handler.ts:584-598` (list), `:600-662` (decision), `routes/session-external-actions.ts:72-96`, `packages/web/src/components/sidebar/external-actions-section.tsx:25` | session + RBAC                                                                        | The human-facing surface of (1)                                                                                                                                                                                                                                                              |
| 3   | **Browser gateway**                                    | `packages/control-plane/src/session/http/handlers/browser-gateway.handler.ts:65`                                                                                                | session                                                                               | An _authorization_ gate for agent-driven browser work. It has **no** human approval path: sensitive actions (login, upload, download) are **refused by name** (`:103-115`, `browser_action_needs_approval`), and the host allowlist is a reviewed list (`:148-154`, `hostMatches` at `:217`) |
| 4   | **Cross-session receipt**                              | `packages/control-plane/src/db/cross-session-receipts.ts:59`                                                                                                                    | **D1, tenant-wide storage, session-scoped rows**                                      | An idempotency/provenance receipt for a message from one session to another — a machine-to-machine receipt, not a human question                                                                                                                                                             |
| 5   | **Pi control receipt**                                 | `packages/control-plane/src/session/pi-control-repository.ts:17`                                                                                                                | SessionDO SQLite                                                                      | The durable receipt of a _Pi harness control command_ (`submit`/`send`/`steer`/…) and its result. Machine-driven, not a human question                                                                                                                                                       |
| 6   | **Pi result receipt**                                  | `packages/control-plane/src/session/pi-result-receipt-repository.ts:5`                                                                                                          | SessionDO SQLite                                                                      | Idempotency for result projection                                                                                                                                                                                                                                                            |
| 7   | **MCP read audit**                                     | `packages/control-plane/src/db/mcp-read-audit.ts:23`                                                                                                                            | D1                                                                                    | A workspace audit record of one reviewed MCP read: who, which session, which tool, outcome, reason code. It **never records arguments or results** (`:20-22`)                                                                                                                                |
| 8   | **Sandbox harness**                                    | `packages/sandbox-runtime/src/sandbox_runtime/harness/claude.py:88` — `DISALLOWED_TOOLS = ("AskUserQuestion",)`                                                                 | sandbox                                                                               | The sandbox harness **refuses the agent's own "ask the user" tool** outright                                                                                                                                                                                                                 |

Item 8 is the most telling precedent: **Open-Inspect has no channel for a human to be asked a
question by an agent.** The sandbox disables the agent's question tool; the browser gateway refuses
the actions it cannot approve; the only human-decision channel in the product is the external-action
ledger, and it exists for _effects_.

### 2.2 The external-action ledger, in detail

- States (`packages/shared/src/types/external-actions.ts:7-16`): `awaiting_approval`, `approved`,
  `executing`, `succeeded`, `failed`, `denied`, `indeterminate`, `cancelled`.
- `prepare()` (`external-action-gateway.ts:200-275`) inserts a row in `awaiting_approval` and
  records `prepared` history with `actorKind: "pi"` (`:266-271`).
- `approve()` / `deny()` / `cancel()` (`:277`, `:281`, `:316`) record a **human** decision with an
  actor id, and enqueue an audit event (`:296-302`, `:331-337`, `:742-749`).
- `execute()` (`:500-569`) claims an execution lease and calls a **provider executor**; the
  provider's own result is validated and stored as `public_result_json`.
- `reconcile()` / `reconcileDue()` (`:571`, `:673`) re-drive an indeterminate effect; the outcome is
  never guessed.
- The decision is authorized by
  `requireAll(sessionRequirement("collaborate"), permissionRequirement("external_actions.approve"))`
  (`packages/control-plane/src/routes/session-external-actions.ts:83-95`), and the RBAC vocabulary
  is `packages/shared/src/rbac.ts:58-59`.

### 2.3 So: is an elicitation "an external action with a different provider", or "a different kind of ledger"?

**It is a different kind of thing.** Six concrete mismatches, each grounded in the code:

1. **The producer and the consumer are inverted.** In the ledger the **agent** proposes and the
   **SessionDO** executes an effect against a provider adapter
   (`packages/control-plane/src/pi/external-action-policy-extension.ts:115-152` — the policy hook
   calls `client.prepare(...)` before the tool may run). In an elicitation the **provider** proposes
   and the **human** answers; Open-Inspect performs no effect at all.
2. **There is no effect to execute.** The ledger's execution step calls a provider adapter
   (`external-action-definitions.ts:16-22`, `executor: ExternalActionExecutor`), and the ledger's
   `execute()` transitions `approved → executing → succeeded`. For an elicitation, "executing" would
   mean "hand the answer to the MCP server", which happens inside the MCP client, not inside the
   SessionDO's gateway.
3. **The ledger has nowhere to put the answer.** `approve()` takes an `ApprovalInput` of
   `{source, actorId, grantId, requestId}` (`external-action-gateway.ts:96-101`) and writes
   `approved_at`; the transition helper can carry a `publicResult` (`:168-182`), but the public
   `approve()` API cannot. `public_result_json` is defined as _the credential-free public result of
   the effect_ — the value that reaches the agent — not the human's input to a provider.
4. **The private lane's broker has no session identity at all.**
   `packages/control-plane/src/mcp/broker-contract.ts:28-35` — `mcpBrokerCallSchema` carries
   `connectionId`, `ownerUserId`, `toolName`, `arguments`. There is no `sessionId`, no
   `operationId`, no `toolCallId`. The ledger is session-scoped (`external_actions.session_id`;
   `listPending(sessionId)` at `external-action-gateway.ts:433-486`), so the broker physically
   cannot write a row into the session's ledger, and the broker's bindings
   (`packages/control-plane/src/cloudflare/mcp-connection-durable-object.ts:13`) do not include the
   session namespace.
5. **The authority is different.** The ledger's decision rule is "a collaborator who holds
   `external_actions.approve`". But in the private lane the provider sees the **connection owner's**
   identity, not the actor's (`mcp-connection-durable-object.ts:168-170` asserts
   `ownerUserId === call.ownerUserId`; `packages/control-plane/src/db/mcp-session-pins.ts` stores
   the pin's `owner_user_id`). Answering a question that will be attributed to the owner's account
   is not the same authority as approving a publication.
6. **The permission vocabulary would be conflated.** `external_actions.approve` means "authorize an
   outward effect". Reusing it for "supply an answer to a provider" would let a publication-approver
   answer server questions, and vice versa.

**Conclusion for Q2: the external-action ledger cannot carry an elicitation unchanged.** It could be
_extended_ — the state vocabulary maps surprisingly well (`awaiting_approval` → `approved`/`denied`/
`cancelled` ≈ `accept`/`decline`/`cancel`) — but that extension is a change to a shared contract
(`packages/shared/src/types/external-actions.ts`), a change to the gateway's approve API, a change
to the decision route's schema, a new answer-authority rule, and a new UI. It is not "unchanged
reuse".

### 2.4 The other candidate — the browser gateway — cannot carry it either

`browser-gateway.handler.ts:103-115` refuses, by name, exactly the browser actions that would need a
human decision (`PI_BROWSER_SENSITIVE_ACTIONS`: login, upload, download), with the reason "This
browser action needs a human approval, which this session does not have". There is no approval path
to extend — only a refusal to remove. It is, however, the right **precedent** for URL-mode
elicitation's host policy (`hostMatches`, `:217-229`).

---

## 3. Where an elicitation would land today (and what happens now)

### 3.1 The two lanes

```
Pi DO (agent)  ──fetch──▶  SessionDO (authority)  ──RPC──▶  McpConnectionDO (broker, private lane)
   pi-durable-object.ts:1769-1803     components.ts:866-881        mcp-connection-durable-object.ts:163-197
                                    └──in-process──▶  @modelcontextprotocol/client (shared lane)
                                        components.ts:834-865 → mcp-shared-client.ts:37-63
```

- **Private lane** (a personal connection the owner granted to this session): the MCP client lives
  in the **broker DO**, which holds the encrypted OAuth credential
  (`mcp-connection-durable-object.ts:49-67`). An elicitation would arrive _in the broker_, which has
  no session identity and no route back into the SessionDO (§2.3 #4).
- **Shared lane** (the deployment's own `mcp_servers`): the MCP client is created **inside the
  SessionDO** (`mcp-shared-client.ts:37-63`), so an elicitation would arrive in the session itself.
  The shared servers are tenant-wide — `terraform/d1/migrations/0018_create_mcp_servers.sql:2-14`
  declares `mcp_servers` with no workspace/team column — and are scoped to a session only by
  `repo_scope` (`components.ts:814-832`, `packages/control-plane/src/db/mcp-servers.ts:176-177`).

### 3.2 What happens today: **fail-closed, in both lanes**

- Neither lane declares the elicitation capability. The shared lane's client is constructed with no
  capabilities at all (`mcp-shared-client.ts:48`); the broker never calls
  `configureElicitationHandlers` (`grep` over `packages/` finds **no** match for
  `configureElicitationHandlers`, `elicitationHandlers`, or an `elicitation` capability anywhere in
  the repository).
- Consequently the v2 client has no `elicitation/create` handler, and an inbound elicitation is
  answered with `-32601 Method not found`
  (`node_modules/@modelcontextprotocol/client/dist/src-WCy6ifGf.mjs:5938,5943`).
- In the Agents SDK the same absence means `handleElicitationRequest` is never installed
  (`dist/client-BnYbNT3z.js:553` installs it only `if (this._elicitationEnabled)`), and if it were
  reached it would throw (`dist/client-BnYbNT3z.js:856-858`).
- The provider's own error never leaves the boundary: the shared lane throws a generic "The MCP tool
  did not complete" (`mcp-shared-client.ts:57-59`), the broker throws the same
  (`mcp-connection-durable-object.ts:219-222`), and the session turns it into `mcp_tool_failed` /
  HTTP 502 (`mcp-session.handler.ts:374-393`).

This matches the repo's own record: "**MCP elicitation.** No handler, route, or schema."
(`features/pi-first-class/AUDIT-ROUND-6.md:158`).

---

## 4. The brief's question 3 — read or mutation?

**An elicitation is a READ.** The evidence:

1. **The protocol defines it as information gathering.** The 2025-11-25 spec: _form mode_ is
   "in-band structured data collection"; _URL mode_ is "out-of-band interaction via URL navigation.
   Data (other than the URL itself) is **not** exposed to the client." The server asks; it does not
   ask the client to perform an action. The MCP result vocabulary is `accept` / `decline` / `cancel`
   — a _response_, not an authorization.
2. **Open-Inspect's own vocabulary agrees.** The product's effect taxonomy is
   `local_read | local_mutation | external_read | external_mutation | sandbox_execution | control`
   (`packages/shared/src/pi-tool-effects.ts:2-9`), and the MCP tool is already classified
   `external_read` (`:162-169`). An elicitation is nested _inside_ that read; it does not change the
   tool's effect.
3. **The mutation path is already defined and does not apply.** An MCP mutation "is not a tool, it
   is an external action that a person approves"
   (`packages/control-plane/src/pi/mcp-extension.ts:38-45`), and the reviewed catalog structurally
   refuses mutations: the executable snapshot accepts only `effect = 'external_read'`
   (`terraform/d1/migrations/0092_mcp_oauth_foundation.sql`,
   `mcp_connection_tool_snapshots.effect CHECK (effect = 'external_read')`).

### 4.1 The two caveats that must travel with the classification

- **Tainted input.** The human's answer is free text that flows to a third-party provider and may
  flow back into the model's context. The spec forbids servers from asking for sensitive data
  ("Servers **MUST NOT** request sensitive information (passwords, API keys, etc.) via form mode"),
  but Open-Inspect cannot trust the server — so the answer must pass the same
  `assertNoCredentialLikeKeys` gate the read result passes
  (`packages/shared/src/types/mcp-read.ts:152-154`,
  `packages/shared/src/types/credential-shaped.ts`).
- **The answer can redirect the read.** A server that asks "which account?" can steer the reviewed
  tool at a different resource than the reviewer intended. This is not a new hole — the tool's
  _arguments_ are not re-reviewed per call either (`mcp-session.handler.ts:348-365` gates on the
  tool name, not the arguments) — but a human's answer is a new place where the redirect can enter.

### 4.2 URL mode is a different animal

URL-mode elicitation asks the human to navigate to a third-party URL, out of band, where the
interaction (possibly a third-party authorization) happens without the client seeing the data. For
Open-Inspect this is **not** a read: it is an outward navigation to an arbitrary host. The spec
requires the client to show the full URL, gather explicit consent, never pre-fetch it, and never
open it without consent. The existing reviewed-host allowlist is the right instrument
(`browser-gateway.handler.ts:148-154`, `hostMatches` at `:217-229`). **Recommendation: URL mode is
out of scope for a first implementation.** Form mode only.

---

## 5. The verdict

### 5.1 Bucket: **C — new primitive**

| Bucket                 | Verdict      | Why                                                                                                                                                                                                                                                                                                              |
| ---------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A (harness-parity)     | ✗            | The harness parity available is the _refusal_: the sandbox disables `AskUserQuestion` (`claude.py:88`), the browser gateway refuses what it cannot approve (`browser-gateway.handler.ts:103-115`), and both MCP lanes already refuse elicitation. There is no harness-parity behaviour that "answers the human". |
| B (adapter/plumbing)   | ✗            | Every plausible B path needs somewhere to put a _pending question_ and its _answer_. Nothing in the repository holds one (§2.1).                                                                                                                                                                                 |
| C (new primitive)      | **✓**        | A durable **interaction receipt** (question + requested schema + answer + state) in the SessionDO, plus a way for a human to answer it, plus a decision about the read's time regime.                                                                                                                            |
| D (boundary deviation) | ✗ (to avoid) | D would be: advertising the elicitation capability while not supporting it, answering a question on behalf of a user who did not answer it, letting a provider's question decide the user's authority, or letting one session's answer reach another session's read.                                             |

### 5.2 A new primitive is required — stated precisely

**New primitive P1 — the durable interaction receipt.** SessionDO-owned, session-scoped, alongside
the external-action tables (`packages/control-plane/src/session/schema.ts:73-142`). It must hold:
the provider's identity (connection id _or_ shared server id), the tool name, the request's
`message` and `requestedSchema` (bounded), the requested mode, the state, the answer (bounded,
credential-checked), the answering user id, and a match key so the answer can be applied to the
right question.

**New primitive P2 — the answer's delivery path.** The receipt's answer must reach the MCP server.
Two candidate mechanisms, both new:

- (a) _In-flight_: hold the read open until the human answers. **Blocked today** by the 30-second
  budget (`MCP_TOOL_TIMEOUT_MS`, `MCP_SHARED_CALL_TIMEOUT_MS`) and by the DO's memory-only pending
  promise. Requires a new "long read" regime with its own bound, its own authorization, and its own
  exhaustion semantics.
- (b) _Out-of-band + retry_: refuse/decline the provider immediately, raise the receipt, and apply
  the stored answer on a **later** call. This is exactly the MRTR shape the protocol added
  (`index.d.mts:1941-1965`), and it is the only one that fits the existing bounded-call regime. But
  it requires: opting into the 2026-07-28 era (`versionNegotiation`, opt-in —
  `index.d.mts:1859-1874`), and an **answer-matching rule**, because form-mode elicitation carries
  no stable identifier (URL mode does: `elicitationId`). The MRTR era's `input_required` result does
  carry server-assigned ids (`index-B-4n9P0J.d.mts:705-711`), so mechanism (b) is materially cleaner
  in the modern era than in the 2025 era.

**New primitive P3 — the answer's authority.** Who may answer, resolved from D1 at answer time (the
boundary rule requires the _current_ authority, not the authority at read time):

- Private lane: the answer should come from the **connection's owner**
  (`mcp_session_pins.owner_user_id`, `terraform/d1/migrations/0095_mcp_session_pins.sql`), because
  that is the identity the provider sees. The current decision rule
  (`sessionRequirement("collaborate")` + `external_actions.approve`,
  `routes/session-external-actions.ts:83-95`) does not express that.
- Shared lane: the provider cannot identify the human at all (the deployment's credential is used:
  `mcp-shared-client.ts:5-15`), so the answer comes from the session's turn actor, and it must never
  be reusable by another session.

**Explicitly NOT needed** (this is the good news): no new D1 table, no new tenant-wide model, no
credential handling, no new provider adapter, no change to the reviewed catalog, no change to the
external-effect approval path.

### 5.3 Can the external-action ledger carry it unchanged? **No.** (§2.3, six reasons.)

It can carry it _by extension_, at the cost of: a new answer channel in the shared contract, a new
`approve()` input, a new decision-route body field, a new authority rule, a new UI form, and a
deliberate overload of the word "approval". That is a **shared-interaction-model change**, and it is
the decision the brief names.

### 5.4 The single-tenant tension

The tension is real but **bounded**, and it is about _where the receipt lives_, not about who may
see it:

- The **shared lane's server is the deployment's** (`mcp_servers` has no workspace or team column —
  `terraform/d1/migrations/0018_create_mcp_servers.sql:2-14`), and the deployment's credential is
  what the provider sees (`mcp-shared-client.ts:5-15`). A naive implementation that stores answers
  keyed by _server_ would be tenant-wide storage, and one session's answer would silently become
  another session's answer. **The receipt must be session-scoped** — the SessionDO's SQLite, exactly
  like the external-action ledger (`external_actions.session_id`). This keeps the single-tenant
  model intact: no new tenant-wide table, no new tenant-wide scope.
- The **private lane's provider is a person's** (the connection owner's identity, enforced at
  `mcp-connection-durable-object.ts:168-170`). Here the tension is the reverse: the receipt lives in
  the session, but the _answer_ belongs to the owner's account. The rule "the connection owner may
  answer; a collaborator may not, unless the owner delegated" is a **new authority rule** and needs
  a human decision.
- The **review** of a shared server's tools is already workspace-wide
  (`packages/control-plane/src/db/mcp-server-reviews.ts:56-62`: "The review belongs to the
  workspace"), and only `mcp_servers.manage` may write it. If elicitation becomes a supported
  capability, the **review record** should also record that the server may elicit — otherwise a
  workspace admits a server that can interrupt any session in the workspace. That is a
  **forward-only migration** of the reviewed catalog (the same shape as brief §3's resource/prompt
  review).

### 5.5 Options for the human to choose

| Option                                                                   | Shape                                                                                                                                                                                                                                                                         | Cost                                                                                                                                                                                                      | Risk                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **O1 — stay refused, make it legible** (bucket A/B)                      | Keep both lanes refusing elicitation. Add a distinct, bounded reason code (e.g. `mcp_elicitation_unsupported`) to the MCP read audit so an operator can see that a server tried to elicit and why the read failed. No capability advertised, no table, no auth path.          | Small: 1 detection point per lane, 1 reason code, 1 audit path. **The provider's error string still never leaves** — the classification must happen inside the client/broker where the string already is. | Requires classifying a provider error we deliberately do not parse. If the server swallows the `-32601` and returns its own generic error, the code cannot be produced, and the feature degrades to "no signal".                                               |
| **O2 — form mode only, MRTR era, out-of-band answer** (bucket C)         | Opt into the 2026-07-28 era for the shared lane; the client raises a durable receipt when the server returns `input_required`, answers `decline` to unblock, and applies the stored answer on the next call. Private lane follows once the broker can carry session identity. | Medium-large: P1 + P2(b) + P3, a new session table, a new internal route pair, a new public route pair, a new sidebar form, a new capability flag, a reviewed-catalog migration.                          | The MRTR era is brand new; `agents` 0.28.1's own MCP client is built on the 2025-era request/response shape and does not expose the MRTR knobs. The answer-matching rule still needs to be exact, or a stale answer is sent to a differently-phrased question. |
| **O3 — form mode only, in-flight answer, raised read budget** (bucket C) | Keep the 2025-era blocking shape; hold the read open while the human answers; the receipt is the durability mechanism and the read gets a much larger budget.                                                                                                                 | Medium-large: P1 + P2(a) + P3, plus a **new time regime** for MCP reads (a session held open for minutes is a new resource/UX class for Open-Inspect).                                                    | A long-held read is a new DoS/latency surface; the DO cannot be relied on to stay alive; the provider's own request timeout may expire first.                                                                                                                  |
| **O4 — O2 + URL mode** (bucket C)                                        | Add URL-mode consent, gated by the browser gateway's reviewed-host list.                                                                                                                                                                                                      | O2 + the host policy + a consent UI + `notifications/elicitation/complete` handling.                                                                                                                      | URL mode is an outward navigation and a third-party authorization flow; it is a mutation-shaped risk wearing a read's clothes.                                                                                                                                 |

**Recommendation: O1 now, then O2 (form mode only) as a separate, human-approved slice.** O1 is the
only option that is honestly implementable inside the existing boundary, and it converts a silent
`mcp_tool_failed` into something an operator can act on.

---

## 6. A sized plan for O2 (if a human approves it)

Not implemented. Sized so the decision can be costed.

| Piece                     | Where                                                                                                                                                                                               | Rough size                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Session table + migration | `packages/control-plane/src/session/schema.ts`, `terraform/d1/migrations/00XX_mcp_interaction_receipts.sql`                                                                                         | 1 table (session-scoped), 1 D1 migration is **not** needed (session-scoped ⇒ no tenant-wide table)                          |
| Shared contract           | `packages/shared/src/types/mcp-interaction.ts` (new), exported from `packages/shared/src/index.ts`                                                                                                  | ~120 lines (zod schemas for the request, the schema subset, the answer, the pending list, the decision body)                |
| Session gateway           | `packages/control-plane/src/session/external-action-gateway.ts`-style new class `McpInteractionGateway` in `packages/control-plane/src/session/mcp-interaction-gateway.ts`                          | ~300 lines                                                                                                                  |
| Session routes            | `packages/control-plane/src/session/contracts.ts` (paths), `packages/control-plane/src/session/http/routes.ts`, a new `packages/control-plane/src/session/http/handlers/mcp-interaction.handler.ts` | ~200 lines                                                                                                                  |
| Public routes             | `packages/control-plane/src/routes/session-mcp-interactions.ts` (new) + `packages/control-plane/src/routes/sessions.ts`                                                                             | ~90 lines                                                                                                                   |
| Authority                 | `packages/shared/src/rbac.ts` (a permission id), `packages/control-plane/src/routes/…` (`requireAll`)                                                                                               | ~20 lines — **and a product decision about the permission name and who holds it**                                           |
| Client (shared lane)      | `packages/control-plane/src/session/mcp-shared-client.ts`                                                                                                                                           | ~120 lines (era opt-in, `inputRequired.autoFulfill: false`, handler that raises the receipt, retry that applies the answer) |
| Client (private lane)     | `packages/control-plane/src/cloudflare/mcp-connection-durable-object.ts` + `packages/control-plane/src/mcp/broker-contract.ts`                                                                      | ~150 lines **plus** a new session binding on the broker and a broker→session callback — the hardest part                    |
| Pi surface                | `packages/control-plane/src/pi/mcp-extension.ts` (a "needs your input" result), `packages/control-plane/src/cloudflare/pi-durable-object.ts`                                                        | ~60 lines                                                                                                                   |
| Web UI                    | `packages/web/src/components/sidebar/mcp-interactions-section.tsx` (new), a hook, API routes                                                                                                        | ~250 lines — the form must render the provider's `requestedSchema` (flat primitives only)                                   |
| Reviewed catalog          | `terraform/d1/migrations/…` — record that a server may elicit                                                                                                                                       | forward-only migration                                                                                                      |
| Tests                     | unit (gateway, handler, client), workerd integration, web                                                                                                                                           | ~600 lines                                                                                                                  |

Total: **~1,900 lines across ~18 files, plus one D1 migration and one RBAC decision.** This is a
slice, not a patch.

---

## 7. What was not implemented, and why

**Nothing was implemented.** The audit shows that every path to a working elicitation requires **P1
(a new durable receipt table), P2 (a new delivery mechanism), and P3 (a new answer-authority
rule)**. The brief's process rule is explicit: _"STOP before implementing if the design requires a
new ledger, a new table, or a new auth path."_ It does. Therefore this is reported as a product
decision.

The only work in this branch is this document. The repository's build, type, lint, and test
configuration is untouched, so the baseline is unchanged.

---

## 8. UNVERIFIED

1. **What a specific third-party MCP server actually does when its elicitation is refused.** No
   server implementation is in this repository, and no live server was contacted. The claim in §3.2
   that the refusal surfaces as `-32601 Method not found` is verified from the SDK's code path, but
   **how a given server reacts to it** (fails the call / retries / ignores) is not verified.
2. **Whether the MRTR (`input_required`) era is reachable from the Agents SDK's MCP client
   (`agents@0.28.1`).** The SDK's `MCPClientConnection` is built on the v2 client and does expose
   `setRequestHandler` (`dist/client-BnYbNT3z.js:553`), but the Agents SDK does not expose the v2
   client's `inputRequired` / `versionNegotiation` options through `MCPClientManager`. Whether
   `MCPClientManager` can be made to negotiate the modern era is **not verified**; it may require
   upstream support. The shared lane, which uses the v2 client directly, is unaffected by this.
3. **The exact Durable Object eviction behaviour during a pending promise.** The audit does not
   claim a specific eviction deadline; it claims only that (a) the pending promise is memory-only
   and (b) the 30-second call budget makes the in-flight shape unworkable regardless. Both are
   verified from code and constants.
4. **Whether `agents@0.28.1`'s `MCPClientManager` persists capabilities in a way that would need a
   migration.** `persistAdvertisedCapabilities` (`dist/client-BnYbNT3z.js:2218-2231`) writes the
   advertised set into the stored rows, and `clearStoredCapabilities` (`:1468`) removes it after a
   successful handshake. The precise upgrade path for an existing broker was not traced.
5. **The `mcp_read_audit` reason-code vocabulary** is a plain string column
   (`packages/control-plane/src/db/mcp-read-audit.ts:14`), so adding a code is trivial; but whether
   the workspace audit UI filters on reason codes was not checked.
6. **Multi-tenant deployment.** The repository is single-tenant by design (`AGENTS.md`), and
   `mcp_servers` has no workspace column. If Open-Inspect is ever deployed multi-tenant, the shared
   lane's "the deployment's server" assumption in §5.4 changes and the answer-authority rule must be
   revisited. Not verified because the deployment model is single-tenant today.

---

## 9. Where this reading differs from the repository's own documents

1. **`features/pi-first-class/STATE-AND-HANDOVER.md:274-280`** — _"The spec maps it to 'SessionDO
   durable interaction receipt and UI'. The `agents` SDK's client already surfaces elicitation
   requests through a handler (`MCPClientElicitationHandler`), so the mechanism exists; what is
   missing is the Open-Inspect half: a durable receipt in the session, a route the client answers
   through the session, and the UI. The receipt must be durable because the server waits for an
   answer that a human gives later."_

   **This is incomplete in three ways.** (a) _The mechanism does not exist for the shared lane._ The
   Agents SDK's handler is only reachable through `MCPClientManager`; the shared lane uses the raw
   `@modelcontextprotocol/client` (`mcp-shared-client.ts:1-2,48`) and never sees
   `MCPClientElicitationHandler` at all. (b) _A durable receipt is not the missing half — the time
   regime is._ Both lanes bound an MCP call at 30 seconds (`MCP_TOOL_TIMEOUT_MS`,
   `MCP_SHARED_CALL_TIMEOUT_MS`). A human answer does not arrive inside 30 seconds, so a receipt + a
   route + a UI, exactly as described, would still not work. The design must also change _when_ the
   answer is delivered (out-of-band + retry, or a raised budget), and the repo's own framing does
   not mention that. (c) _A route the client answers through the session does not cover the private
   lane._ The private lane's client lives in the broker DO, which has no session identity
   (`broker-contract.ts:28-35`) and no session binding (`mcp-connection-durable-object.ts:13`).

2. **`features/pi-first-class/SPEC-MAP.md:118`** — _"Durable approval/elicitation/execution state."_
   This groups elicitation with approval and execution as if they were one kind of state. They are
   not: an elicitation is a **read** that waits for input (§4), not an effect that waits for
   authorization. The external-action ledger's states happen to fit the vocabulary, but its
   _semantics_ — agent proposes, SessionDO executes an effect, provider adapter performs it — do
   not.

3. **`packages/control-plane/src/cloudflare/mcp-connection-durable-object.ts:36-45`** (the class doc
   comment) — _"The manager deliberately is not installed on a Lifecycle yet: no persisted
   registration is restored, no callback is accepted, and no network connection or tool call can
   start in this slice."_ — **This contradicts the code in the same file**: `:76` installs the
   manager (`Lifecycle.install(this).use(this.mcp)`), `:263-265` starts the lifecycle, and
   `:273-275` accepts the OAuth callback. `status()` also still returns `enabled: false` / "Live MCP
   transport is not enabled" (`:145-152`) while `callTool` is fully implemented (`:163-197`). The
   comment and the `status()` payload are stale; git history shows
   `1d05cfe5 feat: install the MCP transport in the broker` landed after the comment was written.
   This matters for the audit because it is the file that would carry a private-lane elicitation
   handler: a reader trusting the comment would conclude the private lane is dormant.

4. **`features/pi-first-class/STATE-AND-HANDOVER.md:276`** says the SDK "already surfaces
   elicitation requests through a handler". True for the Agents SDK's _manager_; **not** true of the
   protocol surface Open-Inspect actually uses in the shared lane, and it glosses over the fact that
   registering a handler **advertises a capability** (§1.3) and persists that advertisement on every
   stored connection — a boundary-visible change, not a local one.

5. **`features/pi-first-class/AUDIT-ROUND-6.md:158`** — _"MCP elicitation. No handler, route, or
   schema."_ — **This is accurate and understated.** There is also **no refusal reason**: today a
   server that elicits is indistinguishable from any other failed tool call at the session boundary
   (`mcp_tool_failed`, `mcp-session.handler.ts:374-393`). That is the gap option O1 would close.

---

## 10. Summary

| Question                                                        | Answer                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| What does the SDK's handler need?                               | A per-request async callback keyed by mode (`form`/`url`), returning `ElicitResult`, with an abort signal and **no** timeout of its own (`agents/dist/agent-routing-BMvWTFEp.d.ts:2743-2752`).                                                                                       |
| Does it survive DO eviction?                                    | **No** — the promise is memory-only, and more fundamentally the 30-second read budget makes an in-flight human answer unworkable regardless (`MCP_TOOL_TIMEOUT_MS`, `MCP_SHARED_CALL_TIMEOUT_MS`). A durable receipt is **mandatory**, and so is a change to the read's time regime. |
| Does Open-Inspect have "a provider waits for a human, durably"? | Only the **external-action approval ledger** (session-scoped), and it is for _effects_. The browser gateway has no approval path at all (`browser_action_needs_approval`); the sandbox disables the agent's own question tool (`claude.py:88`).                                      |
| Is an elicitation an external action?                           | **No.** It is a **read** that gathers information (§4). It does not belong behind the external-action ledger.                                                                                                                                                                        |
| Can the external-action ledger carry it unchanged?              | **No** — six concrete mismatches (§2.3): inverted producer/consumer, no effect to execute, no channel for the answer, the broker has no session identity, a different authority rule, and a conflated permission.                                                                    |
| Bucket                                                          | **C — new primitive** (a durable interaction receipt + an answer-delivery mechanism + an answer-authority rule). Not A, not B, and D is what we are avoiding.                                                                                                                        |
| New primitive required?                                         | **Yes** — P1 (receipt), P2 (delivery), P3 (authority). No new _tenant-wide_ table is required: the receipt is session-scoped, like the external-action ledger.                                                                                                                       |
| Implemented?                                                    | **No.** Stopped before implementation, per the brief's process rule.                                                                                                                                                                                                                 |

**The one decision a human has to make first:** is a provider allowed to interrupt a session with a
question at all? If the answer is no, O1 (make the refusal legible) is the whole feature. If the
answer is yes, O2 (form mode, MRTR era, out-of-band answer) is a slice of roughly 1,900 lines that
must also decide **who may answer** — the connection owner in the private lane, the turn's actor in
the shared lane — which is an authority question, not an implementation detail.

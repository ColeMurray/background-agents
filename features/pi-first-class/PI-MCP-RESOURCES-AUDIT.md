# PI-MCP-RESOURCES-AUDIT

**Question**: can Open-Inspect expose reviewed MCP _resources_ and _prompts_ to a session, or does
the review surface need a new kind?

- Repo: `/Users/param/.local/share/opencode/worktree/0e6d72/pi-go-live-v2`
- Branch: `feat/pi-go-live-integration-v2`, HEAD `a6ab76de`
- Method: read-only. Every claim carries a `file:line`. Nothing was executed except greps and file
  reads; nothing was written except this file.

---

## 1. Verified findings

**1.1 The review surface is per server _revision_, and tool-shaped everywhere**

- Review table `mcp_reviewed_tools` — `terraform/d1/migrations/0092_mcp_oauth_foundation.sql:26-41`.
- The review is the row set for one `(server_id, server_revision)`, replaced wholesale on each write
  (`:92` DELETE, `:94-118` INSERT) and refused if the server moved
  (`packages/control-plane/src/db/mcp-server-reviews.ts:83-87`).
- `stable_tool_id` is derived from the **tool name**: `mcptool_<sha256(toolName)[0:32]>`
  (`mcp-server-reviews.ts:187`); uniqueness is `(server_id, server_revision, tool_name)`
  (`0091:40`).
- The reviewer's classification has exactly two legal values (`0091:37` —
  `effect IN ('external_read','external_mutation')`); only `external_read` is projected
  (`mcp-connections.ts:160-163`, `:276-279`; `components.ts:1728-1730`) and the executable snapshot
  can hold only that value (`0091:55`).
- Columns: `stable_tool_id`, `tool_name`, `title`, `description`, `input_schema_json` +
  `input_schema_sha256`, `output_schema_json` + `output_schema_sha256`, `effect`,
  `reviewed_by_user_id`, `reviewed_at` (`0091:27-39`).
- Writer: any active holder of `mcp_servers.manage`
  (`packages/control-plane/src/routes/mcp-servers.ts:186`, `:292-294`;
  `packages/shared/src/rbac.ts:64`). `mcp_servers` has **no owner/workspace column**
  (`terraform/d1/migrations/0018_create_mcp_servers.sql:2-14`) → the review is tenant-wide.
- Revision column added at `terraform/d1/migrations/0062_mcp_server_revisions.sql:1`, bumped on
  every server edit (`packages/control-plane/src/db/mcp-servers.ts:292-293`).
- The review request body is `.strict()` with a `tools` array only
  (`packages/shared/src/types/mcp-read.ts:30-35`); the view exposes
  name/title/description/effect/timestamps (`routes/mcp-servers.ts:280-287`;
  `packages/shared/src/types/mcp-read.ts:40-55`).
- The web UI has **no** review surface today (no `/mcp-servers/:id/review` call in
  `packages/web/src`).

**1.2 The connection stages an immutable copy; the hash covers the reviewed tools only**

- `catalogSnapshotSha256(serverId, serverRevision, tools)` —
  `packages/control-plane/src/db/mcp-connections.ts:62-81`. It hashes
  `sha256(JSON.stringify({ serverId, serverRevision, tools: [{ stableToolId, name, title ?? null, description ?? null, inputSchemaSha256, outputSchemaSha256 ?? null }] }))`.
  **Tools only** — no resource URI, no prompt name, no mime type.
- Computed at creation (`mcp-connections.ts:283-287`); stored in
  `mcp_connections.catalog_snapshot_sha256` (`0091:12`).
- A connection's tool names are read from `mcp_connection_tool_snapshots` filtered on
  `effect='external_read'` (`mcp-connections.ts:153-164`), and from `mcp_reviewed_tools` at creation
  (`:270-280`) then copied into the snapshot (`:308-330`).
- `listOwned` **recomputes** the hash and throws on mismatch (`mcp-connections.ts:174-181`);
  `getOwned` (`:187-196`) and `findOwnedByServer` (`:207-218`) funnel through it, and the session's
  grant list calls `getOwned` (`packages/control-plane/src/session/components.ts:799`).
- The invariant the pin protects: `mcp-connections.ts:56-61`; `0091:43-44`;
  `terraform/d1/migrations/0095_mcp_session_pins.sql:3-6`.

**1.3 The grant's stored hash and where it is compared**

- Stored at `mcp_session_pins.catalog_snapshot_sha256` (`0095_mcp_session_pins.sql:15`); the granted
  names are a JSON array in `tool_names` (`:19`).
- Compared **at grant time only**: `packages/control-plane/src/db/mcp-session-pins.ts:99-115` —
  `connection.catalog_snapshot_sha256 !== input.catalogSnapshotSha256` → _"The MCP connection
  catalog changed; review it again before granting"_. The web route hands the client the stored hash
  to send back (`packages/control-plane/src/routes/mcp-session-pins.ts:70`).
- The **read** path never re-checks the pin's hash — only its name list
  (`packages/control-plane/src/session/http/handlers/mcp-session.handler.ts:348`).

**1.4 The read gate** — `McpSessionHandler.read`
(`packages/control-plane/src/session/http/handlers/mcp-session.handler.ts:195-441`): capability
(`:205`) → human actor for the operation (`:214`) → one of two lanes.

- _Shared lane_ (deployment-owned server): the server must be in `bridge.sharedServers()`
  (`:221-241`, reason `mcp_server_not_available`) and the tool in `server.toolNames` (`:242-259`,
  reason `mcp_tool_not_reviewed`). `sharedServers()` derives those names from `mcp_reviewed_tools`
  at the server's **current** revision (`components.ts:823` → `:1721-1735`); the call re-checks the
  same list (`components.ts:849-852`).
- _Personal-connection lane_: a grant must exist (`:328-347`, `mcp_connection_not_granted`) and the
  grant's `toolNames` must contain the tool (`:348-365`, `mcp_tool_not_reviewed`).
- Both lanes then call the provider (`:262` / `:369`), bound the result (`boundResult`, `:451-469`;
  64 KiB at `packages/shared/src/types/mcp-read.ts:162`) and apply the credential guard (`:283-306`
  shared, `:399-422` personal).

**1.5 The broker's re-check, both lanes**

- _Personal lane_: `McpConnectionDO.callTool`
  (`packages/control-plane/src/cloudflare/mcp-connection-durable-object.ts:163-197`) rechecks
  identity against the call (`:168-170`), owner + status from D1 (`:171-182`), and the reviewed
  catalog:
  `SELECT 1 FROM mcp_connection_tool_snapshots WHERE connection_id = ? AND tool_name = ? AND effect = 'external_read'`
  (`:184-192`). The credential never leaves the broker (`:193-196`).
- _Shared lane_: no DO broker — the session DO calls the provider itself with the deployment's
  credential (`packages/control-plane/src/session/mcp-shared-client.ts:37-63`, reached at
  `components.ts:834-865`). Its reviewed-catalog re-check is `reviewedReadOnlyToolNames`
  (`components.ts:1721-1735`, used at `:823` and `:849`), reading `mcp_reviewed_tools` at the
  current revision. Note the asymmetry: the personal lane is pinned to a snapshot; the shared lane
  re-reads the live review.

**1.6 The credential guard**

- Module `packages/shared/src/types/credential-shaped.ts`: `CREDENTIAL_KEYS` (`:11-20`),
  `findCredentialLikeKeys` (`:28-44`), `assertNoCredentialLikeKeys` (`:53-65`). It matches **key
  names** (non-alphanumerics stripped, lowercased) at every depth.
- Wired into `mcpReadResultSchema.superRefine` on `content`
  (`packages/shared/src/types/mcp-read.ts:152-154`); enforced at `mcp-session.handler.ts:399-422`
  (personal) and `:283-306` (shared); a violation is refused with `mcp_result_not_credential_free`,
  audited as `mcp_result_carried_a_credential`.

**1.7 The SDK shapes**

- `client.readResource(params, options)` →
  `{ contents: Array<TextResourceContents | BlobResourceContents> }`
  (`node_modules/@modelcontextprotocol/client/dist/index.mjs:3924`; typed
  `node_modules/@modelcontextprotocol/client/dist/index.d.mts:2582`; result schema
  `node_modules/@modelcontextprotocol/core/dist/auth-BNDyLTqp.mjs:494`), each entry
  `{ uri, mimeType?, _meta? } & ({ text: string } | { blob: base64 })` (core `:406-425`). The client
  also caches `resources/read` by `{method, uri}` (client `index.mjs:3912-3923`).
- A resource listing carries `uri`, `description?`, `mimeType?`, `size?`, `annotations?` (core
  `:441-452`) and **resource templates** carry a `uriTemplate` (core `:454-466`) — the URI space is
  server-chosen and unbounded.
- `client.getPrompt(params, options)` →
  `{ description?, messages: [{ role: "user"|"assistant", content }] }` (client `index.mjs:3648`;
  typed `index.d.mts:2417`; schema core `:695-698`, `:688-691`); request args are
  `record<string,string>` (core `:605-608`); the listing entry is
  `{ name, title?, description?, arguments? }` (core `:587-593`). It is a plain `prompts/get`
  request — **no approval, no elicitation**.
- SDK version read: `@modelcontextprotocol/client` 2.3.1
  (`node_modules/@modelcontextprotocol/client/package.json:3`).

**1.8 What the agent gets today**

- Exactly **one** MCP tool: `mcp_read`, effect `external_read`, replay `safe`
  (`packages/shared/src/pi-tool-effects.ts:162-169`); its extension is
  `packages/control-plane/src/pi/mcp-extension.ts:46-121`.
- The tool's own doc states the rule the taxonomy encodes: an MCP mutation "is not a tool, it is an
  external action that a person approves" (`mcp-extension.ts:41-44`).
- Pi owns no MCP client — the only MCP mention in `node_modules/@earendil-works/pi-durable/dist` is
  documentation (`dist/codemode/codemode.d.ts:157`, `dist/harness/types.d.ts:256`).

---

## 2. The six answers

**A1. What exactly does "reviewed" mean today?** Table `mcp_reviewed_tools` (`0091:26-41`); revision
`mcp_servers.revision` — the review is the row set for one `(server_id, server_revision)`, replaced
wholesale (`mcp-server-reviews.ts:92-118`) and refused if the server moved (`:83-87`). Columns as
listed in 1.1. The effect value that matters is `external_read` — the only one the projections
accept (`mcp-connections.ts:160-163`, `:276-279`; `components.ts:1728-1730`) and the only one the
snapshot can hold (`0091:55`); `external_mutation` is recorded for auditability and is structurally
unable to reach a connection (`0091:24-25`, `mcp-server-reviews.ts:4-9`). The writer is any active
holder of `mcp_servers.manage` (`routes/mcp-servers.ts:186`, `:292-294`); because `mcp_servers` has
no owner column (`0018:2-14`) the review is a **tenant-wide** act.

**A2. Per server or per connection? Does the hash cover the reviewed tools only?** **Per server
revision** (tenant-wide), with each **connection** staging an immutable, hash-pinned copy of the
reviewed reads (`mcp_connection_tool_snapshots`, `0091:45-59`; staged at
`mcp-connections.ts:270-331`); the review is explicitly not delegable to a connection
(`mcp-server-reviews.ts:54-61`). **Yes, the hash covers the reviewed tools only.** The exact
function is `catalogSnapshotSha256(serverId, serverRevision, tools)` — `mcp-connections.ts:62-81` —
hashing
`{serverId, serverRevision, tools:[{stableToolId, name, title ?? null, description ?? null, inputSchemaSha256, outputSchemaSha256 ?? null}]}`.
The tools handed to it are the reviewed reads (`mcp-connections.ts:270-280` at creation, `:153-164`
at read time).

**A3. What would "reviewed" have to mean for resources/prompts — can an existing column carry it?**
A _resource_ has no input/output schema (its shape is `uri`/`description`/`mimeType`/`size`/
`annotations`, core `:441-452`) and no effect to classify — a resource read is unconditionally an
external read. Carrying it in the existing `effect` column would be vacuous, and the stable-id
derivation (`mcp-server-reviews.ts:187`) plus the uniqueness (`0091:40`) cannot hold a **URI**.
"Reviewed resource" would have to mean _this exact URI (or template) on this server revision,
reviewed by a human, with a body bound_ — a **new reviewed-object kind** (new table keyed by URI, or
a kind column plus URI/mimeType/bound columns), and a bound is mandatory because the URI space is
unbounded (core `:454-466`). A _prompt_ is not a read of data; it returns model instructions
(`GetPromptResult.messages`, core `:695-698`). The enum has no third value and `external_read` would
be a false classification — a prompt can steer the agent toward a mutation the approval ledger
otherwise catches (`mcp-extension.ts:41-44`). It would need a new table **and** a new effect class.
**Only `reviewed_by_user_id` and `reviewed_at` carry over unchanged. No existing column can carry
either; a new table (and, for prompts, a new effect value) is required.**

**A4. Does adding resources/prompts to the snapshot change the hash's meaning, and would it
invalidate existing grants?** **Yes — and it breaks in two places, one hard.**

1. _Hard — the connection row._ `mcp_connections.catalog_snapshot_sha256` (`0091:12`) is re-verified
   on every read: `listOwned` recomputes and **throws** on mismatch (`mcp-connections.ts:174-181`);
   `getOwned` (`:187-196`) and `findOwnedByServer` (`:207-218`) funnel through it, and the session's
   grant list calls `getOwned` (`components.ts:799`). Changing the payload invalidates **every
   existing connection's** stored hash → `listOwned` throws → the personal-connection lane breaks
   for every existing connection.
2. _Soft — the grant._ The grant's stored hash is `mcp_session_pins.catalog_snapshot_sha256`
   (`0094:15`); the comparison is `mcp-session-pins.ts:111-115` and runs **at grant time only** —
   the read gate checks the pin's name list instead (`mcp-session.handler.ts:348`). Existing pins
   keep working against the snapshot rows but name a hash that no longer describes the catalog, and
   every new grant against a re-staged connection needs a re-pin.
3. The only way to avoid the break is to keep the hash over the tools — which leaves resources and
   prompts **outside** the pin and contradicts the invariant stated in three places
   (`mcp-connections.ts:56-61`; `0091:43-44`; `0094:3-6`). **Conclusion: widening the snapshot is a
   forward-only migration — re-review, re-stage, re-pin.**

**A5. What does `readResource` return, and could a resource body carry a credential-shaped
payload?** `readResource({ uri })` returns `{ contents: [...] }`, each entry
`{ uri, mimeType?, _meta? }` plus either `text: string` or `blob: base64` (core `:494`, `:406-425`;
client `index.mjs:3924`). **Yes — and the existing guard catches it.** `assertNoCredentialLikeKeys`
(`packages/shared/src/types/credential-shaped.ts:53-65`) is a generic recursive key-name check over
an unknown value, so applying it to the resource `contents` array is mechanical: a `_meta` object
with an `authorization`/`token` key is refused exactly as a tool result is refused today
(`packages/shared/src/types/mcp-read.ts:152-154`; enforcement at `mcp-session.handler.ts:399-422`,
`:283-306`). **The guard needs no change.** The honest caveat is the guard's blind spot, shared with
tools today: it matches **names, not values**, so a credential pasted into a `text` body (or hidden
in a base64 `blob`) is _not_ detected — exactly as a credential pasted into a tool's
`content[].text` is not detected. The real control on a resource is therefore the **bound**
(`boundResult`, `mcp-session.handler.ts:451-469`; 64 KiB,
`packages/shared/src/types/mcp-read.ts:162`), because a resource body is document-shaped and can be
far larger than a tool result; a `blob` is opaque to both.

**A6. Is a prompt a read or an action?** **Transport-wise a read; effect-wise neither of the two
existing classifications.** `getPrompt` is a plain `prompts/get` request (client `index.mjs:3648`;
core `:605-608`) returning `{ description?, messages: [{ role, content }] }` (core `:695-698`,
`:688-691`). Nothing mutates, no human is asked, no elicitation occurs — so it is not an action in
the transport sense and needs no approval round trip to be transport-safe. But what it returns is
**model instructions**, not data, while the taxonomy classifies _observable work_
(`packages/shared/src/pi-tool-effects.ts:1-9`) and the only registered MCP tool is
`mcp_read`/`external_read` (`pi-tool-effects.ts:162-169`). A prompt is a **read of instructions** —
neither `external_read` (not data) nor `external_mutation` (mutates nothing itself) — and it is the
one MCP surface that can steer the agent into a mutation the approval ledger would otherwise catch,
which is why the code's rule is that a mutation "is not a tool, it is an external action that a
person approves" (`mcp-extension.ts:41-44`). **Audit answer: a prompt is a read transport-wise, and
it must not be admitted under the existing `external_read` value without a human-approval path,
because its content becomes the model's instructions.**

---

## 3. Bucket verdict: **C — a new primitive is required**

- **Not A (harness parity).** Pi owns no MCP client; the whole MCP surface is Open-Inspect's own
  extension with one tool, `mcp_read` (`mcp-extension.ts:46-121`; `pi-tool-effects.ts:162-169`).
  There is nothing harness-side to be at parity with.
- **Not B (adapter/plumbing).** Plumbing is not the blocker — the _review surface_ is. Every
  artifact of the reviewed catalog is tool-shaped: table name (`0091:26`), stable-id derivation
  (`mcp-server-reviews.ts:187`), uniqueness (`0091:40`), schema columns (`0091:33-36`), snapshot
  table (`0091:45-59`), hash payload (`mcp-connections.ts:62-81`), the grant's `tool_names` column
  (`0094:19`), the gate's `toolNames` lists (`mcp-session.handler.ts:242`, `:348`), the audit's
  `tool_name` (`packages/control-plane/src/db/mcp-read-audit.ts:8`), and the effect enum
  (`0091:37`), which has no value for a prompt.
- **C.** A new reviewed-object kind is required (resources: a URI-keyed table; prompts: a table plus
  a new effect class plus an approval path), and the change is **forward-only**: the hash payload
  must widen, invalidating `mcp_connections.catalog_snapshot_sha256` and forcing re-review, re-stage
  and re-pin (A4).
- **D is the alternative the audit must name.** Projecting resources from the tools' review ("this
  server's tools were reviewed as reads ⇒ this server's resources are readable") is mechanically
  possible with **no** new table and is the cheapest path — but it replaces a human act over a named
  catalog with an inference over an unbounded, server-chosen URI space (templates: core `:454-466`).
  Adopted silently it is a boundary deviation: it widens a pinned surface
  (`mcp-connections.ts:56-61`; `0091:43-44`) without a reviewer.

**The single-tenant tension.** Open-Inspect is single-tenant: `mcp_servers` has no owner column
(`0018:2-14`) and the review is written by any holder of `mcp_servers.manage`
(`routes/mcp-servers.ts:186`), so the _tools'_ review is **already** a tenant-wide shared authority
and a personal connection only _stages_ it (`mcp-connections.ts:56-61`). A resource or prompt review
is therefore **not** a new kind of _shared authority_ — same reviewer, same permission, same
tenant-wide scope. What is new is the **reach**: the reviewed object stops being a named,
schema-bearing operation and becomes (a) a server-controlled URI space or (b) model instructions.
Under a single tenant "trusted" describes the _members_, not the _servers_: the deployment's own
server is already trusted to answer tool calls, but it is not currently trusted to hand the model
instructions, nor to serve an unenumerated URI space **through a user's OAuth credential** (the
personal lane). That — not the reviewer — is the new authority.

**Decisive question answered.** _Could the resources be projected from the tools' review without a
new review kind?_ **No for prompts; only as a deviation for resources.**

- _Prompts_: there is no projection. A prompt is unrelated to any tool; the only available rule is
  "server reviewed ⇒ prompts admitted", which hands an external server the ability to write the
  model's instructions for every session that can reach the server — a strictly higher authority
  than a data read, and one that can route the agent into a mutation the approval ledger would
  catch. Prompts need a new review kind, a new effect class, and an approval path.
- _Resources_: the projection is mechanically available (no new table; only a `listResources` /
  `readResource` call path plus the existing guard and bound), but it is a _projection_, not a
  review: no reviewer ever enumerated a URI, the URI space is unbounded, and it widens the pinned
  surface without a human act. It is legitimate **only** as an explicit, documented tenant-wide rule
  with a re-review of the server revision — and then only for the shared lane; in the personal lane
  it would expose the owner's OAuth account through an unenumerated URI space, which the current
  design deliberately prevents.

---

## 4. Options for a human to choose

| #   | Option                                        | What it means                                                                                                                                                                                                                            | Cost                                                                                                                                                                                                                                        |
| --- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Full new review kind**                      | New tables `mcp_reviewed_resources` (URI-keyed, mimeType, body bound) and `mcp_reviewed_prompts`; widened hash payload; new effect class for prompts; prompts behind an approval path; re-review + re-stage + re-pin of every connection | Largest. Forward-only. Touches `0091`/`0094`, `mcp-server-reviews.ts`, `mcp-connections.ts`, the hash, the pin, the broker, the gate, the audit, the Pi extension. ~800–1000 lines incl. tests, plus a human-in-the-loop design for prompts |
| 2   | **Resources only, enumerated**                | New table `mcp_reviewed_resources`; hash widened over resources; prompts stay out of the product                                                                                                                                         | Medium. Still forward-only (re-review + re-pin). ~500 lines incl. tests. Leaves prompts permanently unreviewed                                                                                                                              |
| 3   | **Resources by projection, shared lane only** | No new table. Rule: a server revision with ≥1 reviewed `external_read` tool admits that server's resources; personal lane excluded; hash stays tools-only (resources unpinned)                                                           | Smallest. No migration. But it breaks the stated pin invariant, leaves resources outside the hash, and the URI space is unbounded. Bucket **D** if adopted silently, **C** if adopted as an explicit documented rule                        |
| 4   | **Do nothing**                                | The reviewed surface stays tools-only; Open-Inspect offers no reviewed resource/prompt path                                                                                                                                              | Zero. The reviewed boundary stays as it is; agents needing resources reach them outside Open-Inspect's review                                                                                                                               |
| 5   | **Prompts only, behind the approval ledger**  | Treat a prompt as an external action: durable human approval before its messages enter the model                                                                                                                                         | Heavy and product-wise dubious (every prompt use waits for a human), but it is the only option that keeps prompt instructions out of the model without a reviewer-curated allowlist. ≥300 lines plus a DO-durable approval design           |

**Recommendation to put to the human**: options 2 and 4 are the honest pair — a _reviewed_ resource
surface is a new kind with a real cost, and until someone asks for it, the tool-only review is
already a coherent boundary. Option 3 is available as a cheap shared-lane-only concession but must
never be applied to the personal lane, where it would put the owner's OAuth credential behind a
server-chosen URI.

---

## 5. UNVERIFIED

1. **No execution.** That a widened hash makes `listOwned` throw for every existing connection is
   read from code (`mcp-connections.ts:174-181`) and was **not** reproduced by running the suite.
2. **Migration size is unknown.** No data access: the number of live `mcp_connections`,
   `mcp_reviewed_tools` and `mcp_session_pins` rows in any deployment — and therefore the real cost
   of the re-review/re-pin — is unmeasured.
3. **The Agents MCP manager's surface is unverified.** I read `@modelcontextprotocol/client`'s
   `Client` only. Whether `agents/mcp/client`'s `MCPClientManager` exposes
   `readResource`/`getPrompt` on the broker's connection object was **not** inspected; the broker
   today calls only `this.mcp.callTool` (`mcp-connection-durable-object.ts:215`).
4. **SDK version.** Claims about `readResource`/`getPrompt` are for `@modelcontextprotocol/client`
   2.3.1 (`node_modules/@modelcontextprotocol/client/package.json:3`); other versions may differ.
5. **No server inventory.** Whether any server the tenant can reach actually serves resources or
   prompts worth reviewing is unknown; the product case for options 1/2/5 is unproven.
6. **Web review UI.** Grep shows no `/mcp-servers/:id/review` call in `packages/web/src`, so the
   review is currently an API-only act — but the settings component was not read line by line.
7. **Grant-name validation.** `McpSessionPinStore.grant` does not check that the granted `toolNames`
   exist in the connection's snapshot (`assertReviewableToolNames` only checks the name shape,
   `mcp-session-pins.ts:49-56`); the broker catches it later
   (`mcp-connection-durable-object.ts:184-192`). Noted, not verified by test.
8. **Resource caching in the broker path.** The SDK client caches `resources/read` by
   `{method, uri}` partitioned by scope
   (`node_modules/@modelcontextprotocol/client/dist/index.mjs:3912-3923`); how that behaves behind
   the manager in a Durable Object is unverified.

---

## 6. Sized implementation plan (if option 1 or 2 is accepted)

**Slice A — the review surface** ≈ 150 lines + 1 migration

1. New migration `009X_mcp_reviewed_resources.sql`:
   `mcp_reviewed_resources(server_id, server_revision, resource_uri, mime_type, description, max_bytes, reviewed_by_user_id, reviewed_at, UNIQUE(server_id, server_revision, resource_uri))`.
   If templates are in scope, add `is_template` rows plus a bound on the `uriTemplate`.
2. `McpServerReviewStore`: add `resources` to `McpServerReview` and `review()`
   (`mcp-server-reviews.ts:23-29`, `:72-127`), keeping the whole-revision replace semantics
   (`:92-118`) and the revision guard (`:83-87`).
3. Shared types: `mcpServerReviewInputSchema` is `.strict()`
   (`packages/shared/src/types/mcp-read.ts:30-35`) → add `resources: z.array(...).default([])`; add
   a review-view schema mirroring `mcpServerReviewViewSchema` (`:40-55`).
4. Route: the existing `PUT /mcp-servers/:id/review` (`routes/mcp-servers.ts:292-294`) carries the
   new field; the GET view (`:274-290`) returns it. No new route, no new permission.

**Slice B — the pin and the hash** (the forward-only part) ≈ 120 lines + 1 migration 5.
`catalogSnapshotSha256` (`mcp-connections.ts:62-81`) gains a `resources` array in the hashed
payload. **This changes every stored hash** — plan the backfill before shipping it. 6. Backfill
migration `009Y_mcp_hash_v2.sql`: recompute `mcp_connections.catalog_snapshot_sha256` from the
current snapshot rows under the new function so `listOwned` does not throw
(`mcp-connections.ts:174-181`). For `mcp_session_pins.catalog_snapshot_sha256` (`0094:15`), either
backfill to the new value or revoke the pins and require re-pinning — the human picks: silent re-pin
(best effort) versus an explicit re-pin prompt, which the route already supports
(`routes/mcp-session-pins.ts:70`). 7. New table `mcp_connection_resource_snapshots`, mirroring
`mcp_connection_tool_snapshots` (`0091:45-59`): PK `(connection_id, resource_uri)`, `mime_type`,
`max_bytes`, `effect CHECK (effect = 'external_read')`. `McpConnectionStore.create` copies the
reviewed resources alongside the tools (`mcp-connections.ts:270-331`).

**Slice C — the gate and the broker** ≈ 200 lines 8. Broker: add `callResource` next to `callTool`
(`mcp-connection-durable-object.ts:163-197`) with the same three rechecks (identity, owner/status,
reviewed snapshot) and a lookup in the new snapshot table. 9. Shared lane:
`reviewedReadOnlyToolNames` (`components.ts:1721-1735`) gains a sibling for resources, used at
`:823` and `:849` exactly as the tool list is. 10. Read gate: `mcpReadRequestSchema` is `.strict()`
with one target and one `toolName` (`packages/shared/src/types/mcp-read.ts:111-133`) → add a `kind`
discriminator; the checks at `:242-259` and `:348-365` become kind-appropriate; the credential guard
and the bound are applied to the resource `contents` array at `:282-306` / `:395-422` — **no new
guard** (A5). 11. Audit: `McpReadAuditStore` records `tool_name` (`mcp-read-audit.ts:8`) → a
resource read needs a `resource_uri` column or metadata field, plus new reason codes
(`mcp_resource_not_reviewed`, `mcp_resource_read`).

**Slice D — the Pi surface** ≈ 80 lines 12. The extension has exactly one tool
(`mcp-extension.ts:46-121`). A second tool (`mcp_read_resource`) or a `kind` argument needs a new
registration in `PI_MCP_TOOL_EFFECT_REGISTRATIONS` (`pi-tool-effects.ts:162-169`, effect
`external_read`, replay `safe`); the shared registry rejects shadowing
(`pi-tool-effects.ts:172-183`).

**Slice E — tests** ≈ 250 lines 13. `mcp-session.handler.test.ts` (resource cases, both lanes, guard
and bound); `test/integration/mcp-connections.test.ts` (hash-v2 backfill, resource snapshot, the
`catalog_snapshot_sha256` expectation at `:92`); `mcp-session-pins.test.ts` (hash comparison).

**Slice F — prompts (only if chosen)** — a separate decision, ≥300 lines plus a durable
human-in-the-loop design. Do not fold prompts into Slices A–D.

**Ordering constraint**: Slice B's backfill must land before Slice A's new review rows exist, and
the whole set must be one deployment — a half-deployed hash change breaks `listOwned` for every
connection.

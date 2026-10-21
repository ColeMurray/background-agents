# The owner's half of the MCP OAuth lifecycle — audit and design

Branch: `feat/pi-mcp-oauth` (from `feat/pi-go-live-integration-v2` @ `a6ab76de`). Brief:
`features/pi-first-class/PI-REMAINING-AUDIT-BRIEFS.md`, section 5.

The audit reads the code as it stood at `a6ab76de`. Every "original" line number below is that
commit; every "now" line number is this branch. The repo's own documents are claims, and the places
where they disagree with the code are named in the last section.

---

## 1. The audit

### 1.1 The surfaces, as they actually are

| Surface                                                                  | What the code says                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/control-plane/src/routes/mcp-connections.ts`                   | Four owner routes: list, create, get, delete — plus the server's OAuth callback. All behind one `OWNER_ROUTE` (`:22-26`) that is `SCM_AGNOSTIC_HUMAN_USER_ROUTE` + `ACTIVE_SELF` + `private, no-store`.                                                          |
| `packages/control-plane/src/mcp/connection-saga.ts`                      | The create/revoke saga (`:21-66`). `create` (`:21-50`) compensates a failed broker initialization; `revoke` (`:52-61`) checkpoints `revoking` before the broker is torn down.                                                                                    |
| `packages/control-plane/src/db/mcp-connections.ts`                       | The metadata store. Two status writes only: the `foundation_staged` insert (`:294`) and `markRevoking` (`:220-230`). `deleteRevoking` (`:232-240`) removes the row.                                                                                              |
| `packages/control-plane/src/cloudflare/mcp-connection-durable-object.ts` | The broker. `Lifecycle.install(this).use(this.mcp)` (`:76`), `initialize` (`:86-122`), `status` (`:116-161`), `callTool` (`:163-197`), `handleCallback` (`:273-275`), `destroy` (`:288-327`).                                                                    |
| `packages/control-plane/src/mcp/broker-contract.ts`                      | The port. `McpConnectionBrokerStatus` (`:10-25`) already declares `authUrl?` and `state?`; the port already declares `status(connectionId)` (`:53`) and `handleCallback` (`:69`).                                                                                |
| `packages/control-plane/src/cloudflare/mcp-connection-dispatch.ts`       | The Cloudflare adapter. `status` is wired (`:16`) and **nothing in the product calls it** (see 1.4).                                                                                                                                                             |
| `terraform/d1/migrations/0092_mcp_oauth_foundation.sql`                  | `mcp_connections.status` (`:13-15`) already allows `foundation_staged, revoking, transport_ready, oauth_authorizing, oauth_ready, failed, revoked`. `mcp_oauth_storage` (`:63-69`) is the encrypted credential authority, cascading from the connection (`:64`). |

### 1.2 Question 1 — what is the owner's flow today? Does the owner ever learn the connection is waiting for an approval?

**No. There is no owner flow for the authorization at all.**

The chain, end to end, at `a6ab76de`:

1. `POST /mcp-connections` → `createConnection` (`routes/mcp-connections.ts:50-78`) →
   `McpConnectionSaga.create` (`mcp/connection-saga.ts:21`) → `McpConnectionStore.create`
   (`db/mcp-connections.ts:242-343`), which inserts the row with `status = 'foundation_staged'`
   (`db/mcp-connections.ts:294`) → `broker.initialize`.
2. `initialize` (`cloudflare/mcp-connection-durable-object.ts:86-122`) writes the DO's identity keys
   and rechecks D1. **It opens no transport and produces no authorization URL.**
3. The server is first contacted when a _reviewed read_ happens: `callTool` (`:163-197`) →
   `callReviewedTool` (`:206-224`) → `ensureServerRegistered` (`:233-255`) → `registerServer` +
   `connectToServer` (`:249`).
4. `connectToServer` returns `{state: "authenticating", authUrl}` when the server wants the owner's
   approval (`node_modules/agents/dist/client-BnYbNT3z.js:1935-1948`; the discriminated union is
   `node_modules/agents/dist/agent-routing-BMvWTFEp.d.ts:2703-2717`). **The broker throws that
   result away:** `ensureServerRegistered` only tests `connected.state !== "connected"` and throws
   `"MCP connection is not authorized yet"` (`:250-253`). The `authUrl` never leaves the manager.
5. The owner's only view is `GET /mcp-connections` → `listConnections`
   (`routes/mcp-connections.ts:28-37`) → `McpConnectionStore.listOwned`
   (`db/mcp-connections.ts:143-185`), whose `status` is the raw row value. The web client renders
   that raw enum next to the host
   (`packages/web/src/components/settings/mcp-servers-settings.tsx:512`).

So the answer to "does the owner ever learn the connection is waiting for an approval?" is **no**,
and the reason is structural: the authorization URL is produced inside a tool call, in a Durable
Object, and is discarded by the code that receives it. Nothing in the product asks the broker for
it.

The `authUrl` and `state` fields already exist on the port (`mcp/broker-contract.ts:22-24`) and the
`status()` method already exists (`:53`) — they were declared for exactly this and never wired to a
route.

**And `status()` was lying.** Original `status()` returned a hard-coded
`{enabled: false, transportCacheEntries: 0, reason: "Live MCP transport is not enabled"}`
(`cloudflare/mcp-connection-durable-object.ts:145-152`) regardless of what the manager held, and
never returned `authUrl` or `state` even though the port declares them. The class docstring above it
(`:36-45`) said "The manager deliberately is not installed on a Lifecycle yet: no persisted
registration is restored, no callback is accepted, and no network connection or tool call can start
in this slice" — contradicted by the code four lines below it (`:76`,
`Lifecycle.install(this).use(this.mcp)`), by `handleCallback` (`:273-275`), and by
`ensureServerRegistered`'s live connect (`:233-255`). The transport **is** installed; the
documentation and the status report are what are dormant.

### 1.3 Question 2 — refresh: the encrypted OAuth provider stores the token; who refreshes it, and when?

The provider is `EncryptedMcpOAuthClientProvider` (`mcp/encrypted-oauth-provider.ts:148-158`), an
`EncryptedMcpOAuthClientProvider` over `DurableObjectOAuthClientProvider` with `D1McpOAuthStorage`
as its key-value surface (`mcp/encrypted-oauth-provider.ts:26-145`). Every value it writes is
AES-256-GCM with the connection id and the storage key as additional authenticated data (`:45-64`),
and the keyring is rotatable (`mcp/oauth-keyring.ts:41-97`, `:118-127`).

**Who refreshes:** the MCP SDK, not Open-Inspect. `auth()` refreshes when the stored tokens carry a
`refresh_token` (`node_modules/@modelcontextprotocol/client/dist/index.mjs:797-830`); the refresh is
triggered by the transport's 401 handling, which routes through `adaptOAuthProvider` →
`handleOAuthUnauthorized` → `auth()` (`index.mjs:285`, `:252-266`, `:4743-4777`). The refreshed
token set is written back through `provider.saveTokens`
(`node_modules/agents/dist/mcp/client/do-oauth-client-provider.js:95-99`), i.e. encrypted into D1
again.

**When:** lazily, on the next use of the transport. The broker opens the transport only from
`ensureServerRegistered` (`cloudflare/mcp-connection-durable-object.ts:233-255`), i.e. inside a
reviewed read, and the manager also reconnects when it restores a persisted registration on a cold
start (`node_modules/agents/dist/client-BnYbNT3z.js:1300-1310`, `:1618-1666`). **There is no
proactive refresh, and no owner-facing refresh or reconnect action.**

Two consequences that matter to the owner:

- A refresh token is only requested at all when the authorization server advertises `offline_access`
  (`index.mjs:667`). If it does not, the credential cannot be refreshed and the owner has to
  re-approve.
- When a refresh _fails_ with an OAuth error, the SDK throws rather than falling back to a new
  authorization (`index.mjs:808-812`), so `connectToServer` returns `failed` and the connection is
  stuck: the owner had no way to discard the dead credential and start again. (The SDK's own
  `auth()` wrapper does recover from `invalid_grant` by invalidating the tokens and retrying —
  `index.mjs:644-668` — but the agents' provider is only reached through the transport's
  `onUnauthorized`, which the agents SDK never installs: `onUnauthorized` appears nowhere in
  `node_modules/agents/dist/`. The recovery therefore does not fire in this deployment.)

### 1.4 Question 3 — revoke and tombstone: is a refresh token left anywhere after a revoke?

**No refresh token survives a revoke.** `McpConnectionSaga.revoke` (`mcp/connection-saga.ts:52-61`)
checkpoints `revoking` in D1, then the broker's `destroy`
(`cloudflare/mcp-connection-durable-object.ts:288-327`) closes every transport (`:315`), deletes
**every** `mcp_oauth_storage` row for the connection (`:317-319`), wipes the DO's key-value storage
(`:320`) and writes the tombstone (`:321-324`). The saga then deletes the `mcp_connections` row
(`db/mcp-connections.ts:232-240`), which cascades to `mcp_oauth_storage`
(`0092_mcp_oauth_foundation.sql:64`) and to `mcp_connection_tool_snapshots` (`:46`) and to
`mcp_session_pins` (`0095_mcp_session_pins.sql:12`). The tombstone refuses any later `initialize`
(`:81-83`) and any later `destroy` for a different connection or owner (`:289-295`, `:300-305`).

**One thing survives, and it is not a credential.** The manager persists its registration in the
Durable Object's **SQLite** table `cf_agents_mcp_servers`
(`node_modules/agents/dist/client-BnYbNT3z.js:1014-1026`, `:1354-1359`), not in the DO's key-value
storage. `ctx.storage.deleteAll()` clears only key-value storage, so that row survived a revoke. Its
columns are `id, name, server_url, callback_url, client_id, auth_url, server_options`
(`client-BnYbNT3z.js:1016-1024`): the endpoint, Open-Inspect's own callback URL, the dynamically
registered `client_id`, and the authorization URL (which carries a PKCE challenge and a single-use
state nonce, not a token). No credential — but a revoked connection left a registration behind.

**And the revoke did not revoke the grants.** `McpSessionPinStore.revokeAllForConnection` exists
(`db/mcp-session-pins.ts:203-212`) and is tested (`db/mcp-session-pins.test.ts:172`) but **nothing
calls it** — the saga's authority interface has no such step (`mcp/connection-saga.ts:4-10`). The
grant rows stay `active` after the connection is gone. They are inert (the broker refuses a
`revoking`/`revoked` connection, `:180-182`, and the grant list skips a connection that no longer
resolves, `routes/mcp-session-pins.ts:119-120`), but they are stale rows that outlive their subject.

### 1.5 Question 4 — what does the web client show for `foundation_staged` versus an authorized connection? Is there a state for "waiting for the owner"?

**The web client shows the raw enum, and there is no "waiting for the owner" state in practice.**

Original `PersonalMcpConnections`
(`packages/web/src/components/settings/mcp-servers-settings.tsx:447-548`) rendered
`{connection.endpointHost} · {connection.status} · {connection.tools.length} reviewed read-only tools`
(`:512`) — the literal `foundation_staged` string — under a heading that called the whole thing
"Dormant personal connections" (`:485`), with the only actions being "Stage …" (`:534`) and "Remove"
(`:563-572`). There was no way to start an authorization, and no way to see one waiting.

**The state exists in the schema and is never written.** `mcpConnectionStatusSchema`
(`packages/shared/src/types/integrations.ts:720-728`) and the D1 `CHECK` constraint
(`0092_mcp_oauth_foundation.sql:13-15`) both already allow `transport_ready`, `oauth_authorizing`,
`oauth_ready` and `failed`. A grep over the whole repository for those four values finds only the
schema, the migration, the shared test, and the route-catalog test — **no writer**. The only two
writers are `foundation_staged` (`db/mcp-connections.ts:294`) and `revoking` (`:223`). The states
were named for this feature and left empty.

### 1.6 The states that need to exist

| Durable state (`mcp_connections.status`) | Meaning                                                                                      | Who writes it                                              |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `foundation_staged`                      | The connection exists; the owner has never approved the server.                              | The saga, at create (`db/mcp-connections.ts:294`).         |
| `oauth_authorizing`                      | The server is waiting for the owner's approval. The owner has an outstanding act to perform. | The broker, when the server asks for an authorization.     |
| `oauth_ready`                            | The owner approved the server; the credential is stored (encrypted in D1).                   | The broker, when the callback is redeemed.                 |
| `transport_ready`                        | The transport is connected and no credential is needed.                                      | The broker, when the server connects without an approval.  |
| `failed`                                 | The last attempt to establish the transport or the authorization did not complete.           | The broker.                                                |
| `revoking` / `revoked`                   | The owner is removing the connection.                                                        | The saga, at revoke (`db/mcp-connections.ts:223`, `:235`). |

The transport's own state (`authenticating`, `connecting`, `connected`, `ready`, `failed`) is a
separate, short-lived thing: it is what the broker observes right now. It is not a durable status,
and it must not be persisted as one — a connection that is merely connecting has told the owner
nothing.

### 1.7 Unverified

These could not be established from the code, and are **not** assumed anywhere in the design:

- Whether `WORKER_URL` equals the browser-visible origin of the control-plane worker in a real
  deployment. The callback is only recognized when the stored callback URL's origin **and** pathname
  equal the request's (`node_modules/agents/dist/client-BnYbNT3z.js:1962-1977`), and the stored
  callback URL is built from `WORKER_URL` (`cloudflare/mcp-connection-durable-object.ts:34-38`).
  Terraform sets `WORKER_URL = local.control_plane_url`
  (`terraform/environments/production/workers-control-plane.tf:104`), but whether that is the origin
  the browser is redirected to is a deployment fact.
- Whether any deployment has ever run the live MCP canary against a real OAuth-protected MCP server.
  The repository contains the code and the mocked integration test, and no evidence of a live run.
- Whether `MCP_CONNECTIONS_ENABLED` is `"true"` in any real deployment. The code requires it
  (`mcp/feature.ts:3-7`); the runtime value is not in the repository.
- Whether the `mcp_oauth_keyring` table has ever been rotated in a real deployment. The rotation
  code exists (`mcp/oauth-keyring.ts:75-96`); no rotation record exists.
- Whether real MCP authorization servers issue a refresh token. The SDK only asks for
  `offline_access` when the server advertises it (`index.mjs:667`); whether servers do is not
  observable here.
- Whether the sessions that consume a personal MCP connection today actually exercise the broker's
  `callTool` in production. No test in the repository drives `callTool` end to end.

---

## 2. The design

### 2.1 The reuse, exactly

| What the owner's half needs                                               | What already exists                                                                        | Where                                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| The owner's authority over their own connection                           | `OWNER_ROUTE` = human user + `ACTIVE_SELF` + `private, no-store`                           | `routes/mcp-connections.ts:22-26`                                       |
| The owner's connection, resolved by owner                                 | `McpConnectionStore.getOwned` / `getOwnedForSaga` (owner-scoped `WHERE owner_user_id = ?`) | `db/mcp-connections.ts:187-205`                                         |
| The orchestration of "metadata + broker"                                  | `McpConnectionSaga`                                                                        | `mcp/connection-saga.ts:15-66`                                          |
| The broker's status port, with `authUrl` and `state` already declared     | `McpConnectionBrokerStatus`, `status(connectionId)`                                        | `mcp/broker-contract.ts:10-25`, `:53`                                   |
| The server's OAuth callback, owner-only                                   | `GET /mcp/oauth/callback/:id` → `MCP_CONNECTION.handleCallback`                            | `routes/mcp-connections.ts:95-105`, `:114`                              |
| The durable state names                                                   | `mcpConnectionStatusSchema` + the D1 `CHECK`                                               | `packages/shared/src/types/integrations.ts:720-728`; `0091:13-15`       |
| The encrypted credential store and the rotatable keyring                  | `EncryptedMcpOAuthClientProvider`, `D1McpOAuthStorage`, `D1McpOAuthKeyring`                | `mcp/encrypted-oauth-provider.ts:26-158`; `mcp/oauth-keyring.ts:41-127` |
| The agent-facing roster (must **not** grow)                               | `grants()` — names, host, tool names only                                                  | `session/components.ts:794-813`                                         |
| The owner's place in the web app                                          | `/settings?tab=mcp-servers`                                                                | `packages/web/src/components/settings/settings-registry.ts:262-274`     |
| "Reconnect" as Open-Inspect's own word for replacing a refused credential | the provider-authorization ledger's `operation: "reconnect"`                               | `db/provider-account-authorizations.ts:10`, `:84-89`                    |

**No new table. No new column. No new migration. No new scope. No new auth path.**

### 2.1a Why the external-action approval ledger is not the surface here

The brief points at "the existing pending/approval surfaces". The external-action ledger
(`packages/control-plane/src/session/external-action-gateway.ts`) is the wrong one, for a reason
that is about authority rather than convenience: an external action is an **agent-proposed** effect
that waits for a human to approve it, and it is scoped to a session and to the session's
collaborators. The MCP authorization is the **owner's own act** over their own account resource:
there is no agent proposal in it, and no collaborator may inherit it. Putting it in the session's
approval ledger would put a per-account credential behind a per-session, collaborator-visible
surface — exactly the widening the personal lane is supposed to prevent
(`features/pi-first-class/STATE-AND-HANDOVER.md:189-198`).

The pending surface that already exists for an owner's own OAuth is the connection's own durable
status, and it is already shaped for this: the D1 `CHECK` names `oauth_authorizing` and
`oauth_ready` (`0092_mcp_oauth_foundation.sql:13-15`), and the shared enum names them
(`packages/shared/src/types/integrations.ts:720-728`). The only thing missing was the writer, and
the owner reading it. The provider-account authorization ledger
(`db/provider-account-authorizations.ts`) is the closest shape elsewhere in the codebase — a
per-user, per-provider OAuth lifecycle with `initiating/pending/processing/connected/…` states and
an explicit `reconnect` operation — and this change borrows its vocabulary (`reconnect`) without
forking its table: its rows are model-provider rows, and an MCP connection is not a model provider.

### 2.2 What is new

- One owner route: `POST /mcp-connections/:id/authorize`, behind the existing `OWNER_ROUTE`.
- One saga step: `McpConnectionSaga.authorize`, which resolves the connection by the owner's
  authority and then calls the broker.
- One broker port method: `authorize(connectionId, ownerUserId, {reconnect?})`, returning
  `{state, authUrl?}`.
- One store method: `McpConnectionStore.setTransportStatus`, the only writer of the four transport
  states, owner-scoped and refusing to overwrite a revocation in flight.
- Shared contract additions: `McpConnectionTransportState`, `McpConnectionAuthorization`,
  `mcpConnectionAuthorizeInputSchema`.
- Web: an "Authorize" / "Reconnect" action and the owner's wording for each state.

### 2.3 The bucket

**Bucket B — adapter/plumbing.** The owner's half needed a route, a saga step, a broker method and a
status writer. Every authority, every state name, every store and every encryption path already
existed.

**No new primitive is required.** The single-tenant tension named in the brief does not bite here,
because the per-user external credential is _already built_: `mcp_connections` is per-account
(`owner_user_id`, `0091:6`), `mcp_oauth_storage` is per-connection and encrypted (`0091:63-69`), the
grant is the owner's own non-delegable act (`db/mcp-session-pins.ts:105-110`), and the session's own
authority decides whether a session may use it at all (`routes/mcp-session-pins.ts:136-147` →
`requireSession("collaborate")`). This feature completes the lifecycle of an existing primitive; it
does not introduce one. The single-tenant question that _does_ remain open is the one the brief
names for the other features: whether a per-user external credential is acceptable at all in a
single-tenant product. That decision was already taken for the personal MCP lane
(`features/pi-first-class/STATE-AND-HANDOVER.md:189-198`) and this change does not widen it.

### 2.4 The boundary check, decision by decision

| Decision                                   | Boundary                                                   | Verdict                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who may authorize a connection?            | The owner's own authority over their own account resource. | `OWNER_ROUTE` (`authentication: user`, `authorization: active-self`) + `getOwned(id, userId)` + the broker's own D1 recheck. A service principal is refused (integration test: 403). A second owner is refused (integration test: 404).                                                                                                                                 |
| Does a collaborator inherit it?            | No.                                                        | A grant to a session is a separate, explicit, non-delegable act (`db/mcp-session-pins.ts:105-110`) and the session's own `collaborate` authority decides (`routes/mcp-session-pins.ts:136-147`). The authorization URL is never in the session's roster (`session/components.ts:794-813`).                                                                              |
| What reaches the browser?                  | The server's own authorization URL — never a credential.   | The broker returns `{state, authUrl}`; the URL is the server's consent URL (client id, PKCE challenge, single-use state nonce). The token is written by the SDK into the encrypted D1 store and never crosses the broker's boundary. The URL is only handed over when it is an **HTTPS** page: a server that names a plaintext page or a script URL gets no URL at all. |
| What reaches the agent?                    | A bounded, credential-free result.                         | Unchanged. The authorize action is an owner action on an owner route; the agent's roster is untouched.                                                                                                                                                                                                                                                                  |
| Where does the state live?                 | D1 is the authority.                                       | `mcp_connections.status`, an existing column with an existing `CHECK`, written only through the owner-scoped store method.                                                                                                                                                                                                                                              |
| Does the credential ever leave the broker? | No.                                                        | `EncryptedMcpOAuthClientProvider` over `D1McpOAuthStorage`; the broker never returns the token, and the provider's own error string never leaves either (`cloudflare/mcp-connection-durable-object.ts:220-222`).                                                                                                                                                        |

---

## 3. What was implemented, and the findings

### 3.1 The owner's half, end to end

```
owner clicks "Authorize"
  → POST /mcp-connections/:id/authorize          (OWNER_ROUTE: human user, active-self)
    → McpConnectionSaga.authorize                (resolves the connection by the owner's authority)
      → broker.authorize(id, ownerUserId)        (rechecks the DO identity and the D1 authority)
        → register + connect                     (the server's own endpoint from D1)
        → the server wants an approval:
             the broker returns the server's authorization URL
             and records `oauth_authorizing` in D1
  ← {state: "authenticating", authUrl}           (a URL, never a credential)

owner visits the URL → the server redirects to GET /mcp/oauth/callback/:id   (OWNER_ROUTE)
  → broker.handleCallback                        (the manager redeems the code)
    → the SDK writes the token set, encrypted, into mcp_oauth_storage
    → the broker records `oauth_ready` in D1
  ← 302 to <WEB_APP_URL>/settings?tab=mcp-servers

the owner's own view (GET /mcp-connections) reads the durable state from D1
```

The states the owner can see: _Not authorized yet_ → _Waiting for your approval_ → _Authorized_ /
_Connected_ / _Could not connect_. A connection in the last state offers **Reconnect**, which
discards the stored credential and starts a fresh authorization — the owner's explicit act, and the
only way a credential the provider has refused can be replaced (1.3).

### 3.2 The changes

| File                                                                                                                                                                                 | Change                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/types/integrations.ts`                                                                                                                                          | `mcpConnectionTransportStateSchema`, `McpConnectionAuthorization`, `mcpConnectionAuthorizeInputSchema`.                                                                                                                                                                                                                                                       |
| `packages/control-plane/src/mcp/broker-contract.ts`                                                                                                                                  | `authorize` on the port; the status's `state` typed by the shared contract; `enabled` documented as "the connection can be read through right now".                                                                                                                                                                                                           |
| `packages/control-plane/src/db/mcp-connections.ts`                                                                                                                                   | `MCP_TRANSPORT_STATUSES`, `McpTransportStatus`, `McpConnectionStore.setTransportStatus` (owner-scoped; never overwrites a revocation in flight).                                                                                                                                                                                                              |
| `packages/control-plane/src/mcp/connection-saga.ts`                                                                                                                                  | The `authorize` step.                                                                                                                                                                                                                                                                                                                                         |
| `packages/control-plane/src/routes/mcp-connections.ts`                                                                                                                               | `POST /mcp-connections/:id/authorize`, behind the existing owner route.                                                                                                                                                                                                                                                                                       |
| `packages/control-plane/src/cloudflare/mcp-connection-durable-object.ts`                                                                                                             | The broker's `authorize`; a truthful `status`; the callback's outcome recorded in D1 and the owner redirected to the web app; the transport split into _register_ and _open_; the lifecycle started before the manager's storage is used; the agents' SQLite registration removed on revoke; the authorization URL only handed over when it is an HTTPS page. |
| `packages/control-plane/src/cloudflare/mcp-connection-dispatch.ts`                                                                                                                   | The new port method wired to the Durable Object.                                                                                                                                                                                                                                                                                                              |
| `packages/web/src/hooks/use-mcp-connections.ts`, `packages/web/src/app/api/mcp-connections/[id]/authorize/route.ts`, `packages/web/src/components/settings/mcp-servers-settings.tsx` | The owner's action and the owner's wording.                                                                                                                                                                                                                                                                                                                   |

### 3.3 Findings in the code the audit read — and what was done about them

**F1 — the broker's manager-dependent RPC methods used the manager's SQLite before the lifecycle had
created the table. (bucket D, fixed)** `MCPClientManager.onStart` creates `cf_agents_mcp_servers`
(`node_modules/agents/dist/client-BnYbNT3z.js:1300-1307`), and the lifecycle only starts on a
runtime `fetch`/`alarm` (`node_modules/agents/dist/lifecycle-DGorpAmA.js:995-1003`, `:1264-1275`). A
Durable Object **RPC** method bypasses the runtime's fetch entry point, so `callTool` →
`registerServer` → `saveServerToStorage` (`client-BnYbNT3z.js:1354-1359`) hit a table that did not
exist yet. The personal MCP read path was dead on a cold broker unless something had served a fetch
first. The fix is unambiguous — the lifecycle's startup is explicit before the manager is used
(`ensureStarted()`), and the lifecycle shares one startup between concurrent callers.

**F2 — `assertMcpEgress` exists, is tested, and is never called. (bucket D, reported, not fixed)**
`mcp/egress-policy.ts:35-56` refuses a reviewed host that resolves to a private address. The
handover record lists the commit that added it as "Browser gateway, MCP OAuth keyring, **DNS and
redirect-safe egress**" (`features/pi-first-class/STATE-AND-HANDOVER.md:88`), so the repository
claims the egress work was done. A grep over `packages/` finds no production caller: the function is
referenced only by its own test. The broker connects to `mcp_connections.endpoint_url`, which was
validated at create time for scheme, credentials, port, query and _literal_ private addresses
(`mcp/remote-url-policy.ts:50-95`) but not for what the name resolves to. The agents SDK adds its
own literal-address check (`node_modules/agents/dist/client-BnYbNT3z.js:1173-1210`), not a DNS
check. _Exploit scenario:_ an account holding `mcp_servers.manage` points a remote MCP server row at
a hostname that resolves to an address inside the deployment's network (a link-local metadata
address, or an internal service exposed under a public-looking name). The broker's transport
connects to it from the Worker's network position, with the deployment's egress rules applied and
not the operator's host list. _Why it is not fixed here:_ the unambiguous fix needs a production DNS
resolver, and the Workers runtime exposes none — `McpEgressPolicy.resolve` is an injected dependency
("The production resolver is the platform's own DNS", `mcp/egress-policy.ts:17-19`) and no
production implementation exists. Choosing a resolver, or deciding that the Worker's own egress
boundary is the guard, is a product decision, not an adapter.

**F3 — a revoked connection left the manager's registration in the Durable Object's SQLite. (low,
fixed)** `ctx.storage.deleteAll()` clears key-value storage only; the `cf_agents_mcp_servers` row
survived. It holds no credential, but the owner removed the connection and expected nothing to be
left. The broker now removes the server from the manager (`removeServer`), which closes the
transport, clears the provider's storage and deletes the row.

**F4 — a revoke left the session's grants `active`. (low, reported)**
`McpSessionPinStore.revokeAllForConnection` (`db/mcp-session-pins.ts:203-212`) has no caller. The
grants are inert (the broker refuses a revoked connection and the roster skips a connection that no
longer resolves), so this is hygiene rather than authority, and it is outside the owner's
_authorization_ half. Adding it to the saga would change the revocation's compensation shape, which
is a separate decision.

**F5 — the broker's `status()` reported a fiction. (fixed)** 1.2.

**F6 — the class docstring said the transport was not installed. (fixed)** It was, since `1d05cfe5`.

**F7 — the broker's status and its reads needed the lifecycle's startup. (fixed, with F1)** The same
defect as F1, seen from the other side: `status()` read the manager's registration table without the
lifecycle having started, and the read path could not tell an owner-waiting connection from a dead
one. Both are now explicit, and the read path records the state it observed before it refuses, so a
connection that is waiting on its owner is never silently "not ready".

---

## 4. Where this reading differs from the repo's own documents

1. **`STATE-AND-HANDOVER.md:414-418`** says "Still open in Slice 8: the live transport. The broker's
   authorization is complete and tested, but the transport itself is not installed". The transport
   _is_ installed (`cloudflare/mcp-connection-durable-object.ts:76`, `:233-255`), and the same
   file's "What is still open, in order" (`:481-485`) says so. The two paragraphs contradict each
   other; the code matches the later one.
2. **`STATE-AND-HANDOVER.md:481-485`** lists the owner's half as "surfacing the authorization URL to
   the browser, the refresh, the revoke, and the tombstone". **The revoke and the tombstone already
   existed** (`mcp/connection-saga.ts:52-61`; `cloudflare/mcp-connection-durable-object.ts:288-327`)
   before this change. What was missing was the authorization URL, the owner's view of the state,
   and a way to replace a credential the provider has refused.
3. **`STATE-AND-HANDOVER.md:163`** lists the MCP read capability as "Ready behind its own gate —
   Grants, reviewed catalog, gateway, broker authority, the transport, the OAuth callback". The
   transport and the callback exist, but the owner's half did not: the callback could complete an
   approval that the owner could never start and would never see.
4. **`STATE-AND-HANDOVER.md:31`** places "MCP OAuth" under D1's authority. That held; but the
   _state_ of that OAuth — whether the server was waiting on the owner — was held nowhere, in D1 or
   in the broker's port, and the port's `authUrl`/`state` fields were declared and never produced.
5. **The brief's question 3** asks whether a refresh token is left after a revoke. The code answers
   no (1.4), and the same answer holds for the broker's tombstone. The leftover was the manager's
   registration row, not a token.
6. **`mcp/broker-contract.ts`'s `McpConnectionBrokerStatus`** was written as if the status were
   already meaningful (`authUrl`, `state`, `reason`), while the implementation returned constants.
   The contract was the design and the implementation was the stub; this change makes the
   implementation match.

---

## 5. Verification

| Lane                           | Command                                                                                     | Result                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared build                   | `npm run build -w @open-inspect/shared`                                                     | pass                                                                                                                                                                                                                                                                                                                 |
| Focused unit                   | `vitest run src/db/mcp-connections.test.ts src/mcp/connection-saga.test.ts`                 | 13 passed                                                                                                                                                                                                                                                                                                            |
| Focused integration            | `vitest run --config vitest.integration.config.ts test/integration/mcp-connections.test.ts` | 13 passed (5 new: the authorization URL and the waiting state; a fresh URL on a second attempt; the owner's exclusivity; the whole approval and the encrypted credential; the owner's reconnect replacing a refused credential)                                                                                      |
| Control-plane unit lane        | `npm test -w @open-inspect/control-plane`                                                   | 5,417 passed, 1 skipped, 339 files                                                                                                                                                                                                                                                                                   |
| Control-plane integration lane | `npx vitest run --config vitest.integration.config.ts`                                      | 2,479 passed, 1 skipped, 174 files (route catalogs and the admission matrix regenerated)                                                                                                                                                                                                                             |
| Web lane                       | `npm test -w @open-inspect/web`                                                             | 2,581 tests; the MCP settings file passes in every run. One full run was green; the others showed the load-sensitive timeouts in unrelated files (`automation-form`, the GitHub/Linear integration settings, `models-settings`), which pass in isolation — the flakiness recorded in `STATE-AND-HANDOVER.md:566-568` |
| Typecheck                      | `npm run typecheck`                                                                         | pass                                                                                                                                                                                                                                                                                                                 |
| Lint                           | `npm run lint`                                                                              | pass                                                                                                                                                                                                                                                                                                                 |
| Format                         | `npm run format`                                                                            | pass                                                                                                                                                                                                                                                                                                                 |

The integration lane's outbound mock (`packages/control-plane/vitest.integration.config.ts`) now
serves a protected MCP server: a 401 with `WWW-Authenticate`, the protected-resource metadata, the
authorization server metadata, dynamic client registration, and the token endpoint. That is what
makes the owner's whole half testable end to end without a live server.

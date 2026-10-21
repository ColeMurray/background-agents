# MCP connection foundation report

This branch adds the first feature-disabled foundation for remote MCP. It does not connect Pi or any
other harness to an MCP server, and it does not claim OAuth readiness. Delivery order is strictly:
foundation, live read-only transport canary, then OAuth canary.

## Landed safely

- D1 migration `0091` owns personal connection metadata, immutable reviewed read-only catalog
  snapshots, schema hashes, and encrypted OAuth key/value state. Any future Agents
  `cf_agents_mcp_servers` rows are reconstructable transport cache, never authority.
- OAuth state, PKCE verifiers, dynamic client registrations, access tokens, and refresh tokens use a
  dedicated Terraform-generated AES-256-GCM key. Ciphertext is authenticated against both the
  connection ID and storage key so rows cannot be replayed into another principal's connection.
- `McpConnectionDO` persists the immutable logical `mcpconn_*` ID and owner verified against D1. It
  uses the Agents `0.28.1` `MCPClientManager` and `DurableObjectOAuthClientProvider` contracts, but
  the manager is private and is deliberately not installed on an Agents `Lifecycle`.
- Create and revoke are D1-checkpointed idempotent sagas. Revocation persists `revoking` before
  closing transport cache, clearing encrypted OAuth rows, tombstoning the broker, and deleting D1
  metadata. Retries resume from that checkpoint. Failed creation compensates the possibly
  initialized broker before deleting its D1 row.
- The Durable Object binding is independently staged and disabled by default. Terraform does not
  bind the management feature flag.
- Human-only management routes derive ownership from the verified principal. Service actors cannot
  proxy these routes, and callers cannot supply an owner, endpoint, headers, or mutation grants.
- Personal connections accept only enabled, credential-free remote catalog servers with a pinned
  revision and exact public HTTPS host. Local/private/reserved targets, URL credentials, query
  credentials, fragments, and non-default ports are rejected.
- Reviews use the shared `external_read` / `external_mutation` classifications. A connection copies
  only `external_read` reviews into an immutable schema-hashed snapshot; later review changes cannot
  widen it. No tool execution route exists.

## Remaining live OAuth canary gates

1. Stage `McpConnectionDO` as the v5 SQLite class with Durable Object bindings disabled, then deploy
   the binding in the second Terraform phase. The workflow retains the binding during rollback.
2. Run a credential-free read-only transport canary. Treat Agents SQLite server rows as disposable
   cache rebuilt from the D1 connection and immutable snapshot.
3. Install `MCPClientManager` on `Lifecycle` only after callback routing, CSRF-state ownership, and
   reconnect/delete behavior have eviction tests.
4. Add a network egress design that closes DNS-rebinding and redirect gaps beyond the current
   literal/suffix and exact-host policy. Do not rely on the Agents SDK's development-friendly
   loopback policy.
5. Run one approved-provider OAuth canary and prove that D1 contains only AES-GCM ciphertext and the
   broker's SQLite, logs, events, exports, prompts, and Pi storage contain no credential values.
6. Add discovery-to-review tooling that pins schema hashes and requires explicit human review before
   a tool enters the read-only catalog.
7. Add the SessionDO-authorized read-only invocation proxy, stable Pi tool projection, timeout and
   cancellation behavior, output bounds, and wake/restore tests. Tokens remain broker-local.
8. Keep static secret headers blocked. Do not enable MCP mutations until approval, idempotency,
   execution-ledger, indeterminate-outcome, and executor-grant invalidation contracts land.

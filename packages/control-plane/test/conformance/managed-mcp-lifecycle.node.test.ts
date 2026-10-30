import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import { buildServiceAuthHeaders } from "@open-inspect/shared/service-auth";
import type { McpServerMetadata } from "@open-inspect/shared/types/integrations";
import { generateEncryptionKey } from "../../src/auth/crypto";
import {
  createTestBackgroundTasks,
  type TestBackgroundTasks,
} from "../../src/background-tasks.test-support";
import {
  McpConnectionStore,
  connectionBinding,
  type McpGrantBinding,
  type McpOAuthTransaction,
} from "../../src/db/mcp-connections";
import { McpOAuthService } from "../../src/mcp/oauth";
import { createMcpDestinationPolicy } from "../../src/mcp/authorization";
import { McpServerStore } from "../../src/db/mcp-servers";
import type { SqlDatabase } from "../../src/db/sql-database";
import { applyMigrations } from "../../src/node/migrate";
import { createNodeSqlDatabase } from "../../src/node/sqlite-database";
import { createTestEnv } from "../../src/router.test-support";
import { mcpConnectionRoutes } from "../../src/routes/mcp-connections";
import { mcpServerRoutes } from "../../src/routes/mcp-servers";
import { createControlPlaneApp } from "../../src/routing/hono-app";
import type { Env } from "../../src/types";
import { ManagedMcpGatewayFixture } from "../fixtures/managed-mcp-gateway";

const USERS = {
  alice: "11111111111111111111111111111111",
  admin: "22222222222222222222222222222222",
} as const;
type TestUser = keyof typeof USERS;
const BROWSER_SECRET = "review-only-browser-secret-at-least-32-characters";
const SERVICE_SECRET = "review-only-web-service-secret";
const APP_ORIGIN = "https://app.fixture.test";

async function createFixture(db: SqlDatabase, backgroundTasks: TestBackgroundTasks) {
  const now = Date.now();
  for (const [name, id] of Object.entries(USERS)) {
    await db
      .prepare(
        "INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)"
      )
      .bind(id, name, `${name}@fixture.test`, now, now)
      .run();
    await db
      .prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
      .bind(BUILT_IN_ROLE_REGISTRY[name === "admin" ? "owner" : "member"].id, id)
      .run();
    await db
      .prepare(
        "INSERT INTO auth_sessions (id, userId, token, createdAt, updatedAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .bind(`browser-${name}`, id, `review-browser-${name}`, now, now, now + 3_600_000)
      .run();
  }

  const key = generateEncryptionKey();
  const gateway = new ManagedMcpGatewayFixture();
  const outbound: { url: string; method: string }[] = [];
  // Only the upstream network is substituted. Routing, authentication, admission,
  // OAuth, encryption, stores, and all migrations are production implementations.
  vi.stubGlobal("fetch", async (request: Request) => {
    outbound.push({ url: request.url, method: request.method });
    return gateway.fetch(request);
  });
  const env = createTestEnv({
    DB: db,
    TOKEN_ENCRYPTION_KEY: key,
    REPO_SECRETS_ENCRYPTION_KEY: key,
    PROVIDER_ACCOUNTS_ENCRYPTION_KEY: key,
    BROWSER_AUTH_SECRET: BROWSER_SECRET,
    SERVICE_AUTH_SECRET_WEB: SERVICE_SECRET,
    WEB_APP_URL: APP_ORIGIN,
    GITHUB_CLIENT_ID: "review-only-github-client",
    GITHUB_CLIENT_SECRET: "review-only-github-secret",
    UNSAFE_ALLOW_ALL_USERS: "true",
    MCP_ALLOWED_UPSTREAM_ORIGINS: gateway.origin,
    MANAGED_MCP_ROUTING_ENABLED: "true",
    MCP_USER_DELEGATION_ENABLED: "true",
  });
  const app = createControlPlaneApp([mcpConnectionRoutes, mcpServerRoutes], {
    backgroundTasks: () => backgroundTasks,
  });
  const registry = new McpServerStore(db, key);
  const store = new McpConnectionStore(db, key);
  const destination = createMcpDestinationPolicy(env);
  const oauth = new McpOAuthService(store, destination);
  const server = await registry.create({
    name: "review-server",
    type: "remote",
    url: `${gateway.origin}/mcp`,
    enabled: true,
    managedRouting: true,
    authMode: "user_oauth",
    oauth: { issuer: gateway.origin, resource: `${gateway.origin}/mcp` },
  });

  async function request(
    path: string,
    options: { method?: string; body?: unknown; user?: TestUser; env?: Env } = {}
  ) {
    const method = options.method ?? "GET";
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const url = `https://control.fixture.test${path}`;
    const token = `review-browser-${options.user ?? "alice"}`;
    const signature = createHmac("sha256", BROWSER_SECRET).update(token).digest("base64");
    const headers = await buildServiceAuthHeaders({
      service: "web",
      secret: SERVICE_SECRET,
      method,
      url,
      body,
    });
    return app.fetch(
      new Request(url, {
        method,
        body,
        headers: {
          ...headers,
          Cookie: `__Secure-openinspect.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
      }),
      options.env ?? env
    );
  }

  async function start(user: TestUser = "alice") {
    const response = await request(`/mcp-connections/${server.id}/connect`, {
      method: "POST",
      user,
    });
    expect(response.status).toBe(200);
    const { authorizationUrl } = await response.json<{ authorizationUrl: string }>();
    const consent = await gateway.fetch(new Request(authorizationUrl));
    expect(consent.status).toBe(302);
    const params = new URL(consent.headers.get("Location")!).searchParams;
    return { state: params.get("state")!, code: params.get("code")!, iss: params.get("iss")! };
  }

  async function connect() {
    const response = await request("/mcp-connections/oauth/callback", {
      method: "POST",
      body: await start(),
    });
    expect(response.status).toBe(200);
    expect(await store.get(USERS.alice, server.id)).toMatchObject({ status: "connected" });
  }

  async function transactions() {
    return (
      await db
        .prepare("SELECT * FROM mcp_oauth_transactions WHERE owner_id = ? ORDER BY grant_revision")
        .bind(USERS.alice)
        .all<McpOAuthTransaction>()
    ).results;
  }

  return {
    db,
    env,
    registry,
    store,
    oauth,
    destination,
    key,
    server,
    gateway,
    outbound,
    request,
    start,
    connect,
    transactions,
  };
}

describe.sequential("managed MCP connection lifecycle", () => {
  let raw: DatabaseSync;
  let backgroundTasks: TestBackgroundTasks;
  let f: Awaited<ReturnType<typeof createFixture>>;

  beforeEach(async () => {
    raw = new DatabaseSync(":memory:");
    raw.exec("PRAGMA foreign_keys = ON");
    applyMigrations(
      raw,
      fileURLToPath(new URL("../../../../terraform/d1/migrations", import.meta.url).href)
    );
    backgroundTasks = createTestBackgroundTasks();
    f = await createFixture(createNodeSqlDatabase(raw), backgroundTasks);
  });

  afterEach(async () => {
    try {
      await backgroundTasks?.settle();
    } finally {
      vi.unstubAllGlobals();
      raw?.close();
    }
  });

  it.each(["an unchanged", "a rename-only"])(
    "%s editor save preserves auth revision and personal connections",
    async (change) => {
      await f.connect();
      const grant = await f.store.get(USERS.alice, f.server.id);
      const before = await f.request("/mcp-connections");
      expect(before.status).toBe(200);
      expect(await before.json()).toMatchObject({ connections: [{ status: "connected" }] });

      // Control: a genuinely minimal name-only patch does not invalidate authentication.
      const baseline = await f.registry.update(f.server.id, { name: "minimal rename" });
      expect(baseline!.authRevision).toBe(f.server.authRevision);
      const name = change === "an unchanged" ? baseline!.name : "editor rename";
      // Mirrors the existing editor payload, including empty headers and repoScopes.
      const saved = await f.request(`/mcp-servers/${f.server.id}`, {
        method: "PUT",
        user: "admin",
        body: {
          name,
          revision: baseline!.revision,
          enabled: baseline!.enabled,
          repoScopes: baseline!.repoScopes,
          type: "remote",
          url: baseline!.url,
          authMode: baseline!.authMode,
          managedRouting: baseline!.managedRouting,
          oauth: baseline!.oauth,
          headers: {},
        },
      });
      expect(saved.status).toBe(200);
      const updated = await saved.json<McpServerMetadata>();
      expect(updated).toEqual({
        ...baseline,
        name,
        revision: baseline!.revision + 1,
        authRevision: baseline!.authRevision,
        // Managers see stored credential names; a user OAuth server stores none.
        credentialKeys: [],
      });
      expect(await f.store.get(USERS.alice, f.server.id)).toEqual(grant);
      const listed = await f.request("/mcp-connections");
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({
        connections: [{ serverId: f.server.id, status: "connected" }],
      });
    }
  );

  it("lets an audited administrator revoke a suspended owner's grants before deletion", async () => {
    await f.connect();
    const grant = await f.store.get(USERS.alice, f.server.id);
    const revocationPath = `/mcp-servers/${f.server.id}/revoke-connections`;
    const denied = await f.request(revocationPath, { method: "POST" });
    expect(denied.status).toBe(403);
    expect(await f.store.get(USERS.alice, f.server.id)).toEqual(grant);
    const enabled = await f.request(revocationPath, { method: "POST", user: "admin" });
    expect(enabled.status).toBe(409);
    await expect(f.store.disconnectServer(f.server.id)).rejects.toMatchObject({
      code: "mcp_context_changed",
    });
    expect(await f.store.get(USERS.alice, f.server.id)).toEqual(grant);
    await f.db
      .prepare("UPDATE users SET suspended_at = ? WHERE id = ?")
      .bind(Date.now(), USERS.alice)
      .run();
    const disabled = await f.request(`/mcp-servers/${f.server.id}`, {
      method: "PUT",
      user: "admin",
      body: { enabled: false, revision: f.server.revision },
    });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ enabled: false });

    const selfDisconnect = await f.request(`/mcp-connections/${f.server.id}`, { method: "DELETE" });
    expect(selfDisconnect.status).toBe(403);
    expect(await selfDisconnect.json()).toMatchObject({ code: "active_user_required" });
    const adminDisconnect = await f.request(`/mcp-connections/${f.server.id}`, {
      method: "DELETE",
      user: "admin",
    });
    expect(adminDisconnect.status).toBe(200);
    expect(await f.store.get(USERS.alice, f.server.id)).toEqual(grant);

    const deleted = await f.request(`/mcp-servers/${f.server.id}`, {
      method: "DELETE",
      user: "admin",
    });
    expect(deleted.status).toBe(409);
    expect(await deleted.json()).toMatchObject({ error: expect.stringContaining("disconnect") });
    await expect(
      f.db.prepare("DELETE FROM users WHERE id = ?").bind(USERS.alice).run()
    ).rejects.toThrow("Disconnect personal MCP connections");

    const revoked = await f.request(revocationPath, { method: "POST", user: "admin" });
    expect(revoked.status).toBe(200);
    expect(await f.store.get(USERS.alice, f.server.id)).toMatchObject({
      status: "disconnected",
      grant_revision: grant!.grant_revision + 1,
      encrypted_payload: null,
      exchange_owner: null,
    });
    await expect(f.oauth.credential(connectionBinding(grant!))).rejects.toMatchObject({
      code: "mcp_context_changed",
    });
    const audit = await f.db
      .prepare(
        "SELECT actor_user_id_snapshot, metadata_json FROM authorization_audit_events WHERE request_id = ? AND action = 'authorization.request_allowed'"
      )
      .bind(revoked.headers.get("x-request-id"))
      .first<{ actor_user_id_snapshot: string; metadata_json: string }>();
    expect(audit?.actor_user_id_snapshot).toBe(USERS.admin);
    expect(JSON.parse(audit!.metadata_json)).toMatchObject({
      httpMethod: "POST",
      httpPath: revocationPath,
      httpStatus: 200,
    });
    const deletedAfterRevocation = await f.request(`/mcp-servers/${f.server.id}`, {
      method: "DELETE",
      user: "admin",
    });
    expect(deletedAfterRevocation.status).toBe(200);
    expect(
      await f.db.prepare("SELECT suspended_at FROM users WHERE id = ?").bind(USERS.alice).first()
    ).toMatchObject({ suspended_at: expect.any(Number) });
  });

  it("keeps only current consent and erases verifiers on settlement, expiry, failure, and disconnect", async () => {
    await f.connect();
    expect(await f.transactions()).toEqual([]);
    const pending = await f.start();
    // Advance persisted expiry only; keep browser sessions and request-signature clocks valid.
    await f.db
      .prepare("UPDATE mcp_oauth_transactions SET expires_at = 0 WHERE owner_id = ?")
      .bind(USERS.alice)
      .run();
    const expiredRows = await f.transactions();
    expect(expiredRows).toHaveLength(1);
    const expiredCallback = await f.request("/mcp-connections/oauth/callback", {
      method: "POST",
      body: pending,
    });
    expect(expiredCallback.status).toBe(403);
    expect(await expiredCallback.json()).toMatchObject({ code: "mcp_denied" });
    expect(await f.transactions()).toEqual([]);

    const superseded = await f.start();
    for (let attempt = 0; attempt < 4; attempt++) {
      await f.start();
      expect(await f.transactions()).toHaveLength(1);
    }
    const replay = await f.request("/mcp-connections/oauth/callback", {
      method: "POST",
      body: superseded,
    });
    expect(replay.status).toBe(403);
    const beforeDisconnect = await f.transactions();
    expect(beforeDisconnect.map((row) => row.status)).toEqual(["pending"]);
    const disconnected = await f.request(`/mcp-connections/${f.server.id}`, { method: "DELETE" });
    expect(disconnected.status).toBe(200);
    expect(await f.transactions()).toEqual([]);
    const failed = await f.start();
    const failure = await f.request("/mcp-connections/oauth/callback", {
      method: "POST",
      body: { ...failed, iss: "https://wrong.fixture.test" },
    });
    expect(failure.status).toBe(403);
    expect(await f.transactions()).toEqual([]);
    await f.start();
    await f.db.prepare("DELETE FROM auth_sessions WHERE userId = ?").bind(USERS.alice).run();
    await f.store.pruneTransactions(USERS.alice);
    expect(await f.transactions()).toEqual([]);
  });

  it("enforces the current origin allowlist on pending callbacks without sending credentials", async () => {
    const pending = await f.start();
    const revokedEnv = { ...f.env, MCP_ALLOWED_UPSTREAM_ORIGINS: "" };
    const before = f.outbound.length;
    const deniedStart = await f.request(`/mcp-connections/${f.server.id}/connect`, {
      method: "POST",
      env: revokedEnv,
    });
    expect(deniedStart.status).toBe(403);
    expect(await deniedStart.json()).toMatchObject({ code: "mcp_unsupported" });
    expect(f.outbound).toHaveLength(before);

    const redeemed = await f.request("/mcp-connections/oauth/callback", {
      method: "POST",
      body: pending,
      env: revokedEnv,
    });
    expect(redeemed.status).toBe(403);
    expect(await redeemed.json()).toMatchObject({ code: "mcp_unsupported" });
    expect(f.outbound).toHaveLength(before);
    const connection = await f.store.get(USERS.alice, f.server.id);
    expect(connection).toMatchObject({ status: "reconnect_required", encrypted_payload: null });
    expect(await f.transactions()).toEqual([]);

    // Disabling the definition independently fences a pending callback as well.
    const second = await f.start();
    await f.registry.update(f.server.id, { enabled: false });
    const beforeDisabledCallback = f.outbound.length;
    const disabledCallback = await f.request("/mcp-connections/oauth/callback", {
      method: "POST",
      body: second,
    });
    expect(disabledCallback.status).toBe(403);
    expect(await disabledCallback.json()).toMatchObject({ code: "mcp_denied" });
    expect(f.outbound).toHaveLength(beforeDisabledCallback);
  });

  it("compares credential maps and repository scopes by value rather than order", async () => {
    const server = await f.registry.create({
      name: "service",
      type: "remote",
      url: `${f.gateway.origin}/mcp`,
      enabled: true,
      managedRouting: true,
      headers: { Authorization: "Bearer service", "X-Tenant": "tenant" },
      repoScopes: ["Acme/Group/Web", "acme/api"],
    });
    const ciphertext = await f.db
      .prepare("SELECT env FROM mcp_servers WHERE id = ?")
      .bind(server.id)
      .first();
    const unchanged = await f.registry.update(server.id, {
      type: "remote",
      headers: { "X-Tenant": "tenant", Authorization: "Bearer service" },
      repoScopes: ["ACME/API", "acme/group/web", "acme/api"],
    });
    expect(unchanged!.authRevision).toBe(server.authRevision);
    expect(unchanged!.repoScopes).toEqual(["acme/api", "acme/group/web"]);
    expect(
      await f.db.prepare("SELECT env FROM mcp_servers WHERE id = ?").bind(server.id).first()
    ).toEqual(ciphertext);
    const changed = await f.registry.update(server.id, {
      headers: { Authorization: "Bearer changed", "X-Tenant": "tenant" },
    });
    expect(changed!.authRevision).toBe(server.authRevision! + 1);
    await expect(f.registry.getServiceHeaders(server.id, server.authRevision!)).rejects.toThrow();
  });

  it("does not broaden legacy repository scopes on a metadata-only save", async () => {
    const scopes = ["acme/public", " acme/private "];
    await f.db
      .prepare("UPDATE mcp_servers SET repo_scope = ? WHERE id = ?")
      .bind(JSON.stringify(scopes), f.server.id)
      .run();
    const repositories = [{ repoOwner: "acme", repoName: "private" }];
    expect(await f.registry.getForLaunch(repositories)).toEqual([]);
    const renamed = await f.registry.update(f.server.id, { name: "renamed" });
    expect(renamed!.authRevision).toBe(f.server.authRevision);
    expect(await f.registry.getForLaunch(repositories)).toEqual([]);
    const expanded = await f.registry.update(f.server.id, {
      repoScopes: ["acme/public", "acme/private"],
    });
    expect(expanded!.authRevision).toBe(f.server.authRevision! + 1);
    expect(await f.registry.getForLaunch(repositories)).toHaveLength(1);
  });

  it("invalidates the binding when reordered case-colliding headers change the effective credential", async () => {
    const server = await f.registry.create({
      name: "case-colliding-headers",
      type: "remote",
      url: `${f.gateway.origin}/mcp`,
      enabled: true,
      managedRouting: true,
      authMode: "service_credentials",
      headers: { Authorization: "Bearer first", authorization: "Bearer last" },
    });
    const changed = await f.registry.update(server.id, {
      headers: { authorization: "Bearer last", Authorization: "Bearer first" },
    });
    expect(changed!.authRevision).toBe(server.authRevision! + 1);
    const headers = new Headers();
    for (const [key, value] of Object.entries(
      await f.registry.getServiceHeaders(server.id, changed!.authRevision!)
    )) {
      headers.set(key, value);
    }
    expect(headers.get("authorization")).toBe("Bearer first");
  });

  it("preserves grants for reordered OAuth fields and equivalent unscoped repositories", async () => {
    await f.connect();
    const binding = connectionBinding((await f.store.get(USERS.alice, f.server.id))!);
    const updated = await f.registry.update(f.server.id, {
      oauth: { resource: f.server.oauth!.resource, issuer: f.server.oauth!.issuer },
      repoScopes: [],
    });
    expect(updated!.authRevision).toBe(f.server.authRevision);
    expect(f.gateway.access.get(await f.oauth.credential(binding))).toBe("reader");
  });

  it.each([
    { url: "https://mcp.fixture.test/changed" },
    { oauth: { issuer: "https://issuer.fixture.test", resource: "https://mcp.fixture.test/mcp" } },
    { repoScopes: ["acme/group/private"] },
  ])("invalidates grants when security configuration changes: %j", async (patch) => {
    await f.connect();
    const binding = connectionBinding((await f.store.get(USERS.alice, f.server.id))!);
    const updated = await f.registry.update(f.server.id, patch);
    expect(updated!.authRevision).toBe(f.server.authRevision! + 1);
    await expect(f.oauth.credential(binding)).rejects.toMatchObject({
      code: "mcp_context_changed",
    });
  });

  it.each(["callback", "refresh"])("admin revocation fences an in-flight %s", async (exchange) => {
    let binding: McpGrantBinding | undefined;
    if (exchange === "refresh") {
      await f.connect();
      const row = (await f.store.get(USERS.alice, f.server.id))!;
      binding = connectionBinding(row);
      expect(await f.store.claimRefresh(row, "expire-for-test", Date.now())).toBe(true);
      expect(
        await f.store.publishRefresh(row, "expire-for-test", {
          ...(await f.store.decrypt(row)),
          expiresAt: 0,
        })
      ).toBe(true);
    }
    const callback = exchange === "callback" ? await f.start() : null;
    // Another owner's pending consent must be revoked by the same operation.
    await f.start("admin");
    f.gateway.afterTokenExchange = async () => {
      await f.registry.update(f.server.id, { enabled: false });
      const response = await f.request(`/mcp-servers/${f.server.id}/revoke-connections`, {
        method: "POST",
        user: "admin",
      });
      expect(response.status).toBe(200);
    };
    if (binding) {
      await expect(f.oauth.credential(binding)).rejects.toMatchObject({
        code: "mcp_context_changed",
      });
    } else {
      const response = await f.request("/mcp-connections/oauth/callback", {
        method: "POST",
        body: callback,
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "mcp_context_changed" });
    }
    for (const userId of Object.values(USERS)) {
      expect(await f.store.get(userId, f.server.id)).toMatchObject({
        status: "disconnected",
        encrypted_payload: null,
        exchange_owner: null,
      });
    }
    expect((await f.db.prepare("SELECT * FROM mcp_oauth_transactions").all()).results).toEqual([]);
  });

  it("does not let a delayed consent publisher erase the newer attempt", async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pausedDb: SqlDatabase = {
      prepare: (sql) => f.db.prepare(sql),
      async batch(statements) {
        entered();
        await gate;
        return f.db.batch(statements);
      },
    };
    const old = new McpOAuthService(new McpConnectionStore(pausedDb, f.key), f.destination);
    const rejected = expect(
      old.start(
        USERS.alice,
        "browser-alice",
        f.server,
        `${APP_ORIGIN}/api/mcp-connections/oauth/callback`
      )
    ).rejects.toMatchObject({ code: "mcp_context_changed" });
    await started;
    const current = await f.start().finally(release);
    await rejected;
    expect(await f.transactions()).toHaveLength(1);
    const responses = await Promise.all([
      f.request("/mcp-connections/oauth/callback", { method: "POST", body: current }),
      f.request("/mcp-connections/oauth/callback", { method: "POST", body: current }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 403]);
    expect(await f.transactions()).toEqual([]);
    expect(f.gateway.access.size).toBe(1);
  });

  it.each(["cached", "expired"])(
    "rejects %s credentials when their origin is no longer allowed",
    async (state) => {
      await f.connect();
      const row = (await f.store.get(USERS.alice, f.server.id))!;
      if (state === "expired") {
        await f.store.claimRefresh(row, "expire-for-test", Date.now());
        await f.store.publishRefresh(row, "expire-for-test", {
          ...(await f.store.decrypt(row)),
          expiresAt: 0,
        });
      }
      f.env.MCP_ALLOWED_UPSTREAM_ORIGINS = "";
      const before = f.outbound.length;
      await expect(f.oauth.credential(connectionBinding(row))).rejects.toMatchObject({
        code: "mcp_unsupported",
      });
      expect(f.outbound).toHaveLength(before);
      expect(f.gateway.refreshCount).toBe(0);
    }
  );

  it("rechecks origin policy before publishing exchanged credentials", async () => {
    const callback = await f.start();
    f.gateway.afterTokenExchange = async () => {
      f.env.MCP_ALLOWED_UPSTREAM_ORIGINS = "";
    };
    const response = await f.request("/mcp-connections/oauth/callback", {
      method: "POST",
      body: callback,
    });
    expect(response.status).toBe(403);
    expect(await f.store.get(USERS.alice, f.server.id)).toMatchObject({ encrypted_payload: null });
    expect(await f.transactions()).toEqual([]);
  });

  it("fences a rotation when origin approval is withdrawn during exchange", async () => {
    await f.connect();
    const row = (await f.store.get(USERS.alice, f.server.id))!;
    await f.store.claimRefresh(row, "expire-for-test", Date.now());
    await f.store.publishRefresh(row, "expire-for-test", {
      ...(await f.store.decrypt(row)),
      expiresAt: 0,
    });
    f.gateway.afterTokenExchange = async () => {
      f.env.MCP_ALLOWED_UPSTREAM_ORIGINS = "";
    };
    await expect(f.oauth.credential(connectionBinding(row))).rejects.toMatchObject({
      code: "mcp_unsupported",
    });
    expect(f.gateway.refreshCount).toBe(1);
    expect(await f.store.get(USERS.alice, f.server.id)).toMatchObject({
      status: "reconnect_required",
      exchange_owner: null,
    });
  });

  it("lazily removes terminal consent history left by older versions", async () => {
    await f.start();
    await f.db
      .prepare(
        `INSERT INTO mcp_oauth_transactions
        SELECT state_digest || '-legacy', owner_id, browser_session_id, connection_id,
          grant_revision, auth_revision, redirect_uri, encrypted_verifier, expires_at, 'settled', NULL
        FROM mcp_oauth_transactions WHERE owner_id = ?`
      )
      .bind(USERS.alice)
      .run();
    expect(await f.transactions()).toHaveLength(2);
    expect((await f.request("/mcp-connections")).status).toBe(200);
    expect(await f.transactions()).toMatchObject([{ status: "pending" }]);
    expect(await f.transactions()).toHaveLength(1);
  });
});

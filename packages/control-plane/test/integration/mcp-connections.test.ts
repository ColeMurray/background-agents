import { beforeEach, describe, expect, it } from "vitest";
import { env, runInDurableObject, SELF } from "cloudflare:test";
import type { McpConnectionDO } from "../../src/cloudflare/mcp-connection-durable-object";
import { buildServiceAuthHeaders } from "@open-inspect/shared/service-auth";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch, serviceRequestHeaders, sqlDatabase } from "./helpers";
import {
  D1McpOAuthStorage,
  EncryptedMcpOAuthClientProvider,
} from "../../src/mcp/encrypted-oauth-provider";
import { requireMcpOAuthEncryptionKey } from "../../src/env-validation";

function mcpNamespace(): NonNullable<typeof env.MCP_CONNECTION> {
  if (!env.MCP_CONNECTION) throw new Error("MCP_CONNECTION test binding is unavailable");
  return env.MCP_CONNECTION;
}

function runInMcpConnectionDO<T>(
  stub: DurableObjectStub<McpConnectionDO>,
  callback: (instance: McpConnectionDO, state: DurableObjectState) => T | Promise<T>
): Promise<T> {
  return runInDurableObject(
    stub as unknown as DurableObjectStub,
    callback as unknown as (
      instance: DurableObject,
      state: DurableObjectState<unknown>
    ) => T | Promise<T>
  );
}

interface McpServerMetadata {
  id: string;
  revision: number;
}

interface McpConnectionMetadata {
  id: string;
  serverId: string;
  serverRevision: number;
  serverName: string;
  endpointUrl: string;
  endpointHost: string;
  status: string;
  tools: Array<{ stableToolId: string; name: string }>;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createRemoteServer(options?: {
  name?: string;
  url?: string;
  headers?: Record<string, string>;
}): Promise<McpServerMetadata> {
  const response = await serviceFetch("https://test.local/mcp-servers", {
    method: "POST",
    body: JSON.stringify({
      name: options?.name ?? "personal-oauth-server",
      type: "remote",
      url: options?.url ?? "https://mcp.example.com/mcp",
      ...(options?.headers ? { headers: options.headers } : {}),
    }),
  });
  expect(response.status).toBe(201);
  return response.json<McpServerMetadata>();
}

describe("personal MCP connections API", () => {
  const OWNER_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const OWNER_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  beforeEach(cleanD1Tables);

  it("stages an owner-scoped connection pinned to an exact safe host", async () => {
    const server = await createRemoteServer();

    const response = await serviceFetch("https://test.local/mcp-connections", {
      method: "POST",
      body: JSON.stringify({ serverId: server.id }),
    });

    expect(response.status).toBe(201);
    const connection = await response.json<McpConnectionMetadata>();
    expect(connection).toMatchObject({
      serverId: server.id,
      serverRevision: server.revision,
      serverName: "personal-oauth-server",
      endpointUrl: "https://mcp.example.com/mcp",
      endpointHost: "mcp.example.com",
      catalogSnapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      status: "foundation_staged",
      tools: [],
    });
    const namespace = mcpNamespace();
    const broker = namespace.get(namespace.idFromName(connection.id));
    await expect(broker.status()).resolves.toEqual({
      enabled: false,
      connectionId: connection.id,
      ownerUserId: "11111111111111111111111111111111",
      transportCacheEntries: 0,
      reason: "The MCP transport has not been opened yet",
    });
    await expect(
      runInMcpConnectionDO(broker, async (_instance, state) => ({
        connectionId: await state.storage.get("open-inspect:mcp-connection-id"),
        ownerUserId: await state.storage.get("open-inspect:mcp-owner-user-id"),
      }))
    ).resolves.toEqual({
      connectionId: connection.id,
      ownerUserId: "11111111111111111111111111111111",
    });
    await expect(
      runInMcpConnectionDO(broker, (_instance, state) => {
        state.abort("test: force MCP broker eviction");
      })
    ).rejects.toThrow();
    const restored = namespace.get(namespace.idFromName(connection.id));
    await expect(restored.status()).resolves.toMatchObject({
      connectionId: connection.id,
      ownerUserId: "11111111111111111111111111111111",
    });
    const retriedCreate = await serviceFetch("https://test.local/mcp-connections", {
      method: "POST",
      body: JSON.stringify({ serverId: server.id }),
    });
    await expect(retriedCreate.json<McpConnectionMetadata>()).resolves.toMatchObject({
      id: connection.id,
      status: "foundation_staged",
    });
  });

  it("rejects static credentials and unsafe endpoints before staging", async () => {
    const credentialed = await createRemoteServer({
      name: "credentialed",
      headers: { Authorization: "Bearer must-not-enter-pi" },
    });
    const unsafe = await createRemoteServer({
      name: "unsafe",
      url: "http://127.0.0.1/mcp",
    });

    for (const serverId of [credentialed.id, unsafe.id]) {
      const response = await serviceFetch("https://test.local/mcp-connections", {
        method: "POST",
        body: JSON.stringify({ serverId }),
      });
      expect(response.status).toBe(400);
    }
  });

  it("derives ownership from the human principal and never the request body", async () => {
    const server = await createRemoteServer();
    const response = await serviceFetch("https://test.local/mcp-connections", {
      method: "POST",
      body: JSON.stringify({ serverId: server.id, ownerUserId: "attacker-selected-owner" }),
    });

    expect(response.status).toBe(400);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM mcp_connections").first<{
      count: number;
    }>();
    expect(count?.count).toBe(0);
  });

  it("does not let another owner enumerate, read, or delete a connection", async () => {
    const server = await createRemoteServer();
    const createdResponse = await serviceFetch("https://test.local/mcp-connections", {
      method: "POST",
      body: JSON.stringify({ serverId: server.id }),
      as: { userId: OWNER_A, role: "member" },
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json<McpConnectionMetadata>();

    const list = await serviceFetch("https://test.local/mcp-connections", {
      as: { userId: OWNER_B, role: "member" },
    });
    await expect(list.json<{ connections: McpConnectionMetadata[] }>()).resolves.toMatchObject({
      connections: [],
    });

    const get = await serviceFetch(`https://test.local/mcp-connections/${created.id}`, {
      as: { userId: OWNER_B, role: "member" },
    });
    expect(get.status).toBe(404);

    const remove = await serviceFetch(`https://test.local/mcp-connections/${created.id}`, {
      method: "DELETE",
      as: { userId: OWNER_B, role: "member" },
    });
    expect(remove.status).toBe(200);
    await expect(remove.json()).resolves.toEqual({ ok: true, result: "already_deleted" });
    const ownerStillReads = await serviceFetch(`https://test.local/mcp-connections/${created.id}`, {
      as: { userId: OWNER_A, role: "member" },
    });
    expect(ownerStillReads.status).toBe(200);
  });

  it("rejects a trusted service principal even when it proxies an actor", async () => {
    const url = "https://test.local/mcp-connections";
    const headers = await buildServiceAuthHeaders({
      service: "slack-bot",
      secret: "test-service-secret-slack-bot",
      method: "GET",
      url,
      actor: "slack:U123",
    });

    const response = await SELF.fetch(url, { headers });

    expect(response.status).toBe(403);
  });

  it("keeps a pinned connection intact when an administrator deletes its catalog server", async () => {
    const server = await createRemoteServer();
    const staged = await serviceFetch("https://test.local/mcp-connections", {
      method: "POST",
      body: JSON.stringify({ serverId: server.id }),
    });
    expect(staged.status).toBe(201);

    const response = await serviceFetch(`https://test.local/mcp-servers/${server.id}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(409);
    const list = await serviceFetch("https://test.local/mcp-connections");
    await expect(list.json<{ connections: McpConnectionMetadata[] }>()).resolves.toMatchObject({
      connections: [expect.objectContaining({ serverId: server.id })],
    });
  });

  it("closes the dormant transport cache and clears credentials before D1 cascade deletion", async () => {
    const server = await createRemoteServer();
    const staged = await serviceFetch("https://test.local/mcp-connections", {
      method: "POST",
      body: JSON.stringify({ serverId: server.id }),
    });
    const connection = await staged.json<McpConnectionMetadata>();
    const storage = new D1McpOAuthStorage(
      sqlDatabase(env.DB),
      requireMcpOAuthEncryptionKey(env),
      connection.id
    );
    await storage.put("oauth/token", { refresh_token: "must-be-cleared" });
    const namespace = mcpNamespace();
    const broker = namespace.get(namespace.idFromName(connection.id));
    await expect(broker.status()).resolves.toMatchObject({ transportCacheEntries: 0 });

    const removed = await serviceFetch(`https://test.local/mcp-connections/${connection.id}`, {
      method: "DELETE",
    });

    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toEqual({ ok: true, result: "deleted" });
    const counts = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM mcp_connections WHERE id = ?) AS connections,
         (SELECT COUNT(*) FROM mcp_oauth_storage WHERE connection_id = ?) AS oauth_rows,
         (SELECT COUNT(*) FROM mcp_connection_tool_snapshots WHERE connection_id = ?) AS snapshots`
    )
      .bind(connection.id, connection.id, connection.id)
      .first<{ connections: number; oauth_rows: number; snapshots: number }>();
    expect(counts).toEqual({ connections: 0, oauth_rows: 0, snapshots: 0 });
    await expect(
      broker.destroy(connection.id, "11111111111111111111111111111111")
    ).resolves.toBeUndefined();
    await expect(
      broker.destroy(connection.id, "11111111111111111111111111111111")
    ).resolves.toBeUndefined();
    await expect(
      runInMcpConnectionDO(broker, (_instance, state) => {
        state.abort("test: evict tombstoned MCP broker");
      })
    ).rejects.toThrow();
    const restoredBroker = namespace.get(namespace.idFromName(connection.id));
    await expect(
      restoredBroker.destroy(connection.id, "11111111111111111111111111111111")
    ).resolves.toBeUndefined();
    await expect(storage.put("oauth/token", { refresh_token: "reinserted" })).rejects.toThrow(
      /foreign key/i
    );
    const callbackReplay = await SELF.fetch(
      `https://test.local/mcp/oauth/callback?code=replayed&state=nonce.${connection.id}`
    );
    expect(callbackReplay.status).toBe(404);
    const oauthRowsAfterReplay = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM mcp_oauth_storage WHERE connection_id = ?"
    )
      .bind(connection.id)
      .first<{ count: number }>();
    expect(oauthRowsAfterReplay?.count).toBe(0);
    const retriedDelete = await serviceFetch(
      `https://test.local/mcp-connections/${connection.id}`,
      { method: "DELETE" }
    );
    await expect(retriedDelete.json()).resolves.toEqual({
      ok: true,
      result: "already_deleted",
    });
    await expect(
      runInMcpConnectionDO(restoredBroker, (_instance, state) =>
        state.storage.get("open-inspect:mcp-deleted")
      )
    ).resolves.toEqual({
      connectionId: connection.id,
      ownerUserId: "11111111111111111111111111111111",
    });
  });

  it("returns only reviewed read-only tools from the pinned server revision", async () => {
    const server = await createRemoteServer();
    const inputSchemaJson = JSON.stringify({ type: "object" });
    await env.DB.prepare(
      `INSERT INTO mcp_reviewed_tools
         (stable_tool_id, server_id, server_revision, tool_name, title, description,
           input_schema_json, input_schema_sha256, effect, reviewed_by_user_id, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'external_read', ?, ?)`
    )
      .bind(
        "tool_read_issues_v1",
        server.id,
        server.revision,
        "list_issues",
        "List issues",
        "Reads issue metadata",
        inputSchemaJson,
        await sha256Hex(inputSchemaJson),
        "11111111111111111111111111111111",
        1234
      )
      .run();
    const createdResponse = await serviceFetch("https://test.local/mcp-connections", {
      method: "POST",
      body: JSON.stringify({ serverId: server.id }),
    });
    const created = await createdResponse.json<McpConnectionMetadata>();

    const response = await serviceFetch(`https://test.local/mcp-connections/${created.id}`);
    const connection = await response.json<McpConnectionMetadata>();

    expect(connection.tools).toEqual([
      expect.objectContaining({
        stableToolId: "tool_read_issues_v1",
        name: "list_issues",
        inputSchemaSha256: await sha256Hex(inputSchemaJson),
      }),
    ]);
    await env.DB.prepare(
      "UPDATE mcp_connection_tool_snapshots SET title = 'Widened model-visible title' WHERE connection_id = ?"
    )
      .bind(created.id)
      .run();
    const widenedSnapshot = await serviceFetch(`https://test.local/mcp-connections/${created.id}`);
    expect(widenedSnapshot.status).toBe(500);
    await env.DB.prepare(
      "UPDATE mcp_connection_tool_snapshots SET title = 'List issues' WHERE connection_id = ?"
    )
      .bind(created.id)
      .run();
    await env.DB.prepare(
      `INSERT INTO mcp_reviewed_tools
         (stable_tool_id, server_id, server_revision, tool_name, input_schema_json,
          input_schema_sha256, effect, reviewed_by_user_id, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, 'external_mutation', ?, ?)`
    )
      .bind(
        "tool_delete_issue_v1",
        server.id,
        server.revision,
        "delete_issue",
        "{}",
        await sha256Hex("{}"),
        "11111111111111111111111111111111",
        1234
      )
      .run();
    await env.DB.prepare(
      `INSERT INTO mcp_reviewed_tools
         (stable_tool_id, server_id, server_revision, tool_name, input_schema_json,
          input_schema_sha256, effect, reviewed_by_user_id, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, 'external_read', ?, ?)`
    )
      .bind(
        "tool_late_read_v1",
        server.id,
        server.revision,
        "late_read",
        "{}",
        await sha256Hex("{}"),
        "11111111111111111111111111111111",
        2345
      )
      .run();
    const readOnlyCatalog = await serviceFetch(`https://test.local/mcp-connections/${created.id}`);
    await expect(readOnlyCatalog.json<McpConnectionMetadata>()).resolves.toMatchObject({
      tools: [expect.objectContaining({ stableToolId: "tool_read_issues_v1" })],
    });
    await env.DB.prepare(
      "UPDATE mcp_connection_tool_snapshots SET description = 'corrupt' WHERE connection_id = ?"
    )
      .bind(created.id)
      .run();
    const revokeCorruptSnapshot = await serviceFetch(
      `https://test.local/mcp-connections/${created.id}`,
      { method: "DELETE" }
    );
    expect(revokeCorruptSnapshot.status).toBe(200);
  });

  it("keeps every Agents OAuth value AES-GCM encrypted and connection-isolated", async () => {
    const server = await createRemoteServer();
    const createdResponse = await serviceFetch("https://test.local/mcp-connections", {
      method: "POST",
      body: JSON.stringify({ serverId: server.id }),
    });
    const connection = await createdResponse.json<McpConnectionMetadata>();
    const storage = new D1McpOAuthStorage(
      sqlDatabase(env.DB),
      requireMcpOAuthEncryptionKey(env),
      connection.id
    );
    const provider = new EncryptedMcpOAuthClientProvider({
      storage,
      clientName: "open-inspect-mcp",
      callbackUrl: "https://control.example/mcp/oauth/callback",
    });
    provider.serverId = "catalog-server";
    provider.clientId = "oauth-client";

    await provider.saveTokens({
      access_token: "access-plaintext-must-not-persist",
      refresh_token: "refresh-plaintext-must-not-persist",
      token_type: "Bearer",
    });
    const row = await env.DB.prepare(
      "SELECT storage_key, ciphertext FROM mcp_oauth_storage WHERE connection_id = ?"
    )
      .bind(connection.id)
      .first<{ storage_key: string; ciphertext: string }>();

    expect(row?.ciphertext).not.toContain("access-plaintext-must-not-persist");
    expect(row?.ciphertext).not.toContain("refresh-plaintext-must-not-persist");
    if (!row) throw new Error("Expected encrypted MCP OAuth row");
    await expect(provider.tokens()).resolves.toMatchObject({
      access_token: "access-plaintext-must-not-persist",
      refresh_token: "refresh-plaintext-must-not-persist",
    });
    expect(
      () =>
        new D1McpOAuthStorage(
          sqlDatabase(env.DB),
          requireMcpOAuthEncryptionKey(env),
          "durable-object-id-is-not-authority"
        )
    ).toThrow(/logical MCP connection id/i);
    const otherScope = new D1McpOAuthStorage(
      sqlDatabase(env.DB),
      requireMcpOAuthEncryptionKey(env),
      "mcpconn_cccccccccccccccccccccccccccccccc"
    );
    await expect(
      otherScope.get("/open-inspect-mcp/catalog-server/oauth-client/token")
    ).resolves.toBe(undefined);
    await env.DB.prepare(
      `INSERT INTO mcp_oauth_storage (connection_id, storage_key, ciphertext, updated_at)
       VALUES (?, ?, ?, ?)`
    )
      .bind(connection.id, "oauth/swapped-storage-key", row.ciphertext, Date.now())
      .run();
    await expect(storage.get("oauth/swapped-storage-key")).rejects.toThrow();

    const otherServer = await createRemoteServer({
      name: "other-personal-oauth-server",
      url: "https://other-mcp.example.com/mcp",
    });
    const otherConnectionResponse = await serviceFetch("https://test.local/mcp-connections", {
      method: "POST",
      body: JSON.stringify({ serverId: otherServer.id }),
    });
    const otherConnection = await otherConnectionResponse.json<McpConnectionMetadata>();
    const namespace = mcpNamespace();
    const firstBroker = namespace.get(namespace.idFromName(connection.id));
    const secondBroker = namespace.get(namespace.idFromName(otherConnection.id));
    await expect(firstBroker.status()).resolves.toMatchObject({ connectionId: connection.id });
    await expect(secondBroker.status()).resolves.toMatchObject({
      connectionId: otherConnection.id,
    });
    await env.DB.prepare(
      `INSERT INTO mcp_oauth_storage (connection_id, storage_key, ciphertext, updated_at)
       VALUES (?, ?, ?, ?)`
    )
      .bind(otherConnection.id, row.storage_key, row.ciphertext, Date.now())
      .run();
    const swappedStorage = new D1McpOAuthStorage(
      sqlDatabase(env.DB),
      requireMcpOAuthEncryptionKey(env),
      otherConnection.id
    );

    await expect(swappedStorage.get(row.storage_key)).rejects.toThrow();
  });

  it("surfaces the server's authorization URL to the owner and records that it is waiting", async () => {
    const server = await createRemoteServer();
    const created = await serviceFetch("https://test.local/mcp-connections", {
      method: "POST",
      body: JSON.stringify({ serverId: server.id }),
    });
    const connection = await created.json<McpConnectionMetadata>();

    const response = await serviceFetch(
      `https://test.local/mcp-connections/${connection.id}/authorize`,
      { method: "POST", body: JSON.stringify({}) }
    );

    expect(response.status).toBe(200);
    const authorization = await response.json<{ state: string; authUrl?: string }>();
    expect(authorization.state).toBe("authenticating");
    // The server's own authorization URL, and nothing that could be a
    // credential.
    expect(authorization.authUrl).toContain("https://auth.example.com/authorize");
    expect(authorization.authUrl).not.toContain("access_token");
    expect(authorization.authUrl).not.toContain("refresh_token");
    // The durable record says the connection is waiting for its owner.
    const status = await env.DB.prepare("SELECT status FROM mcp_connections WHERE id = ?")
      .bind(connection.id)
      .first<{ status: string }>();
    expect(status?.status).toBe("oauth_authorizing");
    // The owner's own view of the connection says the same thing.
    const listed = await serviceFetch("https://test.local/mcp-connections");
    await expect(listed.json<{ connections: McpConnectionMetadata[] }>()).resolves.toMatchObject({
      connections: [expect.objectContaining({ id: connection.id, status: "oauth_authorizing" })],
    });
    // Asking again gives the owner a URL they can still use: the provider's
    // state is single-use and short-lived, so a stale URL would fail.
    const again = await serviceFetch(
      `https://test.local/mcp-connections/${connection.id}/authorize`,
      { method: "POST", body: JSON.stringify({}) }
    );
    const second = await again.json<{ state: string; authUrl?: string }>();
    expect(second.state).toBe("authenticating");
    expect(new URL(second.authUrl ?? "").searchParams.get("state")).not.toBe(
      new URL(authorization.authUrl ?? "").searchParams.get("state")
    );
  });

  it("refuses to let anybody but the owner authorize a connection", async () => {
    const server = await createRemoteServer();
    const created = await serviceFetch("https://test.local/mcp-connections", {
      method: "POST",
      body: JSON.stringify({ serverId: server.id }),
      as: { userId: OWNER_A, role: "member" },
    });
    const connection = await created.json<McpConnectionMetadata>();

    const otherOwner = await serviceFetch(
      `https://test.local/mcp-connections/${connection.id}/authorize`,
      { method: "POST", body: JSON.stringify({}), as: { userId: OWNER_B, role: "member" } }
    );
    expect(otherOwner.status).toBe(404);

    const servicePrincipal = await buildServiceAuthHeaders({
      service: "slack-bot",
      secret: "test-service-secret-slack-bot",
      method: "POST",
      url: `https://test.local/mcp-connections/${connection.id}/authorize`,
      actor: "slack:U123",
    });
    const viaService = await SELF.fetch(
      `https://test.local/mcp-connections/${connection.id}/authorize`,
      { method: "POST", headers: servicePrincipal }
    );
    expect(viaService.status).toBe(403);

    // Nothing the other owner tried changed the connection.
    const status = await env.DB.prepare("SELECT status FROM mcp_connections WHERE id = ?")
      .bind(connection.id)
      .first<{ status: string }>();
    expect(status?.status).toBe("foundation_staged");
  });

  it("completes the owner's approval and keeps the credential encrypted", async () => {
    const server = await createRemoteServer();
    const created = await serviceFetch("https://test.local/mcp-connections", {
      method: "POST",
      body: JSON.stringify({ serverId: server.id }),
    });
    const connection = await created.json<McpConnectionMetadata>();
    const started = await serviceFetch(
      `https://test.local/mcp-connections/${connection.id}/authorize`,
      { method: "POST", body: JSON.stringify({}) }
    );
    const authorization = await started.json<{ state: string; authUrl?: string }>();
    const state = new URL(authorization.authUrl ?? "").searchParams.get("state");
    expect(state).toBeTruthy();

    const callbackUrl = `https://test.local/mcp/oauth/callback/${connection.id}?code=integration-code&state=${encodeURIComponent(
      state ?? ""
    )}`;
    const callback = await SELF.fetch(callbackUrl, {
      method: "GET",
      headers: await serviceRequestHeaders(callbackUrl, { method: "GET" }),
      redirect: "manual",
    });

    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe(
      "https://app.test.local/settings?tab=mcp-servers"
    );
    const status = await env.DB.prepare("SELECT status FROM mcp_connections WHERE id = ?")
      .bind(connection.id)
      .first<{ status: string }>();
    expect(status?.status).toBe("oauth_ready");
    // The credential is stored encrypted, and only for this connection.
    const rows = await env.DB.prepare(
      "SELECT ciphertext FROM mcp_oauth_storage WHERE connection_id = ?"
    )
      .bind(connection.id)
      .all<{ ciphertext: string }>();
    expect(rows.results.length).toBeGreaterThan(0);
    for (const row of rows.results ?? []) {
      expect(row.ciphertext).not.toContain("integration-access-token");
      expect(row.ciphertext).not.toContain("integration-refresh-token");
    }
    // The owner's own view of the connection says it is authorized.
    const listed = await serviceFetch("https://test.local/mcp-connections");
    await expect(listed.json<{ connections: McpConnectionMetadata[] }>()).resolves.toMatchObject({
      connections: [expect.objectContaining({ id: connection.id, status: "oauth_ready" })],
    });
  });

  it("replaces a credential the provider refused when the owner reconnects", async () => {
    const server = await createRemoteServer();
    const created = await serviceFetch("https://test.local/mcp-connections", {
      method: "POST",
      body: JSON.stringify({ serverId: server.id }),
    });
    const connection = await created.json<McpConnectionMetadata>();
    const started = await serviceFetch(
      `https://test.local/mcp-connections/${connection.id}/authorize`,
      { method: "POST", body: JSON.stringify({}) }
    );
    const authorization = await started.json<{ state: string; authUrl?: string }>();
    const state = new URL(authorization.authUrl ?? "").searchParams.get("state");
    const callbackUrl = `https://test.local/mcp/oauth/callback/${connection.id}?code=integration-code&state=${encodeURIComponent(
      state ?? ""
    )}`;
    await SELF.fetch(callbackUrl, {
      method: "GET",
      headers: await serviceRequestHeaders(callbackUrl, { method: "GET" }),
      redirect: "manual",
    });
    const stored = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM mcp_oauth_storage WHERE connection_id = ?"
    )
      .bind(connection.id)
      .first<{ count: number }>();
    expect(stored?.count).toBeGreaterThan(0);
    const storage = new D1McpOAuthStorage(
      sqlDatabase(env.DB),
      requireMcpOAuthEncryptionKey(env),
      connection.id
    );
    const keysBefore = [...(await storage.list({ prefix: "/open-inspect-mcp/" })).keys()];
    expect(keysBefore.some((key) => key.endsWith("/token"))).toBe(true);

    const reconnected = await serviceFetch(
      `https://test.local/mcp-connections/${connection.id}/authorize`,
      { method: "POST", body: JSON.stringify({ reconnect: true }) }
    );
    const result = await reconnected.json<{ state: string; authUrl?: string }>();
    expect(result.state).toBe("authenticating");
    // The owner's explicit act discarded the credential the provider refused:
    // the token is gone, and only the new handshake's material is left.
    const keysAfter = [...(await storage.list({ prefix: "/open-inspect-mcp/" })).keys()];
    expect(keysAfter.some((key) => key.endsWith("/token"))).toBe(false);
  });
});

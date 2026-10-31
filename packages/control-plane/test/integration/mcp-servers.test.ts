import { describe, it, expect, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import type { BuiltInRoleKey } from "@open-inspect/shared/rbac";
import { encryptToken, generateEncryptionKey } from "../../src/auth/crypto";
import { McpServerConflictError, McpServerStore } from "../../src/db/mcp-servers";
import type { SqlDatabase } from "../../src/db/sql-database";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch, type ServiceRequestInit } from "./helpers";

interface McpServerMetadata {
  id: string;
  revision: number;
  name: string;
  type: "local" | "remote";
  command?: string[];
  url?: string;
  hasEnv: boolean;
  hasHeaders: boolean;
  credentialKeys?: string[];
  repoScopes: string[] | null;
  enabled: boolean;
}

/** The credentials stored for a server, read the way sessions read them. */
async function storedCredentials(id: string): Promise<Record<string, string> | undefined> {
  const store = new McpServerStore(env.DB, env.REPO_SECRETS_ENCRYPTION_KEY!);
  const server = (await store.getForLaunch([])).find((s) => s.id === id);
  return server?.type === "remote" ? server.headers : server?.env;
}

describe("MCP Servers API", () => {
  beforeEach(cleanD1Tables);

  describe("POST /mcp-servers", () => {
    it("creates a local server", async () => {
      const response = await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          name: "playwright",
          type: "local",
          command: ["npx", "-y", "@playwright/mcp"],
          env: { DEBUG: "1" },
        }),
      });
      expect(response.status).toBe(201);
      const body = await response.json<McpServerMetadata>();
      expect(body.name).toBe("playwright");
      expect(body.type).toBe("local");
      expect(body.command).toEqual(["npx", "-y", "@playwright/mcp"]);
      expect(body.hasEnv).toBe(true);
      expect(body.enabled).toBe(true);
      expect(body.id).toBeTruthy();
      expect(body.revision).toBe(1);
    });

    it("creates a remote server", async () => {
      const response = await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          name: "remote-api",
          type: "remote",
          url: "https://mcp.example.com/sse",
          headers: { Authorization: "Bearer sk-test" },
        }),
      });
      expect(response.status).toBe(201);
      const body = await response.json<McpServerMetadata>();
      expect(body.name).toBe("remote-api");
      expect(body.type).toBe("remote");
      expect(body.url).toBe("https://mcp.example.com/sse");
      expect(body.hasHeaders).toBe(true);
      expect(body.credentialKeys).toEqual(["Authorization"]);
      // Credentials should NOT be in the response
      expect("headers" in body).toBe(false);
      expect("env" in body).toBe(false);
      expect(JSON.stringify(body)).not.toContain("sk-test");
    });

    it("returns 400 for missing name", async () => {
      const response = await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({ type: "local", command: ["npx", "x"] }),
      });
      expect(response.status).toBe(400);
    });

    it("returns 400 for invalid type", async () => {
      const response = await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({ name: "test", type: "invalid" }),
      });
      expect(response.status).toBe(400);
    });

    it("returns 400 for local without command", async () => {
      const response = await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({ name: "test", type: "local" }),
      });
      expect(response.status).toBe(400);
    });

    it("returns 400 for remote without url", async () => {
      const response = await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({ name: "test", type: "remote" }),
      });
      expect(response.status).toBe(400);
    });

    it.each([
      ["non-string URL", { url: 42 }],
      ["malformed URL", { url: "not a url" }],
      ["non-string environment value", { env: { DEBUG: true } }],
      ["environment on a remote server", { env: { TOKEN: "secret" } }],
      ["non-object headers", { headers: ["Authorization"] }],
      ["non-boolean enabled", { enabled: "yes" }],
      ["unknown fields", { unexpected: true }],
    ])("returns 400 for %s", async (_description, invalidField) => {
      const response = await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          name: "invalid",
          type: "remote",
          url: "https://test.example.com",
          ...invalidField,
        }),
      });

      expect(response.status).toBe(400);
    });

    it("returns 400 for headers on a local server", async () => {
      const response = await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          name: "invalid-local-headers",
          type: "local",
          command: ["npx", "x"],
          headers: { Authorization: "secret" },
        }),
      });

      expect(response.status).toBe(400);
    });

    it("returns 400 for duplicate name", async () => {
      await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          name: "duplicate",
          type: "remote",
          url: "https://first.example.com",
        }),
      });
      const response = await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          name: "duplicate",
          type: "remote",
          url: "https://second.example.com",
        }),
      });
      expect(response.status).toBe(400);
    });

    it("returns 401 without auth headers", async () => {
      const response = await SELF.fetch("https://test.local/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test", type: "remote", url: "https://x.com" }),
      });
      expect(response.status).toBe(401);
    });
  });

  describe("GET /mcp-servers", () => {
    it("lists all servers", async () => {
      // Create two servers
      await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          name: "server-a",
          type: "remote",
          url: "https://a.example.com",
        }),
      });
      await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          name: "server-b",
          type: "local",
          command: ["npx", "x"],
        }),
      });

      const response = await serviceFetch("https://test.local/mcp-servers");
      expect(response.status).toBe(200);
      const body = await response.json<McpServerMetadata[]>();
      expect(body).toHaveLength(2);
      // Ordered by name
      expect(body[0].name).toBe("server-a");
      expect(body[1].name).toBe("server-b");
    });

    it("returns empty list when no servers exist", async () => {
      const response = await serviceFetch("https://test.local/mcp-servers");
      expect(response.status).toBe(200);
      const body = await response.json<McpServerMetadata[]>();
      expect(body).toEqual([]);
    });

    it("never includes credentials in response", async () => {
      await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          name: "with-creds",
          type: "remote",
          url: "https://mcp.example.com",
          headers: { Authorization: "Bearer secret-token" },
        }),
      });

      const response = await serviceFetch("https://test.local/mcp-servers");
      const body = await response.json<McpServerMetadata[]>();
      const server = body[0];
      expect(server.hasHeaders).toBe(true);
      expect(server.credentialKeys).toEqual(["Authorization"]);
      expect("headers" in server).toBe(false);
      expect("env" in server).toBe(false);
      expect(JSON.stringify(server)).not.toContain("secret-token");
    });
  });

  describe("GET /mcp-servers/:id", () => {
    it("returns a server by id", async () => {
      const createRes = await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          name: "get-test",
          type: "remote",
          url: "https://test.example.com",
        }),
      });
      const created = await createRes.json<McpServerMetadata>();

      const response = await serviceFetch(`https://test.local/mcp-servers/${created.id}`);
      expect(response.status).toBe(200);
      const body = await response.json<McpServerMetadata>();
      expect(body.name).toBe("get-test");
    });

    it("returns 404 for missing server", async () => {
      const response = await serviceFetch("https://test.local/mcp-servers/nonexistent");
      expect(response.status).toBe(404);
    });
  });

  describe("PUT /mcp-servers/:id", () => {
    it("updates server fields", async () => {
      const createRes = await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          name: "to-update",
          type: "remote",
          url: "https://original.example.com",
        }),
      });
      const created = await createRes.json<McpServerMetadata>();

      const response = await serviceFetch(`https://test.local/mcp-servers/${created.id}`, {
        method: "PUT",
        body: JSON.stringify({ name: "updated-name", url: "https://new.example.com" }),
      });
      expect(response.status).toBe(200);
      const body = await response.json<McpServerMetadata>();
      expect(body.name).toBe("updated-name");
      expect(body.url).toBe("https://new.example.com");
      expect(body.revision).toBe(2);
    });

    it("keeps named headers, replaces edited ones, and drops the rest", async () => {
      const createRes = await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          name: "partial-headers",
          type: "remote",
          url: "https://mcp.example.com",
          headers: { "x-api-key": "old-key", Accept: "text/event-stream", "X-Trace": "1" },
        }),
      });
      const created = await createRes.json<McpServerMetadata>();

      const response = await serviceFetch(`https://test.local/mcp-servers/${created.id}`, {
        method: "PUT",
        body: JSON.stringify({
          headers: { "x-api-key": "new-key" },
          keepCredentialKeys: ["Accept"],
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.json<McpServerMetadata>();
      expect(body.credentialKeys).toEqual(["Accept", "x-api-key"]);
      expect(JSON.stringify(body)).not.toContain("new-key");
      expect(await storedCredentials(created.id)).toEqual({
        Accept: "text/event-stream",
        "x-api-key": "new-key",
      });
    });

    it("keeps a saved header named in another letter case", async () => {
      const createRes = await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          name: "case-headers",
          type: "remote",
          url: "https://mcp.example.com",
          headers: { Authorization: "Bearer t", Accept: "text/event-stream" },
        }),
      });
      const created = await createRes.json<McpServerMetadata>();

      const response = await serviceFetch(`https://test.local/mcp-servers/${created.id}`, {
        method: "PUT",
        body: JSON.stringify({ headers: {}, keepCredentialKeys: ["authorization"] }),
      });

      expect(response.status).toBe(200);
      expect((await response.json<McpServerMetadata>()).credentialKeys).toEqual(["Authorization"]);
      expect(await storedCredentials(created.id)).toEqual({ Authorization: "Bearer t" });
    });

    it("refuses to keep saved credentials it cannot decrypt and changes nothing", async () => {
      const createRes = await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          name: "unreadable-headers",
          type: "remote",
          url: "https://mcp.example.com",
          headers: { Authorization: "Bearer t" },
        }),
      });
      const created = await createRes.json<McpServerMetadata>();
      // Simulate credentials encrypted under a key this control plane does not hold.
      const foreign = await encryptToken(
        JSON.stringify({ Authorization: "Bearer t" }),
        generateEncryptionKey()
      );
      await env.DB.prepare("UPDATE mcp_servers SET env = ? WHERE id = ?")
        .bind(foreign, created.id)
        .run();

      const response = await serviceFetch(`https://test.local/mcp-servers/${created.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: "renamed",
          headers: {},
          keepCredentialKeys: ["Authorization"],
          revision: created.revision,
        }),
      });

      expect(response.status).toBe(409);
      expect((await response.json<{ error: string }>()).error).toMatch(/cannot be decrypted/);
      const row = await env.DB.prepare("SELECT name, env, revision FROM mcp_servers WHERE id = ?")
        .bind(created.id)
        .first<{ name: string; env: string; revision: number }>();
      expect(row).toEqual({ name: "unreadable-headers", env: foreign, revision: created.revision });
    });

    it("refuses a keep update that raced a credential change, keeping the newer credentials", async () => {
      const createRes = await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          name: "raced-headers",
          type: "remote",
          url: "https://mcp.example.com",
          headers: { Authorization: "Bearer old", Accept: "text/event-stream" },
        }),
      });
      const created = await createRes.json<McpServerMetadata>();
      const key = env.REPO_SECRETS_ENCRYPTION_KEY!;
      // Replace the credentials right after the racing store's initial read.
      let raced = false;
      const racingDb = {
        prepare(sql: string) {
          const statement = env.DB.prepare(sql);
          if (!sql.startsWith("SELECT")) return statement;
          return {
            bind: (...params: unknown[]) => ({
              first: async () => {
                const row = await statement.bind(...params).first();
                if (!raced) {
                  raced = true;
                  await new McpServerStore(env.DB, key).update(created.id, {
                    headers: { Authorization: "Bearer new" },
                  });
                }
                return row;
              },
            }),
          };
        },
      } as unknown as SqlDatabase;

      await expect(
        new McpServerStore(racingDb, key).update(created.id, {
          headers: {},
          keepCredentialKeys: ["Authorization", "Accept"],
        })
      ).rejects.toThrow(McpServerConflictError);
      expect(raced).toBe(true);
      expect(await storedCredentials(created.id)).toEqual({ Authorization: "Bearer new" });
    });

    it("keeps every saved env var when all are kept and none are sent", async () => {
      const createRes = await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          name: "kept-env",
          type: "local",
          command: ["npx", "x"],
          env: { API_TOKEN: "token-1", REGION: "eu" },
        }),
      });
      const created = await createRes.json<McpServerMetadata>();

      const response = await serviceFetch(`https://test.local/mcp-servers/${created.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: "kept-env-renamed",
          env: {},
          keepCredentialKeys: ["API_TOKEN", "REGION"],
          revision: created.revision,
        }),
      });
      expect(response.status).toBe(200);
      expect(await storedCredentials(created.id)).toEqual({ API_TOKEN: "token-1", REGION: "eu" });
    });

    it("rejects a stale revision and accepts a retry from the latest revision", async () => {
      const createRes = await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          name: "concurrent-update",
          type: "remote",
          url: "https://original.example.com",
        }),
      });
      const created = await createRes.json<McpServerMetadata>();

      const updates = await Promise.all(
        ["first-writer", "second-writer"].map((name) =>
          serviceFetch(`https://test.local/mcp-servers/${created.id}`, {
            method: "PUT",
            body: JSON.stringify({ name, revision: created.revision }),
          })
        )
      );
      expect(updates.map((response) => response.status).sort()).toEqual([200, 409]);
      const successfulUpdate = updates.find((response) => response.status === 200);
      expect(successfulUpdate).toBeDefined();
      const revised = await successfulUpdate!.json<McpServerMetadata>();

      const retry = await serviceFetch(`https://test.local/mcp-servers/${created.id}`, {
        method: "PUT",
        body: JSON.stringify({ name: "retry-writer", revision: revised.revision }),
      });
      expect(retry.status).toBe(200);
      await expect(retry.json<McpServerMetadata>()).resolves.toMatchObject({
        name: "retry-writer",
        revision: 3,
      });
    });

    it("rejects stale revisions before validating against newer row state", async () => {
      const createRes = await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          name: "stale-validation",
          type: "remote",
          url: "https://original.example.com",
        }),
      });
      const created = await createRes.json<McpServerMetadata>();

      const typeChange = await serviceFetch(`https://test.local/mcp-servers/${created.id}`, {
        method: "PUT",
        body: JSON.stringify({
          type: "local",
          command: ["npx", "tool"],
          revision: created.revision,
        }),
      });
      expect(typeChange.status).toBe(200);

      const staleUpdate = await serviceFetch(`https://test.local/mcp-servers/${created.id}`, {
        method: "PUT",
        body: JSON.stringify({
          url: "https://stale.example.com",
          revision: created.revision,
        }),
      });
      expect(staleUpdate.status).toBe(409);
    });

    it("returns 404 for missing server", async () => {
      const response = await serviceFetch("https://test.local/mcp-servers/nonexistent", {
        method: "PUT",
        body: JSON.stringify({ name: "nope" }),
      });
      expect(response.status).toBe(404);
    });

    it("returns 400 for invalid type change without required field", async () => {
      const createRes = await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          name: "type-change",
          type: "remote",
          url: "https://test.example.com",
        }),
      });
      const created = await createRes.json<McpServerMetadata>();

      // Change to local without providing command
      const response = await serviceFetch(`https://test.local/mcp-servers/${created.id}`, {
        method: "PUT",
        body: JSON.stringify({ type: "local" }),
      });
      expect(response.status).toBe(400);
    });

    it("changes a local server to remote without retaining command", async () => {
      const createRes = await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          name: "local-to-remote",
          type: "local",
          command: ["npx", "x"],
          env: { TOKEN: "secret" },
        }),
      });
      const created = await createRes.json<McpServerMetadata>();

      const response = await serviceFetch(`https://test.local/mcp-servers/${created.id}`, {
        method: "PUT",
        body: JSON.stringify({ type: "remote", url: "https://remote.example.com" }),
      });

      expect(response.status).toBe(200);
      const body = await response.json<McpServerMetadata>();
      expect(body.type).toBe("remote");
      expect(body.url).toBe("https://remote.example.com");
      expect(body.command).toBeUndefined();
      const row = await env.DB.prepare("SELECT command, env FROM mcp_servers WHERE id = ?")
        .bind(created.id)
        .first<{ command: string | null; env: string }>();
      expect(row?.command).toBeNull();
      expect(row?.env).toBe("{}");
    });

    it("changes a remote server to local without retaining URL", async () => {
      const createRes = await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          name: "remote-to-local",
          type: "remote",
          url: "https://remote.example.com",
          headers: { Authorization: "secret" },
        }),
      });
      const created = await createRes.json<McpServerMetadata>();

      const response = await serviceFetch(`https://test.local/mcp-servers/${created.id}`, {
        method: "PUT",
        body: JSON.stringify({ type: "local", command: ["npx", "x"] }),
      });

      expect(response.status).toBe(200);
      const body = await response.json<McpServerMetadata>();
      expect(body.type).toBe("local");
      expect(body.command).toEqual(["npx", "x"]);
      expect(body.url).toBeUndefined();
      const row = await env.DB.prepare("SELECT url, env FROM mcp_servers WHERE id = ?")
        .bind(created.id)
        .first<{ url: string | null; env: string }>();
      expect(row?.url).toBeNull();
      expect(row?.env).toBe("{}");
    });

    it.each([
      ["invalid type", { type: "stdio" }],
      ["non-string URL", { url: 42 }],
      ["malformed URL", { url: "not a url" }],
      ["non-object environment", { env: ["DEBUG=1"] }],
      ["environment on a remote server", { env: { DEBUG: "1" } }],
      ["non-string header value", { headers: { Authorization: 123 } }],
      ["non-boolean enabled", { enabled: 1 }],
      ["unknown fields", { id: "replacement" }],
    ])("returns 400 for %s", async (_description, patch) => {
      const createRes = await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          name: `invalid-update-${_description}`,
          type: "remote",
          url: "https://test.example.com",
        }),
      });
      const created = await createRes.json<McpServerMetadata>();

      const response = await serviceFetch(`https://test.local/mcp-servers/${created.id}`, {
        method: "PUT",
        body: JSON.stringify(patch),
      });

      expect(response.status).toBe(400);
    });

    it("returns 400 for headers on an existing local server", async () => {
      const createRes = await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({ name: "local-update", type: "local", command: ["npx", "x"] }),
      });
      const created = await createRes.json<McpServerMetadata>();

      const response = await serviceFetch(`https://test.local/mcp-servers/${created.id}`, {
        method: "PUT",
        body: JSON.stringify({ headers: { Authorization: "secret" } }),
      });

      expect(response.status).toBe(400);
    });
  });

  describe("saved credential names", () => {
    const SECRET_VALUES = ["Bearer header-secret", "header-key-secret", "env-secret", "new-secret"];
    const MANAGER = { userId: "71717171717171717171717171717171", role: "administrator" } as const;

    function as(userId: string, role: BuiltInRoleKey): Pick<ServiceRequestInit, "as"> {
      return { as: { userId, role } };
    }

    async function createServers(): Promise<{
      remote: McpServerMetadata;
      local: McpServerMetadata;
    }> {
      const remoteRes = await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          name: "named-remote",
          type: "remote",
          url: "https://mcp.example.com",
          headers: { Authorization: "Bearer header-secret", "X-Api-Key": "header-key-secret" },
        }),
        as: MANAGER,
      });
      const localRes = await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          name: "named-local",
          type: "local",
          command: ["npx", "x"],
          env: { API_TOKEN: "env-secret" },
        }),
        as: MANAGER,
      });
      expect(remoteRes.status).toBe(201);
      expect(localRes.status).toBe(201);
      return {
        remote: await remoteRes.json<McpServerMetadata>(),
        local: await localRes.json<McpServerMetadata>(),
      };
    }

    it.each([
      ["viewer", "73737373737373737373737373737373"],
      ["member", "74747474747474747474747474747474"],
    ] as const)("omits names for a %s, who can only read MCP servers", async (role, userId) => {
      const { remote, local } = await createServers();
      const reader = as(userId, role);

      const listRes = await serviceFetch("https://test.local/mcp-servers", reader);
      const getRes = await serviceFetch(`https://test.local/mcp-servers/${remote.id}`, reader);
      const putRes = await serviceFetch(`https://test.local/mcp-servers/${local.id}`, {
        ...reader,
        method: "PUT",
        body: JSON.stringify({ keepCredentialKeys: [] }),
      });

      expect(listRes.status).toBe(200);
      expect(getRes.status).toBe(200);
      expect(putRes.status).toBe(403);
      const listed = await listRes.json<McpServerMetadata[]>();
      const got = await getRes.json<McpServerMetadata>();
      expect(listed.map((s) => [s.name, s.hasEnv || s.hasHeaders])).toEqual([
        ["named-local", true],
        ["named-remote", true],
      ]);
      for (const server of [...listed, got]) {
        expect("credentialKeys" in server).toBe(false);
      }
      expect(await storedCredentials(local.id)).toEqual({ API_TOKEN: "env-secret" });
    });

    it("returns names to a manager", async () => {
      const { remote, local } = await createServers();
      expect(remote.credentialKeys).toEqual(["Authorization", "X-Api-Key"]);
      expect(local.credentialKeys).toEqual(["API_TOKEN"]);

      const listRes = await serviceFetch("https://test.local/mcp-servers", { as: MANAGER });
      const getRes = await serviceFetch(`https://test.local/mcp-servers/${remote.id}`, {
        as: MANAGER,
      });

      const listed = await listRes.json<McpServerMetadata[]>();
      expect(listed.map((s) => s.credentialKeys)).toEqual([
        ["API_TOKEN"],
        ["Authorization", "X-Api-Key"],
      ]);
      expect((await getRes.json<McpServerMetadata>()).credentialKeys).toEqual([
        "Authorization",
        "X-Api-Key",
      ]);
    });

    it("never returns a credential value from create, list, get, or update", async () => {
      const { remote, local } = await createServers();
      const reader = as("72727272727272727272727272727272", "viewer");
      const bodies: string[] = [JSON.stringify(remote), JSON.stringify(local)];
      const responses = [
        await serviceFetch("https://test.local/mcp-servers", { as: MANAGER }),
        await serviceFetch("https://test.local/mcp-servers?repo=acme/web", { as: MANAGER }),
        await serviceFetch(`https://test.local/mcp-servers/${remote.id}`, { as: MANAGER }),
        await serviceFetch("https://test.local/mcp-servers", reader),
        await serviceFetch(`https://test.local/mcp-servers/${local.id}`, reader),
        await serviceFetch(`https://test.local/mcp-servers/${remote.id}`, {
          as: MANAGER,
          method: "PUT",
          body: JSON.stringify({
            headers: { "x-api-key": "new-secret" },
            keepCredentialKeys: ["Authorization"],
          }),
        }),
        await serviceFetch(`https://test.local/mcp-servers/${local.id}`, {
          as: MANAGER,
          method: "PUT",
          body: JSON.stringify({ enabled: false }),
        }),
        await serviceFetch(`https://test.local/mcp-servers/${local.id}`, {
          as: MANAGER,
          method: "PUT",
          body: JSON.stringify({ env: { API_TOKEN: "new-secret" } }),
        }),
      ];

      for (const response of responses) {
        expect(response.status).toBe(200);
        bodies.push(await response.text());
      }
      for (const body of bodies) {
        for (const value of SECRET_VALUES) expect(body).not.toContain(value);
        expect(body).not.toMatch(/"(env|headers)":/);
      }
      expect(await storedCredentials(remote.id)).toEqual({
        Authorization: "Bearer header-secret",
        "x-api-key": "new-secret",
      });
    });
  });

  describe("DELETE /mcp-servers/:id", () => {
    it("deletes a server", async () => {
      const createRes = await serviceFetch("https://test.local/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          name: "to-delete",
          type: "remote",
          url: "https://test.example.com",
        }),
      });
      const created = await createRes.json<McpServerMetadata>();

      const response = await serviceFetch(`https://test.local/mcp-servers/${created.id}`, {
        method: "DELETE",
      });
      expect(response.status).toBe(200);

      // Verify it's gone
      const getRes = await serviceFetch(`https://test.local/mcp-servers/${created.id}`);
      expect(getRes.status).toBe(404);
    });

    it("returns 404 for missing server", async () => {
      const response = await serviceFetch("https://test.local/mcp-servers/nonexistent", {
        method: "DELETE",
      });
      expect(response.status).toBe(404);
    });
  });
});

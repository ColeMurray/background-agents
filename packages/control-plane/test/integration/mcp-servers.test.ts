import { describe, it, expect, beforeEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

interface McpServerMetadata {
  id: string;
  revision: number;
  name: string;
  type: "local" | "remote";
  command?: string[];
  url?: string;
  hasEnv: boolean;
  hasHeaders: boolean;
  repoScopes: string[] | null;
  enabled: boolean;
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
      // Credentials should NOT be in the response
      expect("headers" in body).toBe(false);
      expect("env" in body).toBe(false);
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
      expect("headers" in server).toBe(false);
      expect("env" in server).toBe(false);
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

import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { generateInternalToken } from "../../src/auth/internal";
import { cleanD1Tables } from "./cleanup";

async function authHeaders(): Promise<Record<string, string>> {
  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

interface McpServerMetadata {
  id: string;
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
      const headers = await authHeaders();
      const response = await SELF.fetch("https://test.local/mcp-servers", {
        method: "POST",
        headers,
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
    });

    it("creates a remote server", async () => {
      const headers = await authHeaders();
      const response = await SELF.fetch("https://test.local/mcp-servers", {
        method: "POST",
        headers,
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
      const headers = await authHeaders();
      const response = await SELF.fetch("https://test.local/mcp-servers", {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "local", command: ["npx", "x"] }),
      });
      expect(response.status).toBe(400);
    });

    it("returns 400 for invalid type", async () => {
      const headers = await authHeaders();
      const response = await SELF.fetch("https://test.local/mcp-servers", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "test", type: "invalid" }),
      });
      expect(response.status).toBe(400);
    });

    it("returns 400 for local without command", async () => {
      const headers = await authHeaders();
      const response = await SELF.fetch("https://test.local/mcp-servers", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "test", type: "local" }),
      });
      expect(response.status).toBe(400);
    });

    it("returns 400 for remote without url", async () => {
      const headers = await authHeaders();
      const response = await SELF.fetch("https://test.local/mcp-servers", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "test", type: "remote" }),
      });
      expect(response.status).toBe(400);
    });

    it("returns 400 for duplicate name", async () => {
      const headers = await authHeaders();
      await SELF.fetch("https://test.local/mcp-servers", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "duplicate",
          type: "remote",
          url: "https://first.example.com",
        }),
      });
      const response = await SELF.fetch("https://test.local/mcp-servers", {
        method: "POST",
        headers,
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
      const headers = await authHeaders();

      // Create two servers
      await SELF.fetch("https://test.local/mcp-servers", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "server-a",
          type: "remote",
          url: "https://a.example.com",
        }),
      });
      await SELF.fetch("https://test.local/mcp-servers", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "server-b",
          type: "local",
          command: ["npx", "x"],
        }),
      });

      const response = await SELF.fetch("https://test.local/mcp-servers", { headers });
      expect(response.status).toBe(200);
      const body = await response.json<McpServerMetadata[]>();
      expect(body).toHaveLength(2);
      // Ordered by name
      expect(body[0].name).toBe("server-a");
      expect(body[1].name).toBe("server-b");
    });

    it("returns empty list when no servers exist", async () => {
      const headers = await authHeaders();
      const response = await SELF.fetch("https://test.local/mcp-servers", { headers });
      expect(response.status).toBe(200);
      const body = await response.json<McpServerMetadata[]>();
      expect(body).toEqual([]);
    });

    it("never includes credentials in response", async () => {
      const headers = await authHeaders();
      await SELF.fetch("https://test.local/mcp-servers", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "with-creds",
          type: "remote",
          url: "https://mcp.example.com",
          headers: { Authorization: "Bearer secret-token" },
        }),
      });

      const response = await SELF.fetch("https://test.local/mcp-servers", { headers });
      const body = await response.json<McpServerMetadata[]>();
      const server = body[0];
      expect(server.hasHeaders).toBe(true);
      expect("headers" in server).toBe(false);
      expect("env" in server).toBe(false);
    });
  });

  describe("GET /mcp-servers/:id", () => {
    it("returns a server by id", async () => {
      const headers = await authHeaders();
      const createRes = await SELF.fetch("https://test.local/mcp-servers", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "get-test",
          type: "remote",
          url: "https://test.example.com",
        }),
      });
      const created = await createRes.json<McpServerMetadata>();

      const response = await SELF.fetch(`https://test.local/mcp-servers/${created.id}`, {
        headers,
      });
      expect(response.status).toBe(200);
      const body = await response.json<McpServerMetadata>();
      expect(body.name).toBe("get-test");
    });

    it("returns 404 for missing server", async () => {
      const headers = await authHeaders();
      const response = await SELF.fetch("https://test.local/mcp-servers/nonexistent", { headers });
      expect(response.status).toBe(404);
    });
  });

  describe("PUT /mcp-servers/:id", () => {
    it("updates server fields", async () => {
      const headers = await authHeaders();
      const createRes = await SELF.fetch("https://test.local/mcp-servers", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "to-update",
          type: "remote",
          url: "https://original.example.com",
        }),
      });
      const created = await createRes.json<McpServerMetadata>();

      const response = await SELF.fetch(`https://test.local/mcp-servers/${created.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ name: "updated-name", url: "https://new.example.com" }),
      });
      expect(response.status).toBe(200);
      const body = await response.json<McpServerMetadata>();
      expect(body.name).toBe("updated-name");
      expect(body.url).toBe("https://new.example.com");
    });

    it("returns 404 for missing server", async () => {
      const headers = await authHeaders();
      const response = await SELF.fetch("https://test.local/mcp-servers/nonexistent", {
        method: "PUT",
        headers,
        body: JSON.stringify({ name: "nope" }),
      });
      expect(response.status).toBe(404);
    });

    it("returns 400 for invalid type change without required field", async () => {
      const headers = await authHeaders();
      const createRes = await SELF.fetch("https://test.local/mcp-servers", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "type-change",
          type: "remote",
          url: "https://test.example.com",
        }),
      });
      const created = await createRes.json<McpServerMetadata>();

      // Change to local without providing command
      const response = await SELF.fetch(`https://test.local/mcp-servers/${created.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ type: "local" }),
      });
      expect(response.status).toBe(400);
    });
  });

  describe("DELETE /mcp-servers/:id", () => {
    it("deletes a server", async () => {
      const headers = await authHeaders();
      const createRes = await SELF.fetch("https://test.local/mcp-servers", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "to-delete",
          type: "remote",
          url: "https://test.example.com",
        }),
      });
      const created = await createRes.json<McpServerMetadata>();

      const response = await SELF.fetch(`https://test.local/mcp-servers/${created.id}`, {
        method: "DELETE",
        headers,
      });
      expect(response.status).toBe(200);

      // Verify it's gone
      const getRes = await SELF.fetch(`https://test.local/mcp-servers/${created.id}`, { headers });
      expect(getRes.status).toBe(404);
    });

    it("returns 404 for missing server", async () => {
      const headers = await authHeaders();
      const response = await SELF.fetch("https://test.local/mcp-servers/nonexistent", {
        method: "DELETE",
        headers,
      });
      expect(response.status).toBe(404);
    });
  });
});

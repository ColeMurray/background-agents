import { describe, it, expect, beforeEach } from "vitest";
import { SELF } from "cloudflare:test";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

describe("Global secrets API", () => {
  beforeEach(cleanD1Tables);

  describe("PUT /secrets", () => {
    it("creates global secrets", async () => {
      const response = await serviceFetch("https://test.local/secrets", {
        method: "PUT",
        body: JSON.stringify({ secrets: { MY_KEY: "my-value" } }),
      });
      expect(response.status).toBe(200);
      const body = await response.json<{ status: string; keys: string[]; created: number }>();
      expect(body.status).toBe("updated");
      expect(body.keys).toEqual(["MY_KEY"]);
      expect(body.created).toBe(1);
    });

    it("rejects reserved keys", async () => {
      const response = await serviceFetch("https://test.local/secrets", {
        method: "PUT",
        body: JSON.stringify({ secrets: { PATH: "nope" } }),
      });
      expect(response.status).toBe(400);
    });

    it("rejects requests without body", async () => {
      const response = await serviceFetch("https://test.local/secrets", {
        method: "PUT",
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
    });

    it("returns 401 without auth", async () => {
      const response = await SELF.fetch("https://test.local/secrets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: { FOO: "bar" } }),
      });
      expect(response.status).toBe(401);
    });
  });

  describe("GET /secrets", () => {
    it("lists global secret keys", async () => {
      // Create secrets first
      await serviceFetch("https://test.local/secrets", {
        method: "PUT",
        body: JSON.stringify({ secrets: { ALPHA: "1", BETA: "2" } }),
      });

      const response = await serviceFetch("https://test.local/secrets");
      expect(response.status).toBe(200);
      const body = await response.json<{ secrets: Array<{ key: string }> }>();
      expect(body.secrets.map((s) => s.key)).toEqual(["ALPHA", "BETA"]);
    });

    it("returns empty list when no secrets exist", async () => {
      const response = await serviceFetch("https://test.local/secrets");
      expect(response.status).toBe(200);
      const body = await response.json<{ secrets: unknown[] }>();
      expect(body.secrets).toEqual([]);
    });
  });

  describe("DELETE /secrets/:key", () => {
    it("deletes an existing global secret", async () => {
      await serviceFetch("https://test.local/secrets", {
        method: "PUT",
        body: JSON.stringify({ secrets: { TO_DELETE: "val" } }),
      });

      const response = await serviceFetch("https://test.local/secrets/TO_DELETE", {
        method: "DELETE",
      });
      expect(response.status).toBe(200);
      const body = await response.json<{ status: string; key: string }>();
      expect(body.status).toBe("deleted");
      expect(body.key).toBe("TO_DELETE");

      // Verify it's gone
      const listRes = await serviceFetch("https://test.local/secrets");
      const listBody = await listRes.json<{ secrets: unknown[] }>();
      expect(listBody.secrets).toEqual([]);
    });

    it("returns 404 for nonexistent key", async () => {
      const response = await serviceFetch("https://test.local/secrets/NOPE", {
        method: "DELETE",
      });
      expect(response.status).toBe(404);
    });
  });
});

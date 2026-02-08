import { describe, it, expect } from "vitest";
import { SELF, env } from "cloudflare:test";
import { generateInternalToken } from "../../src/auth/internal";

async function authHeaders(): Promise<Record<string, string>> {
  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);
  return { Authorization: `Bearer ${token}` };
}

describe("Worker fetch handler", () => {
  it("returns 404 for unknown authenticated paths", async () => {
    const response = await SELF.fetch("https://test.local/unknown-path", {
      headers: await authHeaders(),
    });
    expect(response.status).toBe(404);
    const body = await response.json<{ error: string }>();
    expect(body.error).toBe("Not found");
  });

  it("handles CORS preflight OPTIONS requests", async () => {
    const response = await SELF.fetch("https://test.local/sessions", {
      method: "OPTIONS",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("returns healthy on GET /health", async () => {
    const response = await SELF.fetch("https://test.local/health");
    expect(response.status).toBe(200);
    const body = await response.json<{ status: string; service: string }>();
    expect(body.status).toBe("healthy");
    expect(body.service).toBe("open-inspect-control-plane");
  });

  it("includes correlation headers in responses", async () => {
    const response = await SELF.fetch("https://test.local/health");
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(response.headers.get("x-trace-id")).toBeTruthy();
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { generateInternalToken } from "../../src/auth/internal";
import { cleanD1Tables } from "./cleanup";

describe("HMAC authentication", () => {
  beforeEach(cleanD1Tables);

  it("rejects requests without Authorization header", async () => {
    const response = await SELF.fetch("https://test.local/sessions");
    expect(response.status).toBe(401);
  });

  it("rejects requests with invalid Bearer token", async () => {
    const response = await SELF.fetch("https://test.local/sessions", {
      headers: { Authorization: "Bearer invalid.token" },
    });
    expect(response.status).toBe(401);
  });

  it("rejects expired tokens", async () => {
    // Manually craft a token with a timestamp 10 minutes in the past
    const secret = env.INTERNAL_CALLBACK_SECRET!;
    const oldTimestamp = (Date.now() - 10 * 60 * 1000).toString();
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(oldTimestamp));
    const signatureHex = Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const expiredToken = `${oldTimestamp}.${signatureHex}`;

    const response = await SELF.fetch("https://test.local/sessions", {
      headers: { Authorization: `Bearer ${expiredToken}` },
    });
    expect(response.status).toBe(401);
  });

  it("accepts valid HMAC tokens and returns session list", async () => {
    const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);
    const response = await SELF.fetch("https://test.local/sessions", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json<{ sessions: unknown[]; total: number; hasMore: boolean }>();
    expect(body.sessions).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.hasMore).toBe(false);
  });
});

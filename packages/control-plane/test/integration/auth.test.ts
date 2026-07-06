import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { generateInternalToken } from "../../src/auth/internal";
import { SessionIndexStore } from "../../src/db/session-index";
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
    const body = await response.json<{ sessions: unknown[]; hasMore: boolean }>();
    expect(body.sessions).toEqual([]);
    expect(body.hasMore).toBe(false);
  });

  it("filters the session list by creator user id", async () => {
    const aliceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const bobId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const store = new SessionIndexStore(env.DB);
    const now = Date.now();

    await store.create({
      id: "alice-session",
      title: null,
      repoOwner: "acme",
      repoName: "api",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: null,
      status: "active",
      userId: aliceId,
      createdAt: now,
      updatedAt: now,
    });
    await store.create({
      id: "bob-session",
      title: null,
      repoOwner: "acme",
      repoName: "api",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: null,
      status: "active",
      userId: bobId,
      createdAt: now - 1000,
      updatedAt: now - 1000,
    });
    await store.create({
      id: "historical-session",
      title: null,
      repoOwner: "acme",
      repoName: "api",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: null,
      baseBranch: null,
      status: "active",
      userId: null,
      createdAt: now - 2000,
      updatedAt: now - 2000,
    });

    const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);
    const response = await SELF.fetch(`https://test.local/sessions?createdBy=${aliceId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    const body = await response.json<{ sessions: Array<{ id: string }>; hasMore: boolean }>();
    expect(body.sessions.map((session) => session.id)).toEqual(["alice-session"]);
    expect(body.hasMore).toBe(false);
  });

  it("rejects invalid creator user id filters", async () => {
    const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);
    const response = await SELF.fetch("https://test.local/sessions?createdBy=me", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid createdBy" });
  });
});

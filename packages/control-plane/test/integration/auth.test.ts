import { describe, it, expect, beforeEach } from "vitest";
import { generateInternalToken } from "@open-inspect/shared";
import { SELF, env } from "cloudflare:test";
import { SessionIndexStore } from "../../src/db/session-index";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

describe("Edge authentication", () => {
  beforeEach(cleanD1Tables);

  it("rejects requests without Authorization header", async () => {
    const response = await SELF.fetch("https://test.local/sessions");
    expect(response.status).toBe(401);
  });

  it("rejects requests with an unrecognized Bearer token", async () => {
    const response = await SELF.fetch("https://test.local/sessions", {
      headers: { Authorization: "Bearer invalid.token" },
    });
    expect(response.status).toBe(401);
  });

  it("rejects a valid legacy shared-bearer token: the scheme is retired", async () => {
    // A token that would have authenticated under the retired shared-bearer scheme — must now be
    // indistinguishable from any other unrecognized credential.
    const token = await generateInternalToken("test-hmac-secret-for-integration-tests");
    const response = await SELF.fetch("https://test.local/sessions", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
  });

  it("accepts a service-signed request and returns the session list", async () => {
    const response = await serviceFetch("https://test.local/sessions");
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

    const response = await serviceFetch(`https://test.local/sessions?createdBy=${aliceId}`);

    expect(response.status).toBe(200);
    const body = await response.json<{ sessions: Array<{ id: string }>; hasMore: boolean }>();
    expect(body.sessions.map((session) => session.id)).toEqual(["alice-session"]);
    expect(body.hasMore).toBe(false);
  });

  it("rejects invalid creator user id filters", async () => {
    const response = await serviceFetch("https://test.local/sessions?createdBy=me");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid createdBy" });
  });
});

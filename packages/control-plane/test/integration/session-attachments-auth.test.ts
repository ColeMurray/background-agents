import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, seedSandboxAuth } from "./helpers";

describe("session attachment sandbox authentication", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("rejects a valid sandbox token from another session", async () => {
    const sessionA = `attachment-auth-a-${Date.now()}`;
    const sessionB = `attachment-auth-b-${Date.now()}`;
    const [{ stub: stubA }, { stub: stubB }] = await Promise.all([
      initNamedSession(sessionA),
      initNamedSession(sessionB),
    ]);
    const tokenA = `sandbox-token-a-${Date.now()}`;
    await Promise.all([
      seedSandboxAuth(stubA, { authToken: tokenA, sandboxId: `sandbox-a-${Date.now()}` }),
      seedSandboxAuth(stubB, {
        authToken: `sandbox-token-b-${Date.now()}`,
        sandboxId: `sandbox-b-${Date.now()}`,
      }),
    ]);

    const response = await SELF.fetch(
      `https://test.local/sessions/${sessionB}/attachments/attachment-1`,
      { headers: { Authorization: `Bearer ${tokenA}` } }
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Unauthorized: Invalid sandbox token",
    });
  });
});

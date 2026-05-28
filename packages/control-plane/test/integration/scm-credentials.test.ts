/**
 * Integration tests for POST /sessions/:id/scm-credentials.
 *
 * Exercises the full sandbox-auth → DO → handler → service → provider chain
 * through the real worker fetch path. The test env doesn't provide a
 * GitHub App config, so the provider returns the canonical
 * "App not configured" error — we use that as a stable signal that the
 * route + auth + dispatch wiring is correct end-to-end.
 *
 * The happy path (actual installation-token minting) is covered by unit
 * tests in `auth/github-app.test.ts` and `scm-credentials-service.test.ts`,
 * which mock the GitHub API.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, seedSandboxAuth } from "./helpers";

async function setupSession(): Promise<{ sessionName: string; sandboxToken: string }> {
  const sessionName = `scm-creds-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { stub } = await initNamedSession(sessionName, {
    repoOwner: "acme",
    repoName: "web-app",
  });

  const sandboxToken = `sb-tok-${Date.now()}`;
  await seedSandboxAuth(stub, {
    authToken: sandboxToken,
    sandboxId: `sb-${Date.now()}`,
  });

  return { sessionName, sandboxToken };
}

describe("POST /sessions/:id/scm-credentials", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("returns 401 when the Authorization header is missing", async () => {
    const { sessionName } = await setupSession();

    const res = await SELF.fetch(`https://test.local/sessions/${sessionName}/scm-credentials`, {
      method: "POST",
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: "Unauthorized: Missing sandbox token",
    });
  });

  it("returns 401 when the sandbox token is invalid", async () => {
    const { sessionName } = await setupSession();

    const res = await SELF.fetch(`https://test.local/sessions/${sessionName}/scm-credentials`, {
      method: "POST",
      headers: { Authorization: "Bearer not-the-real-token" },
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: "Unauthorized: Invalid sandbox token",
    });
  });

  it("reaches the service and returns 500 when no SCM provider is configured", async () => {
    const { sessionName, sandboxToken } = await setupSession();

    const res = await SELF.fetch(`https://test.local/sessions/${sessionName}/scm-credentials`, {
      method: "POST",
      headers: { Authorization: `Bearer ${sandboxToken}` },
    });

    // The test env has no GITHUB_APP_* bindings, so the provider raises
    // a permanent error which the service maps to 500. The important
    // thing here is that we *get* a 500 (not e.g. a 404 from a missing
    // route or an opaque DO crash) — that proves the entire chain is
    // wired up correctly.
    expect(res.status).toBe(500);
    const body = await res.json<{ error: string }>();
    expect(body.error).toMatch(/GitHub App not configured/i);
  });

  it("does not respond to GET requests on the route", async () => {
    const { sessionName, sandboxToken } = await setupSession();

    const res = await SELF.fetch(`https://test.local/sessions/${sessionName}/scm-credentials`, {
      method: "GET",
      headers: { Authorization: `Bearer ${sandboxToken}` },
    });

    expect(res.status).toBe(404);
  });
});

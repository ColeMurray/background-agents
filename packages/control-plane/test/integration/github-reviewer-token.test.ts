import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import type { WorkerBindings } from "../../src/cloudflare/platform";
import { INSTALLATION_TOKEN_CACHE_MAX_AGE_MS } from "../../src/auth/github-app";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, routeRequest, seedSandboxAuth } from "./helpers";

/**
 * A token already in the installation-token cache, so the route answers
 * without an installation-token exchange. The integration outbound service
 * throws on any unexpected request, so a route that reached for the wrong
 * App's credential would fail loudly rather than return the wrong token.
 */
async function cacheInstallationToken(
  appId: string,
  installationId: string,
  token: string
): Promise<void> {
  const now = Date.now();
  await env.REPOS_CACHE.put(
    `github:installation-token:v1:${appId}:${installationId}`,
    JSON.stringify({
      token,
      expiresAtEpochMs: now + INSTALLATION_TOKEN_CACHE_MAX_AGE_MS,
      cachedAtEpochMs: now,
    })
  );
}

function withReviewerApp(appId: string, installationId: string): WorkerBindings {
  return {
    ...env,
    GITHUB_REVIEWER_APP_ID: appId,
    GITHUB_REVIEWER_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----",
    GITHUB_REVIEWER_APP_INSTALLATION_ID: installationId,
  };
}

function fetchReviewToken(sessionName: string, token: string, bindings: WorkerBindings) {
  return routeRequest(
    new Request(`http://localhost/sessions/${sessionName}/review-token`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    bindings,
    createExecutionContext()
  );
}

describe("reviewer app token broker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  beforeEach(async () => {
    await cleanD1Tables();
  });

  it("mints the reviewer App's token for the session's own sandbox", async () => {
    const suffix = `${Date.now()}`;
    const sessionName = `review-token-${suffix}`;
    const keyPair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"]
    )) as CryptoKeyPair;
    const exported = (await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)) as ArrayBuffer;
    const encoded = btoa(String.fromCharCode(...new Uint8Array(exported)));
    const privateKey = `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`;
    const actualFetch = globalThis.fetch;
    const exchange = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) === `https://api.github.com/app/installations/ri-${suffix}/access_tokens`) {
        const jwt = new Headers(init?.headers).get("Authorization")!.split(" ")[1];
        const claims = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        expect(claims.iss).toBe(`reviewer-${suffix}`);
        expect(init?.method).toBe("POST");
        return Response.json({
          token: "reviewer-installation-token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      return actualFetch(input, init);
    });
    // The main App's credential is configured too, and would mint a different
    // token: the review POST must be authenticated as the reviewer App.
    await cacheInstallationToken(`main-${suffix}`, `mi-${suffix}`, "main-installation-token");

    const { stub } = await initNamedSession(sessionName);
    await seedSandboxAuth(stub, { authToken: "sandbox-token", sandboxId: "sandbox-1" });

    const response = await fetchReviewToken(sessionName, "sandbox-token", {
      ...withReviewerApp(`reviewer-${suffix}`, `ri-${suffix}`),
      GITHUB_REVIEWER_APP_PRIVATE_KEY: privateKey,
      GITHUB_APP_ID: `main-${suffix}`,
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----",
      GITHUB_APP_INSTALLATION_ID: `mi-${suffix}`,
    });

    expect(
      exchange.mock.calls.some(([input]) =>
        String(input).includes(`/installations/ri-${suffix}/access_tokens`)
      )
    ).toBe(true);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.json()).toEqual({ token: "reviewer-installation-token" });
  });

  it("answers 404 when the deployment runs no reviewer App", async () => {
    const sessionName = `review-token-unconfigured-${Date.now()}`;
    const { stub } = await initNamedSession(sessionName);
    await seedSandboxAuth(stub, { authToken: "sandbox-token", sandboxId: "sandbox-1" });

    const response = await fetchReviewToken(sessionName, "sandbox-token", env);

    expect(response.status).toBe(404);
  });

  it("refuses another session's sandbox token", async () => {
    const suffix = `cross-${Date.now()}`;
    const bindings = withReviewerApp(`reviewer-${suffix}`, `ri-${suffix}`);
    await cacheInstallationToken(`reviewer-${suffix}`, `ri-${suffix}`, "reviewer-installation-token");

    const reviewed = `review-token-${suffix}`;
    const other = `other-session-${suffix}`;
    const { stub } = await initNamedSession(reviewed);
    await seedSandboxAuth(stub, { authToken: "reviewed-token", sandboxId: "sandbox-1" });
    const { stub: otherStub } = await initNamedSession(other);
    await seedSandboxAuth(otherStub, { authToken: "other-token", sandboxId: "sandbox-2" });

    const response = await fetchReviewToken(reviewed, "other-token", bindings);

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("reviewer-installation-token");
  });
});

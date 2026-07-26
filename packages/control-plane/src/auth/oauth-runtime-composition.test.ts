import { describe, expect, it, vi } from "vitest";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";
import { createOAuthProtocolRuntime } from "./oauth-runtime-composition";

function configuredEnv(overrides: Partial<Env> = {}): Env {
  return {
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-secret",
    WORKER_URL: "https://cp.example.com",
    OAUTH_WEB_REDIRECT_URIS: "https://web.example.com/api/auth/callback",
    DEPLOYMENT_NAME: "test",
    ...overrides,
  } as Env;
}

const db = {} as SqlDatabase;
const authorizationRequest = {
  responseType: "code",
  clientId: "web",
  redirectUri: "https://web.example.com/api/auth/callback",
  state: "s".repeat(43),
  codeChallenge: "c".repeat(43),
  codeChallengeMethod: "S256",
  provider: "github",
};

describe("createOAuthProtocolRuntime", () => {
  it("composes the executable OAuth use cases for a GitHub-only deployment", () => {
    const runtime = createOAuthProtocolRuntime(configuredEnv(), db);

    expect(runtime).toEqual({
      authorize: expect.any(Function),
      completeAuthorization: expect.any(Function),
      completeDenial: expect.any(Function),
      redeemAuthorizationCode: expect.any(Function),
      revokeBrowserSession: expect.any(Function),
    });
  });

  it("rejects a partially configured optional Google provider", async () => {
    const runtime = createOAuthProtocolRuntime(
      configuredEnv({ GOOGLE_CLIENT_ID: "google-client" }),
      db
    );

    await expect(runtime.authorize(authorizationRequest)).rejects.toEqual(
      expect.objectContaining({
        name: "OAuthProtocolUnavailableError",
        setting: "GOOGLE_CLIENT_SECRET",
      })
    );
  });

  it("rejects a malformed encryption root before starting an OAuth flow", async () => {
    const runtime = createOAuthProtocolRuntime(
      configuredEnv({ TOKEN_ENCRYPTION_KEY: "not-a-32-byte-base64-key" }),
      db
    );

    await expect(runtime.authorize(authorizationRequest)).rejects.toEqual(
      expect.objectContaining({
        name: "OAuthProtocolUnavailableError",
        setting: "TOKEN_ENCRYPTION_KEY",
      })
    );
  });

  it("revokes independently of provider and authorization configuration", async () => {
    const runtime = createOAuthProtocolRuntime({} as Env, db);

    await expect(runtime.revokeBrowserSession("not-a-browser-session")).resolves.toBe(false);
  });

  it("redeems independently of provider and authorization configuration", async () => {
    const runtime = createOAuthProtocolRuntime({} as Env, db);

    await expect(
      runtime.redeemAuthorizationCode({
        code: "not-an-authorization-code",
        clientId: "web",
        redirectUri: "https://web.example.com/api/auth/callback",
        codeVerifier: "v".repeat(43),
      })
    ).rejects.toMatchObject({
      name: "OAuthProtocolGrantError",
      rejection: "malformed",
    });
  });

  it("preserves the exact configured redirect URI instead of URL-normalizing it", async () => {
    const redirectUri = "https://web.example.com:443/api/auth/callback";
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const flowDb = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({ run })),
      })),
    } as unknown as SqlDatabase;
    const runtime = createOAuthProtocolRuntime(
      configuredEnv({ OAUTH_WEB_REDIRECT_URIS: redirectUri }),
      flowDb
    );

    await expect(
      runtime.authorize({
        responseType: "code",
        clientId: "web",
        redirectUri,
        state: "s".repeat(43),
        codeChallenge: "c".repeat(43),
        codeChallengeMethod: "S256",
        provider: "github",
      })
    ).resolves.toBeInstanceOf(URL);
    expect(run).toHaveBeenCalledOnce();
  });
});

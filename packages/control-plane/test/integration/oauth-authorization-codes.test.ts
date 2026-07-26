import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { hashToken } from "../../src/auth/crypto";
import { createPkceS256Challenge } from "../../src/auth/pkce";
import {
  BrowserAuthSessionStore,
  parseBrowserSessionCredential,
  type BrowserAuthSessionStoreDependencies,
} from "../../src/db/browser-auth-sessions";
import {
  OAuthAuthorizationCodeRedemptionError,
  OAuthAuthorizationCodeStore,
} from "../../src/db/oauth-authorization-codes";
import { cleanD1Tables } from "./cleanup";

const NOW_MS = 1_800_000_000_000;
const AUTHORIZATION_CODE = `oi_code_${"a".repeat(43)}`;
const BROWSER_CREDENTIAL = `oi_bsess_${"b".repeat(43)}`;
const CODE_VERIFIER = "v".repeat(43);
const REDIRECT_URI = "https://web.example/api/auth/callback";

describe("OAuthAuthorizationCodeStore", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users
         (id, display_name, email, avatar_url, created_at, updated_at)
         VALUES ('user-1', NULL, NULL, NULL, ?, ?)`
      ).bind(NOW_MS, NOW_MS),
      env.DB.prepare(
        `INSERT INTO user_identities
         (id, user_id, provider, provider_issuer, provider_user_id, created_at)
         VALUES (
           'identity-1', 'user-1', 'github', 'https://github.com',
           'github-subject', ?
         )`
      ).bind(NOW_MS),
    ]);
  });

  function createStore(now = NOW_MS): OAuthAuthorizationCodeStore {
    const ids = [
      "code-1",
      "redemption-1",
      "browser-session-1",
      "redemption-2",
      "browser-session-2",
    ];
    return new OAuthAuthorizationCodeStore(env.DB, {
      clock: { now: () => now },
      tokenHasher: { hash: hashToken },
      authorizationCodeGenerator: { generate: () => AUTHORIZATION_CODE },
      browserCredentialGenerator: { generate: () => BROWSER_CREDENTIAL },
      idGenerator: {
        generate: () => {
          const id = ids.shift();
          if (!id) throw new Error("Unexpected id request");
          return id;
        },
      },
    });
  }

  it("redeems a bound code into an authenticatable browser session", async () => {
    const store = createStore();
    const challenge = await createPkceS256Challenge(CODE_VERIFIER);

    await expect(
      store.issue({
        userId: "user-1",
        providerIdentityId: "identity-1",
        clientId: "web",
        redirectUri: REDIRECT_URI,
        codeChallenge: challenge,
      })
    ).resolves.toEqual({
      code: AUTHORIZATION_CODE,
      expiresAt: NOW_MS + 60_000,
    });
    await expect(
      env.DB.prepare("SELECT code_hash FROM oauth_authorization_codes WHERE id = 'code-1'").first()
    ).resolves.toEqual({ code_hash: await hashToken(AUTHORIZATION_CODE) });

    const redeemed = await store.redeem({
      code: AUTHORIZATION_CODE,
      clientId: "web",
      redirectUri: REDIRECT_URI,
      codeVerifier: CODE_VERIFIER,
    });

    expect(redeemed).toEqual({
      credential: BROWSER_CREDENTIAL,
      credentialId: "browser-session-1",
      expiresAt: NOW_MS + 7 * 24 * 60 * 60 * 1000,
      absoluteExpiresAt: NOW_MS + 30 * 24 * 60 * 60 * 1000,
    });

    const sessionDependencies: BrowserAuthSessionStoreDependencies = {
      clock: { now: () => NOW_MS },
      tokenHasher: { hash: hashToken },
      credentialGenerator: { generate: () => BROWSER_CREDENTIAL },
      idGenerator: { generate: () => "unused" },
    };
    const sessions = new BrowserAuthSessionStore(env.DB, sessionDependencies);
    await expect(
      sessions.authenticate(parseBrowserSessionCredential(BROWSER_CREDENTIAL))
    ).resolves.toMatchObject({
      credentialId: "browser-session-1",
      userId: "user-1",
      providerIdentityId: "identity-1",
    });
  });

  it("does not consume a code when its redirect binding or PKCE verifier is wrong", async () => {
    const store = createStore();
    await store.issue({
      userId: "user-1",
      providerIdentityId: "identity-1",
      clientId: "web",
      redirectUri: REDIRECT_URI,
      codeChallenge: await createPkceS256Challenge(CODE_VERIFIER),
    });

    await expect(
      store.redeem({
        code: AUTHORIZATION_CODE,
        clientId: "web",
        redirectUri: "https://attacker.example/callback",
        codeVerifier: CODE_VERIFIER,
      })
    ).rejects.toMatchObject({ rejection: "binding_mismatch" });
    await expect(
      store.redeem({
        code: AUTHORIZATION_CODE,
        clientId: "web",
        redirectUri: REDIRECT_URI,
        codeVerifier: "x".repeat(43),
      })
    ).rejects.toMatchObject({ rejection: "pkce_failed" });

    await expect(
      env.DB.prepare(
        "SELECT consumed_at, consumed_by FROM oauth_authorization_codes WHERE id = 'code-1'"
      ).first()
    ).resolves.toEqual({ consumed_at: null, consumed_by: null });
  });

  it("rejects a code at its exact expiry boundary without creating a session", async () => {
    await createStore().issue({
      userId: "user-1",
      providerIdentityId: "identity-1",
      clientId: "web",
      redirectUri: REDIRECT_URI,
      codeChallenge: await createPkceS256Challenge(CODE_VERIFIER),
    });

    await expect(
      createStore(NOW_MS + 60_000).redeem({
        code: AUTHORIZATION_CODE,
        clientId: "web",
        redirectUri: REDIRECT_URI,
        codeVerifier: CODE_VERIFIER,
      })
    ).rejects.toMatchObject({ rejection: "expired" });
    await expect(
      env.DB.prepare("SELECT count(*) AS count FROM browser_auth_sessions").first()
    ).resolves.toEqual({ count: 0 });
  });

  it("allows exactly one concurrent redemption without creating an orphan session", async () => {
    const store = createStore();
    await store.issue({
      userId: "user-1",
      providerIdentityId: "identity-1",
      clientId: "web",
      redirectUri: REDIRECT_URI,
      codeChallenge: await createPkceS256Challenge(CODE_VERIFIER),
    });
    const redemption = {
      code: AUTHORIZATION_CODE,
      clientId: "web" as const,
      redirectUri: REDIRECT_URI,
      codeVerifier: CODE_VERIFIER,
    };

    const results = await Promise.allSettled([store.redeem(redemption), store.redeem(redemption)]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejection = results.find(({ status }) => status === "rejected");
    expect(rejection).toMatchObject({
      status: "rejected",
      reason: expect.any(OAuthAuthorizationCodeRedemptionError),
    });
    await expect(
      env.DB.prepare("SELECT count(*) AS count FROM browser_auth_sessions").first()
    ).resolves.toEqual({ count: 1 });
  });
});

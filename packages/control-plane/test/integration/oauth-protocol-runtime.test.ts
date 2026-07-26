import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { hashToken } from "../../src/auth/crypto";
import { createPkceS256Challenge } from "../../src/auth/pkce";
import { createOAuthProtocolRuntime } from "../../src/auth/oauth-runtime-composition";
import {
  BrowserAuthSessionStore,
  parseBrowserSessionCredential,
} from "../../src/db/browser-auth-sessions";
import { OAuthAuthorizationCodeStore } from "../../src/db/oauth-authorization-codes";
import type { Env } from "../../src/types";
import { cleanD1Tables } from "./cleanup";

const AUTHORIZATION_CODE = `oi_code_${"a".repeat(43)}`;
const CODE_VERIFIER = "v".repeat(43);
const REDIRECT_URI = "https://app.test.local/api/auth/callback";

describe("OAuth protocol runtime", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users
         (id, display_name, email, avatar_url, created_at, updated_at)
         VALUES ('user-1', NULL, 'person@example.com', NULL, ?, ?)`
      ).bind(now, now),
      env.DB.prepare(
        `INSERT INTO user_identities
         (id, user_id, provider, provider_issuer, provider_user_id, created_at)
         VALUES (
           'identity-1', 'user-1', 'github', 'https://github.com',
           'github-subject', ?
         )`
      ).bind(now),
    ]);
  });

  it("redeems and idempotently revokes a browser session through the composed ports", async () => {
    const now = Date.now();
    const issuingStore = new OAuthAuthorizationCodeStore(env.DB, {
      clock: { now: () => now },
      tokenHasher: { hash: hashToken },
      authorizationCodeGenerator: { generate: () => AUTHORIZATION_CODE },
      browserCredentialGenerator: {
        generate: () => `oi_bsess_${"unused".padEnd(43, "a")}`,
      },
      idGenerator: { generate: () => "authorization-code-1" },
    });
    await issuingStore.issue({
      userId: "user-1",
      providerIdentityId: "identity-1",
      clientId: "web",
      redirectUri: REDIRECT_URI,
      codeChallenge: await createPkceS256Challenge(CODE_VERIFIER),
    });
    const runtime = createOAuthProtocolRuntime(env as unknown as Env, env.DB);

    const redeemed = await runtime.redeemAuthorizationCode({
      code: AUTHORIZATION_CODE,
      clientId: "web",
      redirectUri: REDIRECT_URI,
      codeVerifier: CODE_VERIFIER,
    });

    expect(redeemed).toEqual({
      accessToken: expect.stringMatching(/^oi_bsess_[A-Za-z0-9_-]{43}$/),
      expiresIn: 30 * 24 * 60 * 60,
      idleExpiresIn: 7 * 24 * 60 * 60,
    });
    const sessionStore = new BrowserAuthSessionStore(env.DB, {
      clock: { now: () => Date.now() },
      tokenHasher: { hash: hashToken },
      credentialGenerator: { generate: () => "unused" },
      idGenerator: { generate: () => "unused" },
    });
    await expect(
      sessionStore.authenticate(parseBrowserSessionCredential(redeemed.accessToken))
    ).resolves.toMatchObject({
      userId: "user-1",
      providerIdentityId: "identity-1",
    });

    await expect(runtime.revokeBrowserSession(redeemed.accessToken)).resolves.toBe(true);
    await expect(runtime.revokeBrowserSession(redeemed.accessToken)).resolves.toBe(false);
    await expect(
      sessionStore.authenticate(parseBrowserSessionCredential(redeemed.accessToken))
    ).rejects.toMatchObject({ rejection: "revoked" });
  });
});

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { hashToken } from "../../src/auth/crypto";
import { createPkceS256Challenge } from "../../src/auth/pkce";
import {
  BROWSER_SESSION_ABSOLUTE_LIFETIME_MS,
  BROWSER_SESSION_IDLE_LIFETIME_MS,
  BrowserAuthSessionStore,
  parseBrowserSessionCredential,
  type BrowserAuthSessionStoreDependencies,
} from "../../src/db/browser-auth-sessions";
import {
  InvalidOAuthAuthorizationCodeInputError,
  OAUTH_AUTHORIZATION_CODE_LIFETIME_MS,
  OAuthAuthorizationCodeRedemptionError,
  OAuthAuthorizationCodeStore,
  type IssueOAuthAuthorizationCodeInput,
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
    const ids = ["code-1", "browser-session-1", "browser-session-2"];
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
      expiresAt: NOW_MS + OAUTH_AUTHORIZATION_CODE_LIFETIME_MS,
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
      expiresAt: NOW_MS + BROWSER_SESSION_IDLE_LIFETIME_MS,
      absoluteExpiresAt: NOW_MS + BROWSER_SESSION_ABSOLUTE_LIFETIME_MS,
    });
    await expect(
      env.DB.prepare(
        "SELECT consumed_by FROM oauth_authorization_codes WHERE id = 'code-1'"
      ).first()
    ).resolves.toEqual({ consumed_by: redeemed.credentialId });

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

  it("distinguishes malformed and unknown authorization codes", async () => {
    const redemption = {
      clientId: "web" as const,
      redirectUri: REDIRECT_URI,
      codeVerifier: CODE_VERIFIER,
    };

    await expect(
      createStore().redeem({ ...redemption, code: "not-an-authorization-code" })
    ).rejects.toMatchObject({ rejection: "malformed" });
    await expect(
      createStore().redeem({ ...redemption, code: `oi_code_${"z".repeat(43)}` })
    ).rejects.toMatchObject({ rejection: "unknown" });
  });

  it("rejects malformed authorization-code bindings before persistence", async () => {
    const validInput: IssueOAuthAuthorizationCodeInput = {
      userId: "user-1",
      providerIdentityId: "identity-1",
      clientId: "web",
      redirectUri: REDIRECT_URI,
      codeChallenge: await createPkceS256Challenge(CODE_VERIFIER),
    };
    const invalidBindings: Array<
      [string, Partial<Record<keyof IssueOAuthAuthorizationCodeInput, unknown>>]
    > = [
      ["missing user", { userId: "" }],
      ["missing provider identity", { providerIdentityId: "" }],
      ["unsupported client", { clientId: "cli" }],
      ["missing redirect URI", { redirectUri: "" }],
      ["malformed PKCE challenge", { codeChallenge: "not-a-challenge" }],
    ];

    for (const [name, override] of invalidBindings) {
      const issue = createStore().issue({
        ...validInput,
        ...override,
      } as IssueOAuthAuthorizationCodeInput);
      await expect(issue, name).rejects.toBeInstanceOf(InvalidOAuthAuthorizationCodeInputError);
    }
    await expect(
      env.DB.prepare("SELECT count(*) AS count FROM oauth_authorization_codes").first()
    ).resolves.toEqual({ count: 0 });
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
      createStore(NOW_MS + OAUTH_AUTHORIZATION_CODE_LIFETIME_MS).redeem({
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

  it("classifies sequential authorization-code replay as already consumed", async () => {
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

    await expect(store.redeem(redemption)).resolves.toMatchObject({
      credentialId: "browser-session-1",
    });
    await expect(store.redeem(redemption)).rejects.toMatchObject({
      rejection: "already_consumed",
    });
    await expect(
      env.DB.prepare("SELECT count(*) AS count FROM browser_auth_sessions").first()
    ).resolves.toEqual({ count: 1 });
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

  it("rolls back code consumption when browser-session insertion fails", async () => {
    const store = createStore();
    await store.issue({
      userId: "user-1",
      providerIdentityId: "identity-1",
      clientId: "web",
      redirectUri: REDIRECT_URI,
      codeChallenge: await createPkceS256Challenge(CODE_VERIFIER),
    });
    await env.DB.prepare(
      `INSERT INTO browser_auth_sessions (
         id, token_hash, user_id, client_id, provider_identity_id,
         created_at, last_used_at, expires_at, absolute_expires_at,
         revoked_at, revoked_reason
       ) VALUES (?, ?, 'user-1', 'web', 'identity-1', ?, ?, ?, ?, NULL, NULL)`
    )
      .bind(
        "browser-session-1",
        "c".repeat(64),
        NOW_MS,
        NOW_MS,
        NOW_MS + BROWSER_SESSION_IDLE_LIFETIME_MS,
        NOW_MS + BROWSER_SESSION_ABSOLUTE_LIFETIME_MS
      )
      .run();

    await expect(
      store.redeem({
        code: AUTHORIZATION_CODE,
        clientId: "web",
        redirectUri: REDIRECT_URI,
        codeVerifier: CODE_VERIFIER,
      })
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "SELECT consumed_at, consumed_by FROM oauth_authorization_codes WHERE id = 'code-1'"
      ).first()
    ).resolves.toEqual({ consumed_at: null, consumed_by: null });
    await expect(
      env.DB.prepare("SELECT count(*) AS count FROM browser_auth_sessions").first()
    ).resolves.toEqual({ count: 1 });

    await expect(
      store.redeem({
        code: AUTHORIZATION_CODE,
        clientId: "web",
        redirectUri: REDIRECT_URI,
        codeVerifier: CODE_VERIFIER,
      })
    ).resolves.toMatchObject({ credentialId: "browser-session-2" });
    await expect(
      env.DB.prepare(
        "SELECT consumed_by FROM oauth_authorization_codes WHERE id = 'code-1'"
      ).first()
    ).resolves.toEqual({ consumed_by: "browser-session-2" });
  });
});

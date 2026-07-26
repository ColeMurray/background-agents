import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  BROWSER_SESSION_ABSOLUTE_LIFETIME_MS,
  BROWSER_SESSION_IDLE_LIFETIME_MS,
  BROWSER_SESSION_TOUCH_INTERVAL_MS,
  BrowserAuthSessionStore,
  parseBrowserSessionCredential,
  parseBrowserSessionId,
} from "../../src/db/browser-auth-sessions";
import type { BrowserSessionAuthenticationError } from "../../src/db/browser-auth-sessions";
import { hashToken } from "../../src/auth/crypto";
import { cleanD1Tables } from "./cleanup";

const NOW_MS = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CREDENTIAL = parseBrowserSessionCredential(`oi_bsess_${"a".repeat(43)}`);
const TOKEN_HASHER = { hash: hashToken };

describe("BrowserAuthSessionStore", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users
         (id, display_name, email, avatar_url, created_at, updated_at)
         VALUES ('user-1', NULL, 'user@example.com', NULL, ?, ?)`
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

  it("locks the browser-session lifetime policy", () => {
    expect(BROWSER_SESSION_IDLE_LIFETIME_MS).toBe(7 * DAY_MS);
    expect(BROWSER_SESSION_ABSOLUTE_LIFETIME_MS).toBe(30 * DAY_MS);
    expect(BROWSER_SESSION_TOUCH_INTERVAL_MS).toBe(DAY_MS);
  });

  it("returns an opaque credential once and authenticates it without persisting the raw value", async () => {
    const store = new BrowserAuthSessionStore(env.DB, {
      clock: { now: () => NOW_MS },
      credentialGenerator: { generate: () => CREDENTIAL },
      idGenerator: { generate: () => "browser-session-1" },
      tokenHasher: { hash: hashToken },
    });

    await expect(
      store.create({ userId: "user-1", providerIdentityId: "identity-1" })
    ).resolves.toEqual({
      credential: CREDENTIAL,
      credentialId: "browser-session-1",
      expiresAt: NOW_MS + BROWSER_SESSION_IDLE_LIFETIME_MS,
      absoluteExpiresAt: NOW_MS + BROWSER_SESSION_ABSOLUTE_LIFETIME_MS,
    });

    const persisted = await env.DB.prepare(
      `SELECT token_hash, user_id, provider_identity_id
       FROM browser_auth_sessions
       WHERE id = 'browser-session-1'`
    ).first();
    expect(persisted).toEqual({
      token_hash: await hashToken(CREDENTIAL),
      user_id: "user-1",
      provider_identity_id: "identity-1",
    });
    expect(JSON.stringify(persisted)).not.toContain(CREDENTIAL);

    await expect(store.authenticate(CREDENTIAL)).resolves.toMatchObject({
      credentialId: "browser-session-1",
      userId: "user-1",
      providerIdentityId: "identity-1",
    });
  });

  it("rejects malformed creation inputs before persisting a session", async () => {
    const store = new BrowserAuthSessionStore(env.DB, {
      clock: { now: () => NOW_MS },
      credentialGenerator: { generate: () => CREDENTIAL },
      idGenerator: { generate: () => "" },
      tokenHasher: TOKEN_HASHER,
    });

    await expect(store.create({ userId: "", providerIdentityId: "identity-1" })).rejects.toThrow(
      "requires a user and provider identity"
    );
    await expect(
      store.create({ userId: "user-1", providerIdentityId: "identity-1" })
    ).rejects.toThrow("id generator returned an invalid id");

    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM browser_auth_sessions").first()
    ).resolves.toEqual({ count: 0 });
  });

  it("revokes a browser session idempotently and rejects a copied credential", async () => {
    const store = new BrowserAuthSessionStore(env.DB, {
      clock: { now: () => NOW_MS },
      credentialGenerator: { generate: () => CREDENTIAL },
      idGenerator: { generate: () => "browser-session-1" },
      tokenHasher: TOKEN_HASHER,
    });
    await store.create({
      userId: "user-1",
      providerIdentityId: "identity-1",
    });

    await expect(store.revoke(CREDENTIAL, "logout")).resolves.toBe(true);
    await expect(store.revoke(CREDENTIAL, "logout")).resolves.toBe(false);
    await expect(store.authenticate(CREDENTIAL)).rejects.toEqual(
      expect.objectContaining<Partial<BrowserSessionAuthenticationError>>({
        rejection: "revoked",
      })
    );
  });

  it("distinguishes malformed, unknown, idle-expired, and absolute-expired credentials", async () => {
    let now = NOW_MS;
    const store = new BrowserAuthSessionStore(env.DB, {
      clock: { now: () => now },
      credentialGenerator: { generate: () => CREDENTIAL },
      idGenerator: { generate: () => "browser-session-1" },
      tokenHasher: TOKEN_HASHER,
    });
    await store.create({
      userId: "user-1",
      providerIdentityId: "identity-1",
    });

    expect(() => parseBrowserSessionCredential("not-a-browser-session")).toThrow(
      expect.objectContaining<Partial<BrowserSessionAuthenticationError>>({
        rejection: "malformed",
      })
    );
    expect(() => parseBrowserSessionId("")).toThrow(
      expect.objectContaining<Partial<BrowserSessionAuthenticationError>>({
        rejection: "malformed",
      })
    );
    await expect(
      store.authenticate(parseBrowserSessionCredential(`oi_bsess_${"b".repeat(43)}`))
    ).rejects.toEqual(
      expect.objectContaining<Partial<BrowserSessionAuthenticationError>>({
        rejection: "unknown",
      })
    );

    now += BROWSER_SESSION_IDLE_LIFETIME_MS;
    await expect(store.authenticate(CREDENTIAL)).rejects.toEqual(
      expect.objectContaining<Partial<BrowserSessionAuthenticationError>>({
        rejection: "idle_expired",
      })
    );

    now = NOW_MS + BROWSER_SESSION_ABSOLUTE_LIFETIME_MS;
    await expect(store.authenticate(CREDENTIAL)).rejects.toEqual(
      expect.objectContaining<Partial<BrowserSessionAuthenticationError>>({
        rejection: "absolute_expired",
      })
    );
  });

  it("revalidates a live parent session by credential id without the raw bearer", async () => {
    const store = new BrowserAuthSessionStore(env.DB, {
      clock: { now: () => NOW_MS },
      credentialGenerator: { generate: () => CREDENTIAL },
      idGenerator: { generate: () => "browser-session-1" },
      tokenHasher: TOKEN_HASHER,
    });
    const created = await store.create({
      userId: "user-1",
      providerIdentityId: "identity-1",
    });

    await expect(store.authenticateById(created.credentialId)).resolves.toMatchObject({
      credentialId: "browser-session-1",
      userId: "user-1",
      providerIdentityId: "identity-1",
    });
    await expect(store.authenticateById(parseBrowserSessionId("missing"))).rejects.toEqual(
      expect.objectContaining<Partial<BrowserSessionAuthenticationError>>({
        rejection: "unknown",
      })
    );
  });

  it("revokes an operator-selected session by credential id", async () => {
    const store = new BrowserAuthSessionStore(env.DB, {
      clock: { now: () => NOW_MS },
      credentialGenerator: { generate: () => CREDENTIAL },
      idGenerator: { generate: () => "browser-session-1" },
      tokenHasher: TOKEN_HASHER,
    });
    const created = await store.create({
      userId: "user-1",
      providerIdentityId: "identity-1",
    });

    await expect(store.revokeById(created.credentialId, "operator")).resolves.toBe(true);
    await expect(store.revokeById(created.credentialId, "operator")).resolves.toBe(false);
    await expect(store.authenticateById(created.credentialId)).rejects.toEqual(
      expect.objectContaining<Partial<BrowserSessionAuthenticationError>>({
        rejection: "revoked",
      })
    );
  });

  it("coalesces qualifying activity and never extends past the absolute deadline", async () => {
    let now = NOW_MS;
    const store = new BrowserAuthSessionStore(env.DB, {
      clock: { now: () => now },
      credentialGenerator: { generate: () => CREDENTIAL },
      idGenerator: { generate: () => "browser-session-1" },
      tokenHasher: TOKEN_HASHER,
    });
    const created = await store.create({
      userId: "user-1",
      providerIdentityId: "identity-1",
    });

    now += BROWSER_SESSION_TOUCH_INTERVAL_MS - 1;
    await store.touchQualifyingActivity(created.credentialId);
    let row = await env.DB.prepare(
      "SELECT last_used_at, expires_at FROM browser_auth_sessions WHERE id = ?"
    )
      .bind(created.credentialId)
      .first<{ last_used_at: number; expires_at: number }>();
    expect(row).toEqual({
      last_used_at: NOW_MS,
      expires_at: NOW_MS + BROWSER_SESSION_IDLE_LIFETIME_MS,
    });

    now = NOW_MS + BROWSER_SESSION_TOUCH_INTERVAL_MS;
    await store.touchQualifyingActivity(created.credentialId);
    row = await env.DB.prepare(
      "SELECT last_used_at, expires_at FROM browser_auth_sessions WHERE id = ?"
    )
      .bind(created.credentialId)
      .first<{ last_used_at: number; expires_at: number }>();
    expect(row).toEqual({
      last_used_at: now,
      expires_at: now + BROWSER_SESSION_IDLE_LIFETIME_MS,
    });

    for (const day of [6, 12, 18, 24, 28]) {
      now = NOW_MS + day * BROWSER_SESSION_TOUCH_INTERVAL_MS;
      await store.touchQualifyingActivity(created.credentialId);
    }
    row = await env.DB.prepare(
      "SELECT last_used_at, expires_at FROM browser_auth_sessions WHERE id = ?"
    )
      .bind(created.credentialId)
      .first<{ last_used_at: number; expires_at: number }>();
    expect(row).toEqual({
      last_used_at: now,
      expires_at: created.absoluteExpiresAt,
    });
  });

  it("does not renew a revoked or expired session", async () => {
    let now = NOW_MS;
    let credentialSequence = 0;
    let idSequence = 0;
    const store = new BrowserAuthSessionStore(env.DB, {
      clock: { now: () => now },
      credentialGenerator: {
        generate: () =>
          `oi_bsess_${String.fromCharCode("a".charCodeAt(0) + credentialSequence++).repeat(43)}`,
      },
      idGenerator: { generate: () => `browser-session-${++idSequence}` },
      tokenHasher: TOKEN_HASHER,
    });
    const revoked = await store.create({
      userId: "user-1",
      providerIdentityId: "identity-1",
    });
    const expired = await store.create({
      userId: "user-1",
      providerIdentityId: "identity-1",
    });
    await store.revoke(revoked.credential, "operator");

    now += BROWSER_SESSION_IDLE_LIFETIME_MS;
    await store.touchQualifyingActivity(revoked.credentialId);
    await store.touchQualifyingActivity(expired.credentialId);

    const rows = await env.DB.prepare(
      `SELECT id, last_used_at, expires_at
       FROM browser_auth_sessions
       ORDER BY id`
    ).all<{ id: string; last_used_at: number; expires_at: number }>();
    expect(rows.results).toEqual([
      {
        id: revoked.credentialId,
        last_used_at: NOW_MS,
        expires_at: revoked.expiresAt,
      },
      {
        id: expired.credentialId,
        last_used_at: NOW_MS,
        expires_at: expired.expiresAt,
      },
    ]);
  });
});

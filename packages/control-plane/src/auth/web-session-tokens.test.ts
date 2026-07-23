import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiTokenRow, NewApiToken, WebSessionTokenStore } from "../db/api-tokens";
import {
  ACCESS_TOKEN_PREFIX,
  REFRESH_REUSE_GRACE_MS,
  REFRESH_TOKEN_PREFIX,
  WEB_SESSION_FAMILY_TTL_MS,
  WEB_SESSION_REFRESH_TTL_MS,
  WEB_SESSION_TOKEN_TTL_MS,
  WebSessionTokenService,
} from "./web-session-tokens";

/** In-memory ApiTokenStore double with the same semantics as the D1 store. */
class FakeApiTokenStore implements WebSessionTokenStore {
  rows = new Map<string, ApiTokenRow>();
  private nextId = 0;

  async createPair(tokens: [NewApiToken, NewApiToken]): Promise<[string, string]> {
    const ids = tokens.map((token) => {
      const id = `token-${this.nextId++}`;
      this.rows.set(id, {
        id,
        tokenHash: token.tokenHash,
        kind: token.kind,
        userId: token.userId,
        provider: token.provider,
        providerUserId: token.providerUserId,
        familyId: token.familyId,
        rotatedTo: null,
        createdAt: Date.now(),
        expiresAt: token.expiresAt,
        familyExpiresAt: token.familyExpiresAt,
        revokedAt: null,
        lastUsedAt: null,
      });
      return id;
    });
    return ids as [string, string];
  }

  async getByHash(tokenHash: string): Promise<ApiTokenRow | null> {
    for (const row of this.rows.values()) {
      if (row.tokenHash === tokenHash) return { ...row };
    }
    return null;
  }

  async getById(id: string): Promise<ApiTokenRow | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async consumeRefreshToken(id: string, successorId: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.rotatedTo !== null || row.revokedAt !== null) return false;
    row.rotatedTo = successorId;
    return true;
  }

  async revokeFamily(familyId: string): Promise<void> {
    for (const row of this.rows.values()) {
      if (row.familyId === familyId && row.revokedAt === null) {
        row.revokedAt = Date.now();
      }
    }
  }

  async revokeToken(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (row && row.revokedAt === null) row.revokedAt = Date.now();
  }
}

const SUBJECT = { provider: "github" as const, providerUserId: "424242" };

function createService(): { service: WebSessionTokenService; store: FakeApiTokenStore } {
  const store = new FakeApiTokenStore();
  return { service: new WebSessionTokenService(store), store };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("mintPair", () => {
  it("mints prefixed opaque tokens with hash-at-rest storage", async () => {
    const { service, store } = createService();
    const pair = await service.mintPair("user-1", SUBJECT);

    expect(pair.accessToken).toMatch(new RegExp(`^${ACCESS_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`));
    expect(pair.refreshToken).toMatch(new RegExp(`^${REFRESH_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`));

    const rows = [...store.rows.values()];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.tokenHash).not.toContain(pair.accessToken);
      expect(row.userId).toBe("user-1");
      expect(row.provider).toBe("github");
      expect(row.providerUserId).toBe("424242");
    }
    const [access, refresh] = rows;
    expect(access.kind).toBe("web_session");
    expect(refresh.kind).toBe("web_session_refresh");
    expect(access.familyId).toBe(refresh.familyId);
  });

  it("applies the access, refresh, and family TTLs", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { service } = createService();
    const pair = await service.mintPair("user-1", SUBJECT);
    expect(pair.accessTokenExpiresAtEpochMs).toBe(1_000_000 + WEB_SESSION_TOKEN_TTL_MS);
    expect(pair.refreshTokenExpiresAtEpochMs).toBe(1_000_000 + WEB_SESSION_REFRESH_TTL_MS);
  });
});

describe("verifyAccessToken", () => {
  it("verifies a freshly minted token", async () => {
    const { service } = createService();
    const pair = await service.mintPair("user-1", SUBJECT);
    const result = await service.verifyAccessToken(pair.accessToken);
    expect(result).toMatchObject({
      ok: true,
      userId: "user-1",
      provider: "github",
      providerUserId: "424242",
    });
  });

  it("rejects unknown tokens and refresh tokens presented as access tokens", async () => {
    const { service } = createService();
    const pair = await service.mintPair("user-1", SUBJECT);
    expect(await service.verifyAccessToken("oi_at_nonexistent")).toEqual({
      ok: false,
      failure: "unknown",
    });
    expect(await service.verifyAccessToken(pair.refreshToken)).toEqual({
      ok: false,
      failure: "unknown",
    });
  });

  it("rejects expired tokens", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { service } = createService();
    const pair = await service.mintPair("user-1", SUBJECT);
    vi.setSystemTime(1_000_000 + WEB_SESSION_TOKEN_TTL_MS + 1);
    expect(await service.verifyAccessToken(pair.accessToken)).toEqual({
      ok: false,
      failure: "expired",
    });
  });

  it("rejects revoked tokens", async () => {
    const { service, store } = createService();
    const pair = await service.mintPair("user-1", SUBJECT);
    const accessRow = [...store.rows.values()].find((r) => r.kind === "web_session")!;
    await store.revokeToken(accessRow.id);
    expect(await service.verifyAccessToken(pair.accessToken)).toEqual({
      ok: false,
      failure: "revoked",
    });
  });

  it("fails closed on rows missing the minted subject/family shape", async () => {
    const { service, store } = createService();
    const pair = await service.mintPair("user-1", SUBJECT);
    const accessRow = [...store.rows.values()].find((r) => r.kind === "web_session")!;
    accessRow.familyId = null;
    expect(await service.verifyAccessToken(pair.accessToken)).toEqual({
      ok: false,
      failure: "unknown",
    });
  });
});

describe("redeemRefreshToken", () => {
  it("rotates: mints a new pair in the same family and consumes the old token", async () => {
    const { service, store } = createService();
    const first = await service.mintPair("user-1", SUBJECT);
    const result = await service.redeemRefreshToken(first.refreshToken);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pair.accessToken).not.toBe(first.accessToken);
    expect((await service.verifyAccessToken(result.pair.accessToken)).ok).toBe(true);

    const families = new Set([...store.rows.values()].map((r) => r.familyId));
    expect(families.size).toBe(1);
    const oldRefresh = [...store.rows.values()].find(
      (r) => r.kind === "web_session_refresh" && r.rotatedTo !== null
    );
    expect(oldRefresh).toBeDefined();
  });

  it("caps the rotated leaf's expiry at the family cap", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { service } = createService();
    const first = await service.mintPair("user-1", SUBJECT);
    // Advance close to the family cap: a fresh 30d leaf would overshoot it.
    vi.setSystemTime(1_000_000 + WEB_SESSION_FAMILY_TTL_MS - 1000);
    const result = await service.redeemRefreshToken(first.refreshToken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The original leaf itself expired (30d < 90d elapsed) — invalid, not reuse.
    expect(result.failure).toBe("invalid_refresh_token");
  });

  it("caps a mid-family rotation at family_expires_at", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const DAY_MS = 24 * 60 * 60 * 1000;
    const { service } = createService();
    let latest = await service.mintPair("user-1", SUBJECT);
    // Rotate at 29d and 58d (each leaf still valid), then at 61d, where a
    // fresh 30d leaf would outlive the 90d family cap and must be truncated.
    for (const day of [29, 58, 61]) {
      vi.setSystemTime(1_000_000 + day * DAY_MS);
      const result = await service.redeemRefreshToken(latest.refreshToken);
      expect(result.ok, `rotation at day ${day}`).toBe(true);
      if (!result.ok) return;
      latest = result.pair;
    }
    expect(latest.refreshTokenExpiresAtEpochMs).toBe(1_000_000 + WEB_SESSION_FAMILY_TTL_MS);
  });

  it("tolerates replay within the grace window without revoking the family", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { service } = createService();
    const first = await service.mintPair("user-1", SUBJECT);
    const rotated = await service.redeemRefreshToken(first.refreshToken);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;

    // A concurrent renewal that lost the race replays the consumed token
    // almost immediately: rejected, but the rotated pair stays live.
    vi.setSystemTime(1_000_000 + 5_000);
    const replay = await service.redeemRefreshToken(first.refreshToken);
    expect(replay).toEqual({ ok: false, failure: "invalid_refresh_token" });
    expect((await service.verifyAccessToken(rotated.pair.accessToken)).ok).toBe(true);
  });

  it("detects reuse after the grace window and revokes the whole family", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { service } = createService();
    const first = await service.mintPair("user-1", SUBJECT);
    const rotated = await service.redeemRefreshToken(first.refreshToken);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;

    vi.setSystemTime(1_000_000 + REFRESH_REUSE_GRACE_MS + 1000);
    const replay = await service.redeemRefreshToken(first.refreshToken);
    expect(replay).toEqual({ ok: false, failure: "refresh_reuse_detected" });

    // Family revocation kills the live pair minted by the legitimate rotation.
    expect(await service.verifyAccessToken(rotated.pair.accessToken)).toEqual({
      ok: false,
      failure: "revoked",
    });
    expect(await service.redeemRefreshToken(rotated.pair.refreshToken)).toEqual({
      ok: false,
      failure: "invalid_refresh_token",
    });
  });

  it("treats losing the consume race as benign and revokes only the orphaned pair", async () => {
    const { service, store } = createService();
    const first = await service.mintPair("user-1", SUBJECT);
    const originalConsume = store.consumeRefreshToken.bind(store);
    store.consumeRefreshToken = async () => false;
    const result = await service.redeemRefreshToken(first.refreshToken);
    store.consumeRefreshToken = originalConsume;
    expect(result).toEqual({ ok: false, failure: "invalid_refresh_token" });

    // Only the loser's freshly minted pair is revoked; the original refresh
    // token row (the presumed race winner's input) is untouched.
    const revoked = [...store.rows.values()].filter((r) => r.revokedAt !== null);
    expect(revoked).toHaveLength(2);
    const firstRefreshHashRow = [...store.rows.values()].find(
      (r) => r.kind === "web_session_refresh" && r.revokedAt === null && r.rotatedTo === null
    );
    expect(firstRefreshHashRow).toBeDefined();
  });

  it("rejects unknown, revoked, and access tokens", async () => {
    const { service, store } = createService();
    const pair = await service.mintPair("user-1", SUBJECT);
    expect(await service.redeemRefreshToken("oi_rt_nonexistent")).toEqual({
      ok: false,
      failure: "invalid_refresh_token",
    });
    expect(await service.redeemRefreshToken(pair.accessToken)).toEqual({
      ok: false,
      failure: "invalid_refresh_token",
    });
    const refreshRow = [...store.rows.values()].find((r) => r.kind === "web_session_refresh")!;
    await store.revokeToken(refreshRow.id);
    expect(await service.redeemRefreshToken(pair.refreshToken)).toEqual({
      ok: false,
      failure: "invalid_refresh_token",
    });
  });

  it("fails closed on refresh rows missing the minted subject/family shape", async () => {
    const { service, store } = createService();
    const pair = await service.mintPair("user-1", SUBJECT);
    const refreshRow = [...store.rows.values()].find((r) => r.kind === "web_session_refresh")!;
    refreshRow.provider = "not-a-web-provider";
    expect(await service.redeemRefreshToken(pair.refreshToken)).toEqual({
      ok: false,
      failure: "invalid_refresh_token",
    });
  });

  it("fails closed on refresh rows missing the family cap", async () => {
    const { service, store } = createService();
    const pair = await service.mintPair("user-1", SUBJECT);
    const refreshRow = [...store.rows.values()].find((r) => r.kind === "web_session_refresh")!;
    refreshRow.familyExpiresAt = null;
    expect(await service.redeemRefreshToken(pair.refreshToken)).toEqual({
      ok: false,
      failure: "invalid_refresh_token",
    });
  });
});

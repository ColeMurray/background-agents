import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { UserScmTokenStore } from "./user-scm-tokens";
import { generateEncryptionKey } from "../auth/crypto";

let didPolyfillCrypto = false;

beforeAll(() => {
  if (!(globalThis as { crypto?: typeof webcrypto }).crypto) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
    didPolyfillCrypto = true;
  }
});

afterAll(() => {
  if (didPolyfillCrypto) {
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
  }
});

type ScmTokenRow = {
  provider: string;
  provider_user_id: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  token_expires_at: number;
  created_at: number;
  updated_at: number;
};

const QUERY_PATTERNS = {
  SELECT_TOKENS:
    /^SELECT access_token_encrypted, refresh_token_encrypted, token_expires_at FROM user_scm_tokens/,
  UPSERT_TOKENS: /^INSERT INTO user_scm_tokens/,
  CAS_UPDATE: /^UPDATE user_scm_tokens/,
} as const;

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

class FakeD1Database {
  private rows = new Map<string, ScmTokenRow>();

  prepare(query: string) {
    return new FakePreparedStatement(this, query);
  }

  first(query: string, args: unknown[]) {
    const normalized = normalizeQuery(query);

    if (QUERY_PATTERNS.SELECT_TOKENS.test(normalized)) {
      const providerUserId = args[0] as string;
      const row = this.rows.get(providerUserId);
      if (!row) return null;
      return {
        access_token_encrypted: row.access_token_encrypted,
        refresh_token_encrypted: row.refresh_token_encrypted,
        token_expires_at: row.token_expires_at,
      };
    }

    throw new Error(`Unexpected first() query: ${query}`);
  }

  run(query: string, args: unknown[]) {
    const normalized = normalizeQuery(query);

    if (QUERY_PATTERNS.UPSERT_TOKENS.test(normalized)) {
      const [provider, providerUserId, accessEnc, refreshEnc, expiresAt, createdAt, updatedAt] =
        args as [string, string, string, string, number, number, number];
      const existing = this.rows.get(providerUserId);
      this.rows.set(providerUserId, {
        provider,
        provider_user_id: providerUserId,
        access_token_encrypted: accessEnc,
        refresh_token_encrypted: refreshEnc,
        token_expires_at: expiresAt,
        created_at: existing ? existing.created_at : createdAt,
        updated_at: updatedAt,
      });
      return { meta: { changes: 1 } };
    }

    if (QUERY_PATTERNS.CAS_UPDATE.test(normalized)) {
      const [
        newAccessEnc,
        newRefreshEnc,
        newExpiresAt,
        updatedAt,
        providerUserId,
        expectedRefreshEnc,
      ] = args as [string, string, number, number, string, string];
      const existing = this.rows.get(providerUserId);
      if (!existing || existing.refresh_token_encrypted !== expectedRefreshEnc) {
        return { meta: { changes: 0 } };
      }
      this.rows.set(providerUserId, {
        ...existing,
        access_token_encrypted: newAccessEnc,
        refresh_token_encrypted: newRefreshEnc,
        token_expires_at: newExpiresAt,
        updated_at: updatedAt,
      });
      return { meta: { changes: 1 } };
    }

    throw new Error(`Unexpected mutation query: ${query}`);
  }

  /** Expose rows for assertions */
  getRow(providerUserId: string): ScmTokenRow | undefined {
    return this.rows.get(providerUserId);
  }
}

class FakePreparedStatement {
  private bound: unknown[] = [];

  constructor(
    private db: FakeD1Database,
    private query: string
  ) {}

  bind(...args: unknown[]) {
    this.bound = args;
    return this;
  }

  async first<T>() {
    return this.db.first(this.query, this.bound) as T | null;
  }

  async run() {
    return this.db.run(this.query, this.bound);
  }
}

describe("UserScmTokenStore", () => {
  let db: FakeD1Database;
  let store: UserScmTokenStore;

  beforeEach(() => {
    db = new FakeD1Database();
    store = new UserScmTokenStore(db as unknown as D1Database, generateEncryptionKey());
  });

  it("upsertTokens + getTokens round-trip", async () => {
    const expiresAt = Date.now() + 3600_000;
    await store.upsertTokens("github", "user-123", "access-abc", "refresh-xyz", expiresAt);

    const result = await store.getTokens("user-123");
    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe("access-abc");
    expect(result!.refreshToken).toBe("refresh-xyz");
    expect(result!.expiresAt).toBe(expiresAt);
    expect(result!.refreshTokenEncrypted).toBeTypeOf("string");
  });

  it("upsertTokens overwrites existing row", async () => {
    const expiresAt1 = Date.now() + 3600_000;
    const expiresAt2 = Date.now() + 7200_000;

    await store.upsertTokens("github", "user-123", "access-1", "refresh-1", expiresAt1);
    await store.upsertTokens("github", "user-123", "access-2", "refresh-2", expiresAt2);

    const result = await store.getTokens("user-123");
    expect(result!.accessToken).toBe("access-2");
    expect(result!.refreshToken).toBe("refresh-2");
    expect(result!.expiresAt).toBe(expiresAt2);
  });

  it("casUpdateTokens succeeds when refresh token matches", async () => {
    const expiresAt = Date.now() + 3600_000;
    await store.upsertTokens("github", "user-123", "access-old", "refresh-old", expiresAt);

    const tokens = await store.getTokens("user-123");
    const casResult = await store.casUpdateTokens(
      "user-123",
      tokens!.refreshTokenEncrypted,
      "access-new",
      "refresh-new",
      expiresAt + 3600_000
    );

    expect(casResult).toEqual({ ok: true });

    const updated = await store.getTokens("user-123");
    expect(updated!.accessToken).toBe("access-new");
    expect(updated!.refreshToken).toBe("refresh-new");
  });

  it("casUpdateTokens returns cas_conflict when refresh token doesn't match", async () => {
    const expiresAt = Date.now() + 3600_000;
    await store.upsertTokens("github", "user-123", "access-old", "refresh-old", expiresAt);

    const casResult = await store.casUpdateTokens(
      "user-123",
      "wrong-encrypted-value",
      "access-new",
      "refresh-new",
      expiresAt + 3600_000
    );

    expect(casResult).toEqual({ ok: false, reason: "cas_conflict" });

    // Original values unchanged
    const unchanged = await store.getTokens("user-123");
    expect(unchanged!.accessToken).toBe("access-old");
  });

  it("getTokens returns null for unknown user", async () => {
    const result = await store.getTokens("nonexistent");
    expect(result).toBeNull();
  });

  it("provider column is stored correctly", async () => {
    await store.upsertTokens(
      "gitlab",
      "user-456",
      "access-gl",
      "refresh-gl",
      Date.now() + 3600_000
    );

    const row = db.getRow("user-456");
    expect(row).toBeDefined();
    expect(row!.provider).toBe("gitlab");
  });

  describe("isTokenFresh", () => {
    it("returns true when token expires well in the future", () => {
      expect(store.isTokenFresh(Date.now() + 120_000)).toBe(true);
    });

    it("returns false when token is within default buffer", () => {
      expect(store.isTokenFresh(Date.now() + 30_000)).toBe(false);
    });

    it("returns false when token is already expired", () => {
      expect(store.isTokenFresh(Date.now() - 1000)).toBe(false);
    });

    it("respects custom buffer", () => {
      const expiresAt = Date.now() + 30_000;
      expect(store.isTokenFresh(expiresAt, 10_000)).toBe(true);
      expect(store.isTokenFresh(expiresAt, 60_000)).toBe(false);
    });
  });
});

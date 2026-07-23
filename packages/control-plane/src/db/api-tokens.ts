/**
 * Store for CP-issued opaque credentials (`api_tokens`): web session tokens
 * and their rotating refresh tokens. Rows hold SHA-256 hashes — plaintext
 * tokens never reach storage or logs.
 */

import { generateId } from "../auth/crypto";
import type { SqlDatabase } from "./sql-database";

export type ApiTokenKind = "web_session" | "web_session_refresh";

export interface ApiTokenRow {
  id: string;
  tokenHash: string;
  kind: ApiTokenKind;
  userId: string;
  provider: string | null;
  providerUserId: string | null;
  familyId: string | null;
  rotatedTo: string | null;
  createdAt: number;
  expiresAt: number;
  familyExpiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

export interface NewApiToken {
  tokenHash: string;
  kind: ApiTokenKind;
  userId: string;
  provider: string;
  providerUserId: string;
  familyId: string;
  expiresAt: number;
  familyExpiresAt: number | null;
}

/**
 * The store surface WebSessionTokenService consumes (engine-neutral, like
 * SqlDatabase). ApiTokenStore is the D1 implementation; test doubles declare
 * this interface so their conformance is compiler-checked.
 */
export interface WebSessionTokenStore {
  createPair(tokens: [NewApiToken, NewApiToken]): Promise<[string, string]>;
  getByHash(tokenHash: string): Promise<ApiTokenRow | null>;
  getById(id: string): Promise<ApiTokenRow | null>;
  consumeRefreshToken(id: string, successorId: string): Promise<boolean>;
  revokeFamily(familyId: string): Promise<void>;
  revokeToken(id: string): Promise<void>;
}

/**
 * How long past `expires_at` a row must be before the retention sweep deletes
 * it. Generous compared to REFRESH_REUSE_GRACE_MS: the grace check resolves a
 * rotated token's successor by id, so both rows must outlive the window —
 * a day past expiry, nothing can still legitimately reference the row.
 */
export const EXPIRED_TOKEN_RETENTION_MS = 24 * 60 * 60 * 1000;

interface ApiTokenDbRow {
  id: string;
  token_hash: string;
  kind: ApiTokenKind;
  user_id: string;
  provider: string | null;
  provider_user_id: string | null;
  family_id: string | null;
  rotated_to: string | null;
  created_at: number;
  expires_at: number;
  family_expires_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
}

function toApiTokenRow(row: ApiTokenDbRow): ApiTokenRow {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    kind: row.kind,
    userId: row.user_id,
    provider: row.provider,
    providerUserId: row.provider_user_id,
    familyId: row.family_id,
    rotatedTo: row.rotated_to,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    familyExpiresAt: row.family_expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  };
}

const INSERT_TOKEN_SQL = `INSERT INTO api_tokens
  (id, token_hash, kind, user_id, provider, provider_user_id, family_id, created_at, expires_at, family_expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export class ApiTokenStore implements WebSessionTokenStore {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Insert an access/refresh token pair atomically. Returns the generated row
   * ids in input order.
   */
  async createPair(tokens: [NewApiToken, NewApiToken]): Promise<[string, string]> {
    const now = Date.now();
    const ids: [string, string] = [generateId(), generateId()];
    await this.db.batch(
      tokens.map((token, i) =>
        this.db
          .prepare(INSERT_TOKEN_SQL)
          .bind(
            ids[i],
            token.tokenHash,
            token.kind,
            token.userId,
            token.provider,
            token.providerUserId,
            token.familyId,
            now,
            token.expiresAt,
            token.familyExpiresAt
          )
      )
    );
    return ids;
  }

  async getByHash(tokenHash: string): Promise<ApiTokenRow | null> {
    const row = await this.db
      .prepare("SELECT * FROM api_tokens WHERE token_hash = ?")
      .bind(tokenHash)
      .first<ApiTokenDbRow>();
    return row ? toApiTokenRow(row) : null;
  }

  async getById(id: string): Promise<ApiTokenRow | null> {
    const row = await this.db
      .prepare("SELECT * FROM api_tokens WHERE id = ?")
      .bind(id)
      .first<ApiTokenDbRow>();
    return row ? toApiTokenRow(row) : null;
  }

  /**
   * Mark a refresh token consumed by its successor. Compare-and-set: returns
   * false when the token was already consumed or revoked (a concurrent redeem
   * or a replay), in which case the caller must treat the redeem as reuse.
   */
  async consumeRefreshToken(id: string, successorId: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE api_tokens SET rotated_to = ? WHERE id = ? AND rotated_to IS NULL AND revoked_at IS NULL"
      )
      .bind(successorId, id)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /** Revoke every token in a rotation family (refresh-reuse response). */
  async revokeFamily(familyId: string): Promise<void> {
    await this.db
      .prepare("UPDATE api_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL")
      .bind(Date.now(), familyId)
      .run();
  }

  async revokeToken(id: string): Promise<void> {
    await this.db
      .prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(Date.now(), id)
      .run();
  }

  /** Best-effort usage stamp; callers run it via waitUntil, never awaited inline. */
  async touchLastUsed(id: string): Promise<void> {
    await this.db
      .prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?")
      .bind(Date.now(), id)
      .run();
  }

  /**
   * Retention sweep: delete rows EXPIRED_TOKEN_RETENTION_MS past expiry.
   * Bare-column comparison on purpose — anything fancier skips the plain
   * expires_at index (migration 0044; see the 0024 lesson). Returns the
   * number of rows deleted.
   */
  async deleteExpired(now: number): Promise<number> {
    const result = await this.db
      .prepare("DELETE FROM api_tokens WHERE expires_at <= ?")
      .bind(now - EXPIRED_TOKEN_RETENTION_MS)
      .run();
    return result.meta?.changes ?? 0;
  }
}

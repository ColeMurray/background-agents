/**
 * Storage for personal access tokens.
 *
 * The plaintext token is returned exactly once, by `create`. Everything
 * persisted here is either a hash or non-secret metadata, so this store can be
 * read in full without yielding a usable credential.
 */

import {
  ACCESS_TOKEN_DISPLAY_CHARS,
  ACCESS_TOKEN_PREFIX,
  ACCESS_TOKEN_RANDOM_BYTES,
  type AccessToken,
  type CreatedAccessToken,
} from "@open-inspect/shared/types/access-tokens";
import { generateId, hashToken } from "../auth/crypto";
import type { SqlDatabase } from "./sql-database";

/**
 * How coarsely `last_used_at` is tracked. It answers "is this token still in
 * use?", so minute resolution is ample and spares the write path a row update
 * per request.
 */
const LAST_USED_RESOLUTION_MS = 60_000;

/** A token row resolved during authentication. */
export interface AccessTokenIdentity {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: number | null;
}

interface AccessTokenRow {
  id: string;
  name: string;
  display_prefix: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
}

function toAccessToken(row: AccessTokenRow): AccessToken {
  return {
    id: row.id,
    name: row.name,
    displayPrefix: row.display_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
  };
}

export interface CreateAccessTokenInput {
  readonly userId: string;
  readonly name: string;
  readonly expiresAt: number | null;
}

export class PersonalAccessTokenStore {
  constructor(private readonly db: SqlDatabase) {}

  async create(input: CreateAccessTokenInput): Promise<CreatedAccessToken> {
    const secret = generateId(ACCESS_TOKEN_RANDOM_BYTES);
    const token = `${ACCESS_TOKEN_PREFIX}${secret}`;
    const id = generateId();
    const displayPrefix = `${ACCESS_TOKEN_PREFIX}${secret.slice(0, ACCESS_TOKEN_DISPLAY_CHARS)}`;
    const createdAt = Date.now();

    await this.db
      .prepare(
        `INSERT INTO personal_access_tokens
           (id, user_id, name, token_hash, display_prefix, created_at, last_used_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
      )
      .bind(
        id,
        input.userId,
        input.name,
        await hashToken(token),
        displayPrefix,
        createdAt,
        input.expiresAt
      )
      .run();

    return {
      id,
      name: input.name,
      displayPrefix,
      createdAt,
      lastUsedAt: null,
      expiresAt: input.expiresAt,
      token,
    };
  }

  async list(userId: string): Promise<AccessToken[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, name, display_prefix, created_at, last_used_at, expires_at
           FROM personal_access_tokens
          WHERE user_id = ?
          ORDER BY created_at DESC`
      )
      .bind(userId)
      .all<AccessTokenRow>();
    return results.map(toAccessToken);
  }

  /**
   * Revokes one of `userId`'s tokens. Scoped by user so a token id alone —
   * which appears in listings and logs — cannot revoke someone else's.
   */
  async revoke(userId: string, id: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM personal_access_tokens WHERE id = ? AND user_id = ?")
      .bind(id, userId)
      .run();
    return result.meta.changes > 0;
  }

  /**
   * Resolves a presented token by its hash. Expiry is deliberately not
   * filtered in SQL: the caller decides, so an expired token can be reported
   * as expired rather than as unknown.
   */
  async findByToken(token: string): Promise<AccessTokenIdentity | null> {
    const row = await this.db
      .prepare(`SELECT id, user_id, expires_at FROM personal_access_tokens WHERE token_hash = ?`)
      .bind(await hashToken(token))
      .first<{ id: string; user_id: string; expires_at: number | null }>();
    if (!row) return null;
    return { id: row.id, userId: row.user_id, expiresAt: row.expires_at };
  }

  /**
   * Records use, at most once per LAST_USED_RESOLUTION_MS.
   *
   * The guard is in the statement rather than a read-then-write so the common
   * case costs one round trip and concurrent requests cannot both decide to
   * write. Every authenticated read would otherwise bill a D1 write, which an
   * MCP client polling the control plane turns into sustained write load for
   * a field only ever read at human resolution.
   */
  async touchLastUsed(id: string, at: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE personal_access_tokens
            SET last_used_at = ?
          WHERE id = ?
            AND (last_used_at IS NULL OR last_used_at < ?)`
      )
      .bind(at, id, at - LAST_USED_RESOLUTION_MS)
      .run();
  }
}

import type { SqlDatabase } from "./sql-database";

export interface CliDeviceAuthorizationAttemptInput {
  id: string;
  deviceName: string;
  deviceSecretHash: string;
  userCodeHash: string;
  createdAt: number;
  expiresAt: number;
}

export type CliApprovalOutcome = "approved" | "not_found" | "expired" | "unavailable";
export type CliPendingAuthorizationOutcome =
  | { status: "pending"; deviceName: string; expiresAt: number }
  | { status: "not_found" | "expired" | "unavailable" };
export type CliExchangeOutcome =
  | { status: "issued" }
  | { status: "pending"; expiresAt: number }
  | { status: "expired" | "consumed" | "not_found" };

interface AttemptStateRow {
  approved_user_id: string | null;
  expires_at: number;
  exchanged_at: number | null;
}

interface PendingAttemptRow extends AttemptStateRow {
  device_name: string;
}

interface RateLimitRow {
  request_count: number;
}

export interface ActiveCliCredential {
  id: string;
  userId: string;
  expiresAt: number;
}

interface CredentialRow {
  id: string;
  user_id: string;
  expires_at: number;
}

/** Persists hash-only CLI device attempts and revocable bearer credentials. */
export class CliAuthStore {
  constructor(private readonly db: SqlDatabase) {}

  async createAttempt(input: CliDeviceAuthorizationAttemptInput): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO cli_device_authorization_attempts
          (id, device_name, device_secret_hash, user_code_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.id,
        input.deviceName,
        input.deviceSecretHash,
        input.userCodeHash,
        input.createdAt,
        input.expiresAt
      )
      .run();
  }

  async approve(userCodeHash: string, userId: string, now: number): Promise<CliApprovalOutcome> {
    const result = await this.db
      .prepare(
        `UPDATE cli_device_authorization_attempts
         SET approved_user_id = ?, approved_at = ?
         WHERE user_code_hash = ? AND approved_user_id IS NULL
           AND exchanged_at IS NULL AND expires_at > ?`
      )
      .bind(userId, now, userCodeHash, now)
      .run();
    if (result.meta.changes === 1) return "approved";

    const row = await this.db
      .prepare(
        `SELECT approved_user_id, expires_at, exchanged_at
         FROM cli_device_authorization_attempts WHERE user_code_hash = ?`
      )
      .bind(userCodeHash)
      .first<AttemptStateRow>();
    if (!row) return "not_found";
    if (row.expires_at <= now) return "expired";
    return "unavailable";
  }

  async getPendingAuthorization(
    userCodeHash: string,
    now: number
  ): Promise<CliPendingAuthorizationOutcome> {
    const row = await this.db
      .prepare(
        `SELECT device_name, approved_user_id, expires_at, exchanged_at
         FROM cli_device_authorization_attempts WHERE user_code_hash = ?`
      )
      .bind(userCodeHash)
      .first<PendingAttemptRow>();
    if (!row) return { status: "not_found" };
    if (row.expires_at <= now) return { status: "expired" };
    if (row.approved_user_id !== null || row.exchanged_at !== null)
      return { status: "unavailable" };
    return { status: "pending", deviceName: row.device_name, expiresAt: row.expires_at };
  }

  async consumeRateLimit(input: {
    key: string;
    now: number;
    windowMs: number;
    limit: number;
  }): Promise<{ allowed: boolean; retryAfterMs: number }> {
    const windowStartedAt = Math.floor(input.now / input.windowMs) * input.windowMs;
    const expiresAt = windowStartedAt + input.windowMs;
    const row = await this.db
      .prepare(
        `INSERT INTO cli_auth_rate_limits (rate_key, window_started_at, request_count, expires_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(rate_key, window_started_at)
         DO UPDATE SET request_count = request_count + 1
         RETURNING request_count`
      )
      .bind(input.key, windowStartedAt, expiresAt)
      .first<RateLimitRow>();
    if (!row) throw new Error("CLI auth rate-limit counter did not return a row");
    return {
      allowed: row.request_count <= input.limit,
      retryAfterMs: Math.max(1, expiresAt - input.now),
    };
  }

  async pruneExpired(input: {
    now: number;
    attemptRetentionMs: number;
    credentialRetentionMs: number;
    limit: number;
  }): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM cli_device_authorization_attempts
           WHERE id IN (
             SELECT id FROM cli_device_authorization_attempts
             WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
           )`
        )
        .bind(input.now - input.attemptRetentionMs, input.limit),
      this.db
        .prepare(
          `DELETE FROM cli_credentials
           WHERE id IN (
             SELECT id FROM cli_credentials
             WHERE expires_at <= ? OR revoked_at <= ?
             ORDER BY expires_at LIMIT ?
           )`
        )
        .bind(
          input.now - input.credentialRetentionMs,
          input.now - input.credentialRetentionMs,
          input.limit
        ),
      this.db
        .prepare(
          `DELETE FROM cli_auth_rate_limits
           WHERE rowid IN (
             SELECT rowid FROM cli_auth_rate_limits
             WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
           )`
        )
        .bind(input.now, input.limit),
    ]);
  }

  async exchangeApprovedAttempt(input: {
    deviceSecretHash: string;
    claimId: string;
    credentialId: string;
    credentialHash: string;
    now: number;
    credentialExpiresAt: number;
  }): Promise<CliExchangeOutcome> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE cli_device_authorization_attempts
           SET exchange_claim_id = ?, exchanged_at = ?
           WHERE device_secret_hash = ? AND approved_user_id IS NOT NULL
             AND exchanged_at IS NULL AND expires_at > ?`
        )
        .bind(input.claimId, input.now, input.deviceSecretHash, input.now),
      this.db
        .prepare(
          `INSERT INTO cli_credentials (id, token_hash, user_id, created_at, expires_at)
           SELECT ?, ?, approved_user_id, ?, ?
           FROM cli_device_authorization_attempts
           WHERE device_secret_hash = ? AND exchange_claim_id = ?`
        )
        .bind(
          input.credentialId,
          input.credentialHash,
          input.now,
          input.credentialExpiresAt,
          input.deviceSecretHash,
          input.claimId
        ),
    ]);
    if (results[1].meta.changes === 1) {
      return { status: "issued" };
    }

    const row = await this.db
      .prepare(
        `SELECT approved_user_id, expires_at, exchanged_at
         FROM cli_device_authorization_attempts WHERE device_secret_hash = ?`
      )
      .bind(input.deviceSecretHash)
      .first<AttemptStateRow>();
    if (!row) return { status: "not_found" };
    if (row.expires_at <= input.now) return { status: "expired" };
    if (row.exchanged_at !== null) return { status: "consumed" };
    return { status: "pending", expiresAt: row.expires_at };
  }

  async getActiveCredential(tokenHash: string, now: number): Promise<ActiveCliCredential | null> {
    const row = await this.db
      .prepare(
        `UPDATE cli_credentials SET last_seen_at = ?
         WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?
         RETURNING id, user_id, expires_at`
      )
      .bind(now, tokenHash, now)
      .first<CredentialRow>();
    if (!row) return null;
    return { id: row.id, userId: row.user_id, expiresAt: row.expires_at };
  }

  async revoke(credentialId: string, userId: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE cli_credentials SET revoked_at = ?
         WHERE id = ? AND user_id = ? AND revoked_at IS NULL`
      )
      .bind(now, credentialId, userId)
      .run();
    return result.meta.changes === 1;
  }
}

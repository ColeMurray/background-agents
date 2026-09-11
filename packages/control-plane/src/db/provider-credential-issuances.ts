/**
 * Stored-provider-secret issuance and the cleanup outbox.
 *
 * A static provider credential (a Claude setup token) is handed to a sandbox
 * once at boot. Every hand-out is an issuance row: which sandbox of which
 * session received which credential version. When the account is disabled,
 * archived, rotated or fenced, a trigger (migration 0076) writes a cleanup
 * outbox row atomically with that mutation, and the coordinator terminates
 * exactly the sandboxes with live issuances at or below the revoked version.
 */

import type { SqlDatabase } from "./sql-database";

export type ProviderCredentialCleanupReason = "disabled" | "archived" | "reconnected" | "expired";

export interface ProviderCredentialIssuance {
  id: string;
  providerAccountId: string;
  provider: string;
  sessionId: string;
  sandboxId: string;
  credentialVersion: number;
  issuedAt: number;
  terminatedAt: number | null;
}

export interface ProviderCredentialCleanupTask {
  id: string;
  providerAccountId: string;
  provider: string;
  reason: ProviderCredentialCleanupReason;
  credentialVersion: number;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
}

interface IssuanceRow {
  id: string;
  provider_account_id: string;
  provider: string;
  session_id: string;
  sandbox_id: string;
  credential_version: number;
  issued_at: number;
  terminated_at: number | null;
}

interface OutboxRow {
  id: string;
  provider_account_id: string;
  provider: string;
  reason: ProviderCredentialCleanupReason;
  credential_version: number;
  attempts: number;
  next_attempt_at: number;
  created_at: number;
}

function toIssuance(row: IssuanceRow): ProviderCredentialIssuance {
  return {
    id: row.id,
    providerAccountId: row.provider_account_id,
    provider: row.provider,
    sessionId: row.session_id,
    sandboxId: row.sandbox_id,
    credentialVersion: row.credential_version,
    issuedAt: row.issued_at,
    terminatedAt: row.terminated_at,
  };
}

function toTask(row: OutboxRow): ProviderCredentialCleanupTask {
  return {
    id: row.id,
    providerAccountId: row.provider_account_id,
    provider: row.provider,
    reason: row.reason,
    credentialVersion: row.credential_version,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
  };
}

export class ProviderCredentialIssuanceStore {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Record a hand-out under an active-account/version guard: the row is only
   * written while the account is active, unarchived, and still on the
   * credential version being handed out. Returns false when the guard fails,
   * and the caller must not release the secret.
   */
  async record(input: {
    id: string;
    providerAccountId: string;
    provider: string;
    sessionId: string;
    sandboxId: string;
    credentialVersion: number;
    now: number;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO model_provider_credential_issuances
           (id, provider_account_id, provider, session_id, sandbox_id, credential_version, issued_at)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM model_provider_accounts accounts
           JOIN model_provider_account_credentials credentials
             ON credentials.provider_account_id = accounts.id
           WHERE accounts.id = ? AND accounts.provider = ?
             AND accounts.status = 'active' AND accounts.archived_at IS NULL
             AND credentials.credential_version = ?
         )`
      )
      .bind(
        input.id,
        input.providerAccountId,
        input.provider,
        input.sessionId,
        input.sandboxId,
        input.credentialVersion,
        input.now,
        input.providerAccountId,
        input.provider,
        input.credentialVersion
      )
      .run();
    return result.meta.changes > 0;
  }

  /** Live issuances the revocation of `credentialVersion` invalidates. */
  async listLive(
    providerAccountId: string,
    maxCredentialVersion: number,
    limit = 100
  ): Promise<ProviderCredentialIssuance[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM model_provider_credential_issuances
         WHERE provider_account_id = ? AND credential_version <= ? AND terminated_at IS NULL
         ORDER BY issued_at ASC LIMIT ?`
      )
      .bind(providerAccountId, maxCredentialVersion, limit)
      .all<IssuanceRow>();
    return result.results.map(toIssuance);
  }

  async listForSession(sessionId: string): Promise<ProviderCredentialIssuance[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM model_provider_credential_issuances WHERE session_id = ? ORDER BY issued_at ASC`
      )
      .bind(sessionId)
      .all<IssuanceRow>();
    return result.results.map(toIssuance);
  }

  async terminate(id: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE model_provider_credential_issuances SET terminated_at = ?
         WHERE id = ? AND terminated_at IS NULL`
      )
      .bind(now, id)
      .run();
    return result.meta.changes > 0;
  }
}

export class ProviderAccountCleanupOutboxStore {
  constructor(private readonly db: SqlDatabase) {}

  async listDue(now: number, limit = 20): Promise<ProviderCredentialCleanupTask[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM model_provider_account_cleanup_outbox
         WHERE processed_at IS NULL AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC LIMIT ?`
      )
      .bind(now, limit)
      .all<OutboxRow>();
    return result.results.map(toTask);
  }

  async listForAccount(providerAccountId: string): Promise<ProviderCredentialCleanupTask[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM model_provider_account_cleanup_outbox
         WHERE provider_account_id = ? AND processed_at IS NULL ORDER BY created_at ASC`
      )
      .bind(providerAccountId)
      .all<OutboxRow>();
    return result.results.map(toTask);
  }

  async markProcessed(id: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE model_provider_account_cleanup_outbox SET processed_at = ?
         WHERE id = ? AND processed_at IS NULL`
      )
      .bind(now, id)
      .run();
    return result.meta.changes > 0;
  }

  async reschedule(id: string, attempts: number, nextAttemptAt: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE model_provider_account_cleanup_outbox SET attempts = ?, next_attempt_at = ?
         WHERE id = ? AND processed_at IS NULL`
      )
      .bind(attempts, nextAttemptAt, id)
      .run();
  }
}

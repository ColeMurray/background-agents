import type { ModelProviderId } from "../model-provider-accounts/provider-auth-contracts";
import type { SqlDatabase } from "./sql-database";
import type { ModelProviderAccountStatus } from "./model-provider-accounts";

export type ProviderAuthorizationOperation = "create" | "reconnect";
export const PROVIDER_AUTHORIZATION_LIVE_STATES = ["initiating", "pending", "processing"] as const;
export const PROVIDER_AUTHORIZATION_TERMINAL_STATES = [
  "denied",
  "expired",
  "failed",
  "cancelled",
  "superseded",
] as const;
export type ProviderAuthorizationLiveState = (typeof PROVIDER_AUTHORIZATION_LIVE_STATES)[number];
export type ProviderAuthorizationTerminalState =
  (typeof PROVIDER_AUTHORIZATION_TERMINAL_STATES)[number];
export type ProviderAuthorizationState =
  | ProviderAuthorizationLiveState
  | ProviderAuthorizationTerminalState
  | "connected";

export interface ProviderAuthorizationRow {
  id: string;
  user_id: string;
  provider: ModelProviderId;
  operation: ProviderAuthorizationOperation;
  provider_account_id: string | null;
  target_account_status: ModelProviderAccountStatus | null;
  target_account_lifecycle_version: number | null;
  display_name: string | null;
  encrypted_provider_data: string | null;
  provider_state_version: number | null;
  interval_ms: number;
  next_poll_at: number;
  expires_at: number;
  state: ProviderAuthorizationState;
  processing_owner: string | null;
  processing_started_at: number | null;
  result_provider_account_id: string | null;
  reconnected_existing: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

const LIVE_STATES_SQL = PROVIDER_AUTHORIZATION_LIVE_STATES.map((state) => `'${state}'`).join(", ");
const TERMINAL_REPLAY_RETENTION_MS = 10 * 60 * 1000;

export class ProviderAccountAuthorizationStore {
  constructor(private readonly db: SqlDatabase) {}

  async recordAttempt(id: string, userId: string, now: number): Promise<boolean> {
    const cutoff = now - 60_000;
    const results = await this.db.batch([
      this.db
        .prepare(
          "DELETE FROM model_provider_account_authorization_attempts WHERE attempted_at <= ?"
        )
        .bind(cutoff),
      this.db
        .prepare(
          `DELETE FROM model_provider_account_authorizations
           WHERE completed_at IS NOT NULL AND completed_at <= ?`
        )
        .bind(now - TERMINAL_REPLAY_RETENTION_MS),
      this.db
        .prepare(
          `INSERT INTO model_provider_account_authorization_attempts (id, user_id, attempted_at)
           SELECT ?, ?, ? WHERE (
             SELECT COUNT(*) FROM model_provider_account_authorization_attempts
             WHERE user_id = ? AND attempted_at > ?
           ) < 5`
        )
        .bind(id, userId, now, userId, cutoff),
    ]);
    return results[2].meta.changes === 1;
  }

  async reserve(input: {
    id: string;
    userId: string;
    provider: ModelProviderId;
    operation: ProviderAuthorizationOperation;
    providerAccountId: string | null;
    targetAccountStatus: ModelProviderAccountStatus | null;
    targetAccountLifecycleVersion: number | null;
    displayName: string | null;
    expiresAt: number;
    now: number;
  }): Promise<boolean> {
    const sameTarget =
      input.operation === "create"
        ? "provider = ? AND operation = 'create'"
        : "operation = 'reconnect' AND provider_account_id = ?";
    const targetBindings =
      input.operation === "create" ? [input.provider] : [input.providerAccountId];
    const inserted = this.db
      .prepare(
        `INSERT INTO model_provider_account_authorizations
           (id, user_id, provider, operation, provider_account_id, target_account_status,
            target_account_lifecycle_version, display_name, next_poll_at, expires_at, state,
            created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'initiating', ?, ?
         WHERE (
           SELECT COUNT(*) FROM model_provider_account_authorizations
           WHERE user_id = ? AND state IN (${LIVE_STATES_SQL}) AND NOT (${sameTarget})
         ) < 5`
      )
      .bind(
        input.id,
        input.userId,
        input.provider,
        input.operation,
        input.providerAccountId,
        input.targetAccountStatus,
        input.targetAccountLifecycleVersion,
        input.displayName,
        input.expiresAt,
        input.expiresAt,
        input.now,
        input.now,
        input.userId,
        ...targetBindings
      );
    const supersedeTarget =
      input.operation === "create"
        ? "user_id = ? AND provider = ? AND operation = 'create'"
        : "provider_account_id = ? AND operation = 'reconnect'";
    const supersedeBindings =
      input.operation === "create" ? [input.userId, input.provider] : [input.providerAccountId];
    const results = await this.db.batch([
      inserted,
      this.db
        .prepare(
          `UPDATE model_provider_account_authorizations
           SET state = 'superseded', encrypted_provider_data = NULL,
               provider_state_version = NULL,
               processing_owner = NULL, processing_started_at = NULL,
               completed_at = ?, updated_at = ?
           WHERE id <> ? AND state IN (${LIVE_STATES_SQL})
             AND ${supersedeTarget}
             -- Supersede only when this batch successfully inserted the replacement reservation.
             AND EXISTS (SELECT 1 FROM model_provider_account_authorizations WHERE id = ?)`
        )
        .bind(input.now, input.now, input.id, ...supersedeBindings, input.id),
    ]);
    return results[0].meta.changes === 1;
  }

  async activate(
    id: string,
    userId: string,
    encryptedProviderData: string,
    providerStateVersion: number,
    intervalMs: number,
    expiresAt: number,
    now: number
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE model_provider_account_authorizations
         SET encrypted_provider_data = ?, provider_state_version = ?, interval_ms = ?,
              next_poll_at = ?, expires_at = ?,
              state = 'pending', updated_at = ?
         WHERE id = ? AND user_id = ? AND state = 'initiating' AND expires_at > ?`
      )
      .bind(
        encryptedProviderData,
        providerStateVersion,
        intervalMs,
        now + intervalMs,
        expiresAt,
        now,
        id,
        userId,
        now
      )
      .run();
    return result.meta.changes === 1;
  }

  async getOwned(userId: string, id: string): Promise<ProviderAuthorizationRow | null> {
    return this.db
      .prepare("SELECT * FROM model_provider_account_authorizations WHERE id = ? AND user_id = ?")
      .bind(id, userId)
      .first<ProviderAuthorizationRow>();
  }

  async claim(id: string, userId: string, owner: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE model_provider_account_authorizations
         SET state = 'processing', processing_owner = ?, processing_started_at = ?, updated_at = ?
         WHERE id = ? AND user_id = ? AND state = 'pending'
           AND next_poll_at <= ? AND expires_at > ?`
      )
      .bind(owner, now, now, id, userId, now, now)
      .run();
    return result.meta.changes === 1;
  }

  async returnPending(
    id: string,
    owner: string,
    nextPollAt: number,
    intervalMs: number,
    now: number
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE model_provider_account_authorizations
         SET state = 'pending', processing_owner = NULL, processing_started_at = NULL,
             interval_ms = ?, next_poll_at = ?, updated_at = ?
         WHERE id = ? AND state = 'processing' AND processing_owner = ? AND expires_at > ?`
      )
      .bind(intervalMs, nextPollAt, now, id, owner, now)
      .run();
    return result.meta.changes === 1;
  }

  async finish(
    id: string,
    userId: string,
    state: ProviderAuthorizationTerminalState,
    now: number,
    owner?: string
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE model_provider_account_authorizations
         SET state = ?, encrypted_provider_data = NULL, provider_state_version = NULL,
             processing_owner = NULL,
             processing_started_at = NULL, completed_at = ?, updated_at = ?
         WHERE id = ? AND user_id = ? AND state IN (${LIVE_STATES_SQL})
           AND (? IS NULL OR processing_owner = ?)`
      )
      .bind(state, now, now, id, userId, owner ?? null, owner ?? null)
      .run();
    return result.meta.changes === 1;
  }

  async expire(
    id: string,
    userId: string,
    expectedState: ProviderAuthorizationLiveState,
    expectedOwner: string | null,
    now: number
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE model_provider_account_authorizations
         SET state = 'expired', encrypted_provider_data = NULL, provider_state_version = NULL,
             processing_owner = NULL, processing_started_at = NULL,
             completed_at = ?, updated_at = ?
         WHERE id = ? AND user_id = ? AND state = ? AND expires_at <= ?
           AND ((? IS NULL AND processing_owner IS NULL) OR processing_owner = ?)`
      )
      .bind(now, now, id, userId, expectedState, now, expectedOwner, expectedOwner)
      .run();
    return result.meta.changes === 1;
  }
}

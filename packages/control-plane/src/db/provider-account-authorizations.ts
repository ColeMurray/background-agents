import type { ModelProviderId } from "../model-provider-accounts/provider-auth-contracts";
import type { SqlDatabase } from "./sql-database";
import {
  modelProviderAccountStatusSchema,
  type ModelProviderAccountStatus,
} from "@open-inspect/shared/types/provider-accounts";
import { assertModelProviderId } from "../model-provider-accounts/provider-auth-contracts";

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
interface ProviderAuthorizationRow {
  id: string;
  user_id: string;
  provider: string;
  operation: string;
  provider_account_id: string | null;
  target_account_status: string | null;
  target_account_lifecycle_version: number | null;
  display_name: string | null;
  encrypted_provider_data: string | null;
  provider_state_version: number | null;
  interval_ms: number;
  next_poll_at: number;
  expires_at: number;
  state: string;
  processing_owner: string | null;
  processing_started_at: number | null;
  result_provider_account_id: string | null;
  reconnected_existing: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

interface ProviderAuthorizationCommon {
  id: string;
  userId: string;
  provider: ModelProviderId;
  intervalMs: number;
  nextPollAt: number;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

type ProviderAuthorizationTarget =
  | {
      operation: "create";
      displayName: string;
    }
  | {
      operation: "reconnect";
      providerAccountId: string;
      targetAccountStatus: ModelProviderAccountStatus;
      targetAccountLifecycleVersion: number;
    };

type InitiatingProviderAuthorization = ProviderAuthorizationCommon &
  ProviderAuthorizationTarget & {
    state: "initiating";
  };

export type PendingProviderAuthorization = ProviderAuthorizationCommon &
  ProviderAuthorizationTarget & {
    state: "pending";
    encryptedProviderData: string;
    providerStateVersion: number;
  };

export type ProcessingProviderAuthorization = ProviderAuthorizationCommon &
  ProviderAuthorizationTarget & {
    state: "processing";
    encryptedProviderData: string;
    providerStateVersion: number;
    processingOwner: string;
    processingStartedAt: number;
  };

export type ConnectedProviderAuthorization = ProviderAuthorizationCommon &
  ProviderAuthorizationTarget & {
    state: "connected";
    resultProviderAccountId: string;
    reconnectedExisting: boolean;
    completedAt: number;
  };

export type TerminalProviderAuthorization = ProviderAuthorizationCommon &
  ProviderAuthorizationTarget & {
    state: ProviderAuthorizationTerminalState;
    completedAt: number;
  };

export type ProviderAuthorization =
  | InitiatingProviderAuthorization
  | PendingProviderAuthorization
  | ProcessingProviderAuthorization
  | ConnectedProviderAuthorization
  | TerminalProviderAuthorization;

export type ProviderAuthorizationLive =
  | InitiatingProviderAuthorization
  | PendingProviderAuthorization
  | ProcessingProviderAuthorization;

function requiredString(value: string | null, field: string): string {
  if (!value) throw new Error(`Invalid provider authorization ${field}`);
  return value;
}

function requiredNumber(value: number | null, field: string): number {
  if (value === null) throw new Error(`Invalid provider authorization ${field}`);
  return value;
}

function requireNull(value: unknown, field: string): void {
  if (value !== null) throw new Error(`Invalid provider authorization ${field}`);
}

function requireNoProcessing(row: ProviderAuthorizationRow): void {
  requireNull(row.processing_owner, "processing owner");
  requireNull(row.processing_started_at, "processing start");
}

function requireNoResult(row: ProviderAuthorizationRow): void {
  requireNull(row.result_provider_account_id, "result provider account ID");
  requireNull(row.reconnected_existing, "reconnected result");
  requireNull(row.completed_at, "completion time");
}

function requireProviderStateCleared(row: ProviderAuthorizationRow): void {
  requireNull(row.encrypted_provider_data, "terminal provider data");
  requireNull(row.provider_state_version, "terminal provider state version");
}

function decodeAuthorization(row: ProviderAuthorizationRow): ProviderAuthorization {
  assertModelProviderId(row.provider);
  const common: ProviderAuthorizationCommon = {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    intervalMs: row.interval_ms,
    nextPollAt: row.next_poll_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  let target: ProviderAuthorizationTarget;
  if (row.operation === "create") {
    requireNull(row.provider_account_id, "create provider account ID");
    requireNull(row.target_account_status, "create target status");
    requireNull(row.target_account_lifecycle_version, "create target lifecycle version");
    target = { operation: "create", displayName: requiredString(row.display_name, "display name") };
  } else if (row.operation === "reconnect") {
    requireNull(row.display_name, "reconnect display name");
    target = {
      operation: "reconnect",
      providerAccountId: requiredString(row.provider_account_id, "provider account ID"),
      targetAccountStatus: modelProviderAccountStatusSchema.parse(row.target_account_status),
      targetAccountLifecycleVersion: requiredNumber(
        row.target_account_lifecycle_version,
        "target lifecycle version"
      ),
    };
  } else {
    throw new Error(`Invalid provider authorization operation: ${row.operation}`);
  }

  const liveProviderState = () => ({
    encryptedProviderData: requiredString(row.encrypted_provider_data, "provider data"),
    providerStateVersion: requiredNumber(row.provider_state_version, "provider state version"),
  });
  switch (row.state) {
    case "initiating":
      requireNull(row.encrypted_provider_data, "initiating provider data");
      requireNull(row.provider_state_version, "initiating provider state version");
      requireNoProcessing(row);
      requireNoResult(row);
      return { ...common, ...target, state: "initiating" };
    case "pending":
      requireNoProcessing(row);
      requireNoResult(row);
      return { ...common, ...target, state: "pending", ...liveProviderState() };
    case "processing":
      requireNoResult(row);
      return {
        ...common,
        ...target,
        state: "processing",
        ...liveProviderState(),
        processingOwner: requiredString(row.processing_owner, "processing owner"),
        processingStartedAt: requiredNumber(row.processing_started_at, "processing start"),
      };
    case "connected":
      requireProviderStateCleared(row);
      requireNoProcessing(row);
      if (row.reconnected_existing !== 0 && row.reconnected_existing !== 1) {
        throw new Error("Invalid provider authorization reconnected result");
      }
      return {
        ...common,
        ...target,
        state: "connected",
        resultProviderAccountId: requiredString(
          row.result_provider_account_id,
          "result provider account ID"
        ),
        reconnectedExisting: row.reconnected_existing === 1,
        completedAt: requiredNumber(row.completed_at, "completion time"),
      };
    case "denied":
    case "expired":
    case "failed":
    case "cancelled":
    case "superseded":
      requireProviderStateCleared(row);
      requireNoProcessing(row);
      requireNull(row.result_provider_account_id, "result provider account ID");
      requireNull(row.reconnected_existing, "reconnected result");
      return {
        ...common,
        ...target,
        state: row.state,
        completedAt: requiredNumber(row.completed_at, "completion time"),
      };
    default:
      throw new Error(`Invalid provider authorization state: ${row.state}`);
  }
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

  async getOwned(userId: string, id: string): Promise<ProviderAuthorization | null> {
    const row = await this.db
      .prepare("SELECT * FROM model_provider_account_authorizations WHERE id = ? AND user_id = ?")
      .bind(id, userId)
      .first<ProviderAuthorizationRow>();
    return row ? decodeAuthorization(row) : null;
  }

  async claim(
    id: string,
    userId: string,
    owner: string,
    now: number
  ): Promise<ProcessingProviderAuthorization | null> {
    const row = await this.db
      .prepare(
        `UPDATE model_provider_account_authorizations
         SET state = 'processing', processing_owner = ?, processing_started_at = ?, updated_at = ?
         WHERE id = ? AND user_id = ? AND state = 'pending'
           AND next_poll_at <= ? AND expires_at > ?
         RETURNING *`
      )
      .bind(owner, now, now, id, userId, now, now)
      .first<ProviderAuthorizationRow>();
    if (!row) return null;
    const authorization = decodeAuthorization(row);
    if (authorization.state !== "processing") {
      throw new Error("Claimed provider authorization was not processing");
    }
    return authorization;
  }

  async returnPending(
    authorization: ProcessingProviderAuthorization,
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
      .bind(intervalMs, nextPollAt, now, authorization.id, authorization.processingOwner, now)
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

  async expire(authorization: ProviderAuthorizationLive, now: number): Promise<boolean> {
    const expectedOwner =
      authorization.state === "processing" ? authorization.processingOwner : null;
    const result = await this.db
      .prepare(
        `UPDATE model_provider_account_authorizations
         SET state = 'expired', encrypted_provider_data = NULL, provider_state_version = NULL,
             processing_owner = NULL, processing_started_at = NULL,
             completed_at = ?, updated_at = ?
         WHERE id = ? AND user_id = ? AND state = ? AND expires_at <= ?
           AND ((? IS NULL AND processing_owner IS NULL) OR processing_owner = ?)`
      )
      .bind(
        now,
        now,
        authorization.id,
        authorization.userId,
        authorization.state,
        now,
        expectedOwner,
        expectedOwner
      )
      .run();
    return result.meta.changes === 1;
  }
}

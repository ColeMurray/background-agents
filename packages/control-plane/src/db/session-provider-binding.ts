import type { SubscriptionProviderId } from "@open-inspect/shared/types/provider-accounts";
import type { SqlDatabase } from "./sql-database";
import { SessionIndexStore } from "./session-index";

export interface BindingSwitch {
  sessionId: string;
  provider: SubscriptionProviderId;
  operationId: string;
  actorId: string;
  sourceAccountId: string;
  targetAccountId: string;
  expectedBindingRevision: number;
}

/** The SQL operation id reconciles a crash between the global commit and local progress write. */
export class SessionProviderBindingStore {
  constructor(private readonly db: SqlDatabase) {}
  /** SQL receipts form an outbox; local event insertion must deduplicate before delivery is marked. */
  async deliverEvents(
    sessionId: string,
    append: (event: {
      type: "provider_account_changed";
      operationId: string;
      provider: SubscriptionProviderId;
      sourceAccountId: string;
      targetAccountId: string;
      bindingRevision: number;
      actorId: string;
      timestamp: number;
    }) => void
  ): Promise<void> {
    const receipts = await this.db
      .prepare(
        `SELECT operation_id AS operationId, provider,
      source_account_id AS sourceAccountId, target_account_id AS targetAccountId,
      binding_revision AS bindingRevision, actor_id AS actorId, created_at AS timestamp
      FROM session_provider_account_switches WHERE session_id = ? AND event_delivered_at IS NULL
      ORDER BY created_at, binding_revision LIMIT 100`
      )
      .bind(sessionId)
      .all<{
        operationId: string;
        provider: SubscriptionProviderId;
        sourceAccountId: string;
        targetAccountId: string;
        bindingRevision: number;
        actorId: string;
        timestamp: number;
      }>();
    for (const receipt of receipts.results) {
      append({ type: "provider_account_changed", ...receipt });
      await this.db
        .prepare(
          "UPDATE session_provider_account_switches SET event_delivered_at = ? WHERE session_id = ? AND operation_id = ? AND event_delivered_at IS NULL"
        )
        .bind(Date.now(), sessionId, receipt.operationId)
        .run();
    }
  }
  async commit(input: BindingSwitch, now = Date.now()) {
    const prior = await this.db
      .prepare(
        `SELECT provider, source_account_id, target_account_id, binding_revision, actor_id
      FROM session_provider_account_switches WHERE session_id = ? AND operation_id = ?`
      )
      .bind(input.sessionId, input.operationId)
      .first<{
        provider: string;
        source_account_id: string;
        target_account_id: string;
        binding_revision: number;
        actor_id: string;
      }>();
    if (prior) {
      if (
        prior.provider !== input.provider ||
        prior.source_account_id !== input.sourceAccountId ||
        prior.target_account_id !== input.targetAccountId ||
        prior.binding_revision !== input.expectedBindingRevision + 1 ||
        prior.actor_id !== input.actorId
      )
        throw new Error("provider_switch_operation_conflict");
      return new SessionIndexStore(this.db).getProviderAuthForProvider(
        input.sessionId,
        input.provider
      );
    }
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE session_model_provider_auth SET provider_account_id = ?, binding_revision = binding_revision + 1,
        last_switch_operation_id = ?, updated_by = ?, updated_at = ?
        WHERE session_id = ? AND provider = ? AND auth_mode = 'provider_account' AND provider_account_id = ? AND binding_revision = ?
        AND EXISTS (SELECT 1 FROM model_provider_accounts WHERE id = ? AND provider = ? AND status = 'active' AND archived_at IS NULL)
        AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND status NOT IN ('archived', 'cancelled'))`
        )
        .bind(
          input.targetAccountId,
          input.operationId,
          input.actorId,
          now,
          input.sessionId,
          input.provider,
          input.sourceAccountId,
          input.expectedBindingRevision,
          input.targetAccountId,
          input.provider,
          input.sessionId
        ),
      this.db
        .prepare(
          `INSERT INTO session_provider_account_switches
        (session_id, operation_id, provider, source_account_id, target_account_id, binding_revision, actor_id, created_at)
        SELECT session_id, last_switch_operation_id, provider, ?, provider_account_id, binding_revision, ?, ?
        FROM session_model_provider_auth WHERE session_id = ? AND provider = ? AND last_switch_operation_id = ? AND binding_revision = ?
        ON CONFLICT(session_id, operation_id) DO NOTHING`
        )
        .bind(
          input.sourceAccountId,
          input.actorId,
          now,
          input.sessionId,
          input.provider,
          input.operationId,
          input.expectedBindingRevision + 1
        ),
    ]);
    if (!results[0].meta.changes) throw new Error("stale_provider_binding");
    return new SessionIndexStore(this.db).getProviderAuthForProvider(
      input.sessionId,
      input.provider
    );
  }
}

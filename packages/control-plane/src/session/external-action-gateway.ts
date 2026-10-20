import type { JsonValue } from "@earendil-works/chord";
import type {
  ExternalAction,
  ExternalActionApproval,
  ExternalActionHistoryEvent,
  ExternalActionPendingList,
  ExternalActionPrepareRequest,
  ExternalActionStatusResponse,
} from "@open-inspect/shared";
import type { SqlStorage, TransactionSync } from "./sql-storage";

const EXECUTION_LEASE_MS = 30_000;
const RECONCILIATION_POLL_MS = 5_000;
const MAX_RECONCILIATION_BACKOFF_MS = 60_000;
/** Audit actor for a decision the system made on its own. */
const EXTERNAL_ACTION_EXPIRY_SERVICE = "external-action-expiry";
/**
 * How long a pending approval stays actionable.
 *
 * A publication request nobody acted on must not remain publishable a day
 * later, after the conversation has moved on. The window is bounded by the
 * gateway so every provider shares the same expiry rule.
 */
export const DEFAULT_EXTERNAL_ACTION_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

interface PendingRow {
  id: string;
  provider: string;
  action: string;
  summary: string;
  state: ExternalAction["state"];
  target_json: string;
  arguments_json: string;
  approval_source: string | null;
  approval_actor_id: string | null;
  approval_grant_id: string | null;
  approved_at: number | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
}

interface PendingCursor {
  createdAt: number;
  id: string;
}

/** Encode a pending-list cursor as an opaque, bounded token. */
function encodePendingCursor(cursor: PendingCursor): string {
  return btoa(`${cursor.createdAt}:${cursor.id}`);
}

/** Decode a pending-list cursor, refusing anything malformed. */
function decodePendingCursor(value: string | null | undefined): PendingCursor | null {
  if (!value) return null;
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    return null;
  }
  const separator = decoded.indexOf(":");
  if (separator <= 0) return null;
  const createdAt = Number(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0 || id.length === 0) return null;
  return { createdAt, id };
}

/** Parse a stored JSON object column, refusing anything that is not an object. */
function parseJsonObject(value: string): Record<string, JsonValue> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("External action document is not an object");
  }
  return parsed as Record<string, JsonValue>;
}

export type ExternalActionExecutionResult =
  | { kind: "succeeded"; publicResult: JsonValue }
  | { kind: "accepted"; providerReference: string }
  | { kind: "rejected"; error: string };

export type ExternalActionProviderStatus =
  | { kind: "succeeded"; publicResult: JsonValue }
  | { kind: "failed"; error: string }
  | { kind: "pending"; providerReference?: string }
  | { kind: "not_admitted" }
  | { kind: "unknown"; reason?: string };

export interface ExternalActionExecutor {
  execute(action: ExternalAction): Promise<ExternalActionExecutionResult>;
  status(action: ExternalAction): Promise<ExternalActionProviderStatus>;
}

interface ApprovalInput {
  source: ExternalActionApproval["source"];
  actorId: string;
  grantId: string | null;
  requestId?: string;
}

interface PrepareOptions {
  /**
   * Absolute time at which a pending approval stops being actionable.
   * Null means the approval does not expire on its own.
   */
  expiresAt?: number | null;
}

interface GatewayOptions {
  now?: () => number;
  generateId?: () => string;
  generateLeaseToken?: () => string;
}

interface ExternalActionRow {
  id: string;
  session_id: string;
  operation_id: string;
  tool_call_id: string;
  idempotency_key: string;
  provider: string;
  action: string;
  summary: string;
  target_json: string;
  arguments_json: string;
  fingerprint: string;
  effect_fingerprint: string;
  state: ExternalAction["state"];
  approval_source: ExternalActionApproval["source"] | null;
  approval_actor_id: string | null;
  approval_grant_id: string | null;
  approved_at: number | null;
  continuation_consumed_at: number | null;
  provider_reference: string | null;
  public_result_json: string | null;
  error: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  reconciliation_attempts: number;
  reconcile_after: number | null;
  revision: number;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
}

interface HistoryRow {
  revision: number;
  state: ExternalAction["state"];
  event: ExternalActionHistoryEvent["event"];
  actor_kind: ExternalActionHistoryEvent["actorKind"];
  actor_id: string | null;
  reason: string | null;
  occurred_at: number;
}

interface BindingRow {
  idempotency_key: string;
  action_id: string;
  operation_id: string;
  tool_call_id: string;
  fingerprint: string;
  created_at: number;
}

interface Transition {
  state: ExternalAction["state"];
  event: ExternalActionHistoryEvent["event"];
  actorKind: ExternalActionHistoryEvent["actorKind"];
  actorId?: string | null;
  reason?: string | null;
  providerReference?: string | null;
  publicResult?: JsonValue | null;
  error?: string | null;
  leaseToken?: string | null;
  leaseExpiresAt?: number | null;
  continuationConsumedAt?: number | null;
  reconciliationAttempts?: number;
  reconcileAfter?: number | null;
}

/** SessionDO-owned approval and exactly-once dispatch gateway for external effects. */
export class ExternalActionGateway {
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly generateLeaseToken: () => string;

  constructor(
    private readonly sql: SqlStorage,
    private readonly transaction: TransactionSync,
    options: GatewayOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? (() => crypto.randomUUID());
    this.generateLeaseToken = options.generateLeaseToken ?? (() => crypto.randomUUID());
  }

  async prepare(
    sessionId: string,
    operationId: string,
    request: ExternalActionPrepareRequest,
    approval?: ApprovalInput,
    options: PrepareOptions = {}
  ): Promise<ExternalAction> {
    const fingerprint = await actionFingerprint(sessionId, operationId, request);
    const effectFingerprint = await externalEffectFingerprint(request);
    const existing = this.bindingByIdempotencyKey(request.idempotencyKey);
    if (existing) {
      if (existing.binding.fingerprint !== fingerprint) {
        throw new Error("External action idempotency key was reused with different input");
      }
      return toAction(existing.action);
    }
    const now = this.now();
    const id = this.generateId();
    return this.transaction(() => {
      const raced = this.bindingByIdempotencyKey(request.idempotencyKey);
      if (raced) {
        if (raced.binding.fingerprint !== fingerprint) {
          throw new Error("External action idempotency key was reused with different input");
        }
        return toAction(raced.action);
      }
      const reusable = this.reusableAction(sessionId, effectFingerprint);
      if (reusable) {
        // The one-shot continuation is only consumed by an approval that is
        // about to run. A pending, running, or indeterminate effect is joined
        // as-is so one effect never becomes two provider writes.
        if (reusable.state === "approved" && reusable.continuation_consumed_at === null) {
          this.sql.exec(
            `UPDATE external_actions SET continuation_consumed_at = ?, updated_at = ?
             WHERE id = ? AND state = 'approved' AND continuation_consumed_at IS NULL`,
            now,
            now,
            reusable.id
          );
        }
        this.insertBinding(reusable.id, operationId, request, fingerprint, now);
        return this.requireAction(reusable.id);
      }
      this.sql.exec(
        `INSERT INTO external_actions (
          id, session_id, operation_id, tool_call_id, idempotency_key, provider, action, summary,
          target_json, arguments_json, fingerprint, effect_fingerprint, state, revision, created_at, updated_at,
          expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', 1, ?, ?, ?)`,
        id,
        sessionId,
        operationId,
        request.toolCallId,
        request.idempotencyKey,
        request.provider,
        request.action,
        request.summary,
        JSON.stringify(request.target),
        JSON.stringify(request.arguments),
        fingerprint,
        effectFingerprint,
        now,
        now,
        options.expiresAt ?? null
      );
      this.insertBinding(id, operationId, request, fingerprint, now);
      this.insertHistory(id, 1, {
        state: "awaiting_approval",
        event: "prepared",
        actorKind: "pi",
        actorId: operationId,
      });
      if (approval) return this.approveInTransaction(id, approval);
      return this.requireAction(id);
    });
  }

  approve(id: string, approval: ApprovalInput): ExternalAction {
    return this.transaction(() => this.approveInTransaction(id, approval));
  }

  deny(id: string, actorId: string, reason: string, requestId?: string): ExternalAction {
    return this.transaction(() => {
      const current = this.requireAction(id);
      if (current.state === "denied") return current;
      if (current.state !== "awaiting_approval") {
        throw new Error(`External action cannot be denied from ${current.state}`);
      }
      const after = this.transition(id, current.revision, {
        state: "denied",
        event: "denied",
        actorKind: "user",
        actorId,
        reason,
        error: reason,
      });
      this.enqueueAudit(
        after,
        requestId ?? `external-action:${id}:denied`,
        { kind: "user", userId: actorId },
        "external_action.denied",
        current.state
      );
      return after;
    });
  }

  /**
   * Cancel an effect that has not produced its provider effect yet.
   *
   * Cancellation is distinct from denial: it is the safe response to an
   * effect that is no longer wanted, including one that was already
   * approved but has not been dispatched. An effect that is already
   * executing or indeterminate cannot be cancelled, because the provider may
   * already have applied it; that case must be reconciled instead.
   */
  cancel(id: string, actorId: string, reason: string, requestId?: string): ExternalAction {
    return this.transaction(() => {
      const current = this.requireAction(id);
      if (current.state === "cancelled") return current;
      if (current.state !== "awaiting_approval" && current.state !== "approved") {
        throw new Error(`External action cannot be cancelled from ${current.state}`);
      }
      const after = this.transition(id, current.revision, {
        state: "cancelled",
        event: "cancelled",
        actorKind: "user",
        actorId,
        reason,
        error: reason,
      });
      this.enqueueAudit(
        after,
        requestId ?? `external-action:${id}:cancelled`,
        { kind: "user", userId: actorId },
        "external_action.cancelled",
        current.state
      );
      return after;
    });
  }

  /**
   * The next time a pending approval expires.
   *
   * The alarm schedules against this so an approval nobody acted on is
   * cancelled on time instead of waiting for an unrelated wake-up.
   */
  nextExpiryAt(): number | null {
    const row = this.sql
      .exec(
        `SELECT MIN(expires_at) AS deadline FROM external_actions
         WHERE state IN ('awaiting_approval', 'approved') AND expires_at IS NOT NULL`
      )
      .toArray()[0] as { deadline: number | null } | undefined;
    return row?.deadline ?? null;
  }

  /**
   * Expire pending approvals whose deadline has passed.
   *
   * An approval that nobody acted on must not stay actionable forever: a
   * later approver could otherwise publish an effect the session has moved
   * on from. Expiry is a cancellation, so it lands in the same terminal state
   * and produces the same audit trail.
   */
  expireDue(sessionId: string): ExternalAction[] {
    const now = this.now();
    return this.transaction(() => {
      const rows = this.sql
        .exec(
          `SELECT id FROM external_actions
           WHERE session_id = ?
             AND state IN ('awaiting_approval', 'approved')
             AND expires_at IS NOT NULL AND expires_at <= ?
           ORDER BY expires_at, id`,
          sessionId,
          now
        )
        .toArray() as unknown as Array<{ id: string }>;
      const expired: ExternalAction[] = [];
      for (const row of rows) {
        const current = this.requireAction(row.id);
        const after = this.transition(row.id, current.revision, {
          state: "cancelled",
          event: "cancelled",
          actorKind: "system",
          reason: "The approval request expired before it was decided",
          error: "The approval request expired before it was decided",
        });
        this.enqueueAudit(
          after,
          `external-action:${row.id}:expired`,
          { kind: "service", service: EXTERNAL_ACTION_EXPIRY_SERVICE },
          "external_action.cancelled",
          current.state
        );
        expired.push(after);
      }
      return expired;
    });
  }

  status(id: string): ExternalActionStatusResponse {
    const action = this.requireAction(id);
    const rows = this.sql
      .exec(
        `SELECT revision, state, event, actor_kind, actor_id, reason, occurred_at
         FROM external_action_history WHERE action_id = ? ORDER BY revision`,
        id
      )
      .toArray() as unknown as HistoryRow[];
    return {
      action,
      history: rows.map((row) => ({
        revision: row.revision,
        state: row.state,
        event: row.event,
        actorKind: row.actor_kind,
        actorId: row.actor_id,
        reason: row.reason,
        occurredAt: row.occurred_at,
      })),
    };
  }

  /**
   * List the external effects an approver can still act on.
   *
   * The page is cursor bounded and oldest first, so an approver sees the
   * longest-waiting effect first and a large ledger cannot be drained in one
   * request.
   */
  listPending(
    sessionId: string,
    options: { limit?: number; cursor?: string | null } = {}
  ): ExternalActionPendingList {
    const limit = Math.max(1, Math.min(options.limit ?? 25, 100));
    const cursor = decodePendingCursor(options.cursor);
    const rows = this.sql
      .exec(
        `SELECT id, provider, action, summary, state, target_json, arguments_json,
                approval_source, approval_actor_id, approval_grant_id, approved_at,
                created_at, updated_at, expires_at
         FROM external_actions
         WHERE session_id = ?
           AND state IN ('awaiting_approval', 'approved', 'executing', 'indeterminate')
           AND (created_at > ? OR (created_at = ? AND id > ?))
         ORDER BY created_at, id
         LIMIT ?`,
        sessionId,
        cursor?.createdAt ?? 0,
        cursor?.createdAt ?? 0,
        cursor?.id ?? "",
        limit + 1
      )
      .toArray() as unknown as PendingRow[];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      actions: page.map((row) => ({
        id: row.id,
        provider: row.provider,
        action: row.action,
        summary: row.summary,
        state: row.state,
        target: parseJsonObject(row.target_json),
        arguments: parseJsonObject(row.arguments_json),
        approval:
          row.approval_source === null
            ? null
            : {
                source: row.approval_source as "human" | "automation_grant",
                actorId: row.approval_actor_id ?? "",
                grantId: row.approval_grant_id ?? null,
                approvedAt: row.approved_at ?? 0,
              },
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        expiresAt: row.expires_at ?? null,
      })),
      nextCursor:
        rows.length > limit && last
          ? encodePendingCursor({ createdAt: last.created_at, id: last.id })
          : null,
    };
  }

  isBoundToOperation(id: string, operationId: string): boolean {
    return (
      this.sql
        .exec(
          "SELECT action_id FROM external_action_bindings WHERE action_id = ? AND operation_id = ? LIMIT 1",
          id,
          operationId
        )
        .toArray().length > 0
    );
  }

  async execute(id: string, executor: ExternalActionExecutor): Promise<ExternalAction> {
    const claim = this.claimExecution(id);
    if (!claim.claimed) {
      if (claim.action.state === "awaiting_approval") {
        throw new Error("External action is not approved");
      }
      return claim.action;
    }
    try {
      const result = await executor.execute(claim.action);
      return this.transaction(() => {
        const current = this.requireAction(id);
        if (current.state !== "executing" || current.revision !== claim.action.revision)
          return current;
        if (result.kind === "succeeded") {
          return this.transition(id, current.revision, {
            state: "succeeded",
            event: "execution_succeeded",
            actorKind: "executor",
            publicResult: result.publicResult,
            leaseToken: null,
            leaseExpiresAt: null,
            reconciliationAttempts: 0,
            reconcileAfter: null,
          });
        }
        if (result.kind === "accepted") {
          return this.transition(id, current.revision, {
            state: "executing",
            event: "execution_accepted",
            actorKind: "executor",
            providerReference: result.providerReference,
            leaseToken: null,
            leaseExpiresAt: null,
            reconciliationAttempts: 0,
            reconcileAfter: this.now() + RECONCILIATION_POLL_MS,
          });
        }
        return this.transition(id, current.revision, {
          state: "failed",
          event: "execution_failed",
          actorKind: "executor",
          error: result.error,
          reason: result.error,
          leaseToken: null,
          leaseExpiresAt: null,
          reconciliationAttempts: 0,
          reconcileAfter: null,
        });
      });
    } catch (error) {
      return this.transaction(() => {
        const current = this.requireAction(id);
        if (current.state !== "executing" || current.revision !== claim.action.revision)
          return current;
        const reason = error instanceof Error ? error.message : "External action dispatch failed";
        return this.transition(id, current.revision, {
          state: "indeterminate",
          event: "execution_indeterminate",
          actorKind: "system",
          reason,
          error: reason,
          leaseToken: null,
          leaseExpiresAt: null,
          reconciliationAttempts: 0,
          reconcileAfter: this.now() + RECONCILIATION_POLL_MS,
        });
      });
    }
  }

  async reconcile(id: string, executor: ExternalActionExecutor): Promise<ExternalAction> {
    const current = this.requireAction(id);
    if (current.state !== "executing" && current.state !== "indeterminate") return current;
    const row = this.requireRow(id);
    if (row.lease_expires_at !== null && row.lease_expires_at > this.now()) return current;
    let result: ExternalActionProviderStatus;
    try {
      result = await executor.status(current);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "External action status failed";
      return this.deferReconciliation(id, current, reason, "system");
    }
    if (result.kind === "unknown") {
      return this.deferReconciliation(
        id,
        current,
        result.reason ?? "Provider status is unknown",
        "executor"
      );
    }
    return this.transaction(() => {
      const latest = this.requireAction(id);
      if (latest.revision !== current.revision) return latest;
      if (result.kind === "succeeded") {
        return this.transition(id, latest.revision, {
          state: "succeeded",
          event: "execution_succeeded",
          actorKind: "executor",
          publicResult: result.publicResult,
          error: null,
          leaseToken: null,
          leaseExpiresAt: null,
          reconciliationAttempts: 0,
          reconcileAfter: null,
        });
      }
      if (result.kind === "failed") {
        return this.transition(id, latest.revision, {
          state: "failed",
          event: "execution_failed",
          actorKind: "executor",
          reason: result.error,
          error: result.error,
          leaseToken: null,
          leaseExpiresAt: null,
          reconciliationAttempts: 0,
          reconcileAfter: null,
        });
      }
      if (result.kind === "not_admitted") {
        // The provider definitively refused the effect, so nothing happened.
        // The effect returns to `approved` and its one-shot continuation is
        // re-armed: the approval that authorized it is still valid, and a
        // later identical attempt must be able to use it again.
        return this.transition(id, latest.revision, {
          state: "approved",
          event: "reconciliation_not_admitted",
          actorKind: "executor",
          error: null,
          leaseToken: null,
          leaseExpiresAt: null,
          continuationConsumedAt: null,
          reconciliationAttempts: 0,
          reconcileAfter: null,
        });
      }
      if (result.kind === "pending") {
        const row = this.requireRow(id);
        const attempts = row.reconciliation_attempts + 1;
        return this.transition(id, latest.revision, {
          state: "executing",
          event: "reconciliation_pending",
          actorKind: "executor",
          providerReference: result.providerReference ?? latest.providerReference,
          error: null,
          leaseToken: null,
          leaseExpiresAt: null,
          reconciliationAttempts: attempts,
          reconcileAfter: this.now() + reconciliationBackoffMs(attempts),
        });
      }
      return latest;
    });
  }

  nextReconciliationAt(): number | null {
    const row = this.sql
      .exec(
        `SELECT MIN(
           CASE
             WHEN reconcile_after IS NOT NULL THEN reconcile_after
             WHEN state = 'executing' AND lease_expires_at IS NOT NULL THEN lease_expires_at
             ELSE updated_at + ?
           END
         ) AS deadline
         FROM external_actions WHERE state IN ('executing', 'indeterminate')`,
        RECONCILIATION_POLL_MS
      )
      .toArray()[0] as { deadline: number | null } | undefined;
    return row?.deadline ?? null;
  }

  async reconcileDue(
    resolveExecutor: (action: ExternalAction) => ExternalActionExecutor | undefined
  ): Promise<void> {
    const now = this.now();
    const rows = this.sql
      .exec(
        `SELECT id, provider FROM external_actions
         WHERE state IN ('executing', 'indeterminate')
           AND (CASE
             WHEN reconcile_after IS NOT NULL THEN reconcile_after
             WHEN state = 'executing' AND lease_expires_at IS NOT NULL THEN lease_expires_at
             ELSE updated_at + ?
           END) <= ?
         ORDER BY updated_at, id`,
        RECONCILIATION_POLL_MS,
        now
      )
      .toArray() as unknown as Array<{ id: string; provider: string }>;
    for (const row of rows) {
      const action = this.requireAction(row.id);
      const executor = resolveExecutor(action);
      if (executor) {
        await this.reconcile(row.id, executor);
      } else {
        this.deferReconciliation(
          row.id,
          action,
          "External action provider definition is unavailable",
          "system"
        );
      }
    }
  }

  private approveInTransaction(id: string, approval: ApprovalInput): ExternalAction {
    const current = this.requireAction(id);
    if (current.state === "approved") return current;
    if (current.state !== "awaiting_approval") {
      throw new Error(`External action cannot be approved from ${current.state}`);
    }
    // Provenance must be unambiguous before anything is written. A human
    // approval that carries a grant, or an automation approval that carries
    // none, would make the ledger unable to say who authorized the effect.
    if (approval.source === "human" && approval.grantId !== null) {
      throw new Error("A human external action approval cannot carry an automation grant");
    }
    if (approval.source === "automation_grant" && !approval.grantId) {
      throw new Error("An automation external action approval must name its grant");
    }
    if (current.expiresAt !== null && current.expiresAt <= this.now()) {
      throw new Error("External action approval request has expired");
    }
    const now = this.now();
    this.sql.exec(
      `UPDATE external_actions SET approval_source = ?, approval_actor_id = ?, approval_grant_id = ?,
       approved_at = ? WHERE id = ? AND revision = ?`,
      approval.source,
      approval.actorId,
      approval.grantId,
      now,
      id,
      current.revision
    );
    const after = this.transition(id, current.revision, {
      state: "approved",
      event: "approved",
      actorKind: approval.source === "human" ? "user" : "automation",
      actorId: approval.actorId,
    });
    if (approval.source === "human") {
      this.enqueueAudit(
        after,
        approval.requestId ?? `external-action:${id}:approved`,
        { kind: "user", userId: approval.actorId },
        "external_action.approved",
        current.state
      );
    }
    return after;
  }

  private claimExecution(id: string): { action: ExternalAction; claimed: boolean } {
    return this.transaction(() => {
      const row = this.requireRow(id);
      const current = toAction(row);
      if (current.state === "executing" && row.lease_expires_at !== null) {
        if (row.lease_expires_at > this.now()) return { action: current, claimed: false };
        return {
          action: this.transition(id, current.revision, {
            state: "indeterminate",
            event: "execution_indeterminate",
            actorKind: "system",
            reason: "Execution lease expired before dispatch was recorded",
            error: "Execution outcome requires reconciliation",
            leaseToken: null,
            leaseExpiresAt: null,
            reconciliationAttempts: row.reconciliation_attempts,
            reconcileAfter: null,
          }),
          claimed: false,
        };
      }
      if (current.state !== "approved") return { action: current, claimed: false };
      const token = this.generateLeaseToken();
      return {
        action: this.transition(id, current.revision, {
          state: "executing",
          event: "execution_claimed",
          actorKind: "system",
          actorId: token,
          leaseToken: token,
          leaseExpiresAt: this.now() + EXECUTION_LEASE_MS,
          reconciliationAttempts: 0,
          reconcileAfter: null,
        }),
        claimed: true,
      };
    });
  }

  private transition(id: string, expectedRevision: number, transition: Transition): ExternalAction {
    const nextRevision = expectedRevision + 1;
    const now = this.now();
    const row = this.requireRow(id);
    const providerReference =
      transition.providerReference === undefined
        ? row.provider_reference
        : transition.providerReference;
    const publicResultJson =
      transition.publicResult === undefined
        ? row.public_result_json
        : transition.publicResult === null
          ? null
          : JSON.stringify(transition.publicResult);
    const error = transition.error === undefined ? row.error : transition.error;
    const leaseToken =
      transition.leaseToken === undefined ? row.lease_token : transition.leaseToken;
    const leaseExpiresAt =
      transition.leaseExpiresAt === undefined ? row.lease_expires_at : transition.leaseExpiresAt;
    const reconciliationAttempts =
      transition.reconciliationAttempts === undefined
        ? row.reconciliation_attempts
        : transition.reconciliationAttempts;
    const reconcileAfter =
      transition.reconcileAfter === undefined ? row.reconcile_after : transition.reconcileAfter;
    const continuationConsumedAt =
      transition.continuationConsumedAt === undefined
        ? row.continuation_consumed_at
        : transition.continuationConsumedAt;
    const result = this.sql.exec(
      `UPDATE external_actions SET state = ?, provider_reference = ?, public_result_json = ?, error = ?,
       lease_token = ?, lease_expires_at = ?, reconciliation_attempts = ?, reconcile_after = ?,
       continuation_consumed_at = ?, revision = ?, updated_at = ?
       WHERE id = ? AND revision = ?`,
      transition.state,
      providerReference,
      publicResultJson,
      error,
      leaseToken,
      leaseExpiresAt,
      reconciliationAttempts,
      reconcileAfter,
      continuationConsumedAt,
      nextRevision,
      now,
      id,
      expectedRevision
    );
    if ((result.rowsWritten ?? 1) === 0) throw new Error("External action changed concurrently");
    this.insertHistory(id, nextRevision, transition);
    return this.requireAction(id);
  }

  private insertHistory(id: string, revision: number, transition: Transition): void {
    this.sql.exec(
      `INSERT INTO external_action_history
       (action_id, revision, state, event, actor_kind, actor_id, reason, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      revision,
      transition.state,
      transition.event,
      transition.actorKind,
      transition.actorId ?? null,
      transition.reason ?? null,
      this.now()
    );
  }

  private requireAction(id: string): ExternalAction {
    return toAction(this.requireRow(id));
  }

  private requireRow(id: string): ExternalActionRow {
    const row = this.sql.exec("SELECT * FROM external_actions WHERE id = ?", id).toArray()[0];
    if (!row) throw new Error("External action not found");
    return row as ExternalActionRow;
  }

  private bindingByIdempotencyKey(
    key: string
  ): { binding: BindingRow; action: ExternalActionRow } | null {
    const binding = (this.sql
      .exec("SELECT * FROM external_action_bindings WHERE idempotency_key = ?", key)
      .toArray()[0] ?? null) as BindingRow | null;
    return binding ? { binding, action: this.requireRow(binding.action_id) } : null;
  }

  /**
   * Find an existing effect this request may join.
   *
   * An identical effect that is still waiting for approval, already approved,
   * running, or indeterminate is the same publication, so it must not become
   * a second approval card or a second provider write. Only a terminal
   * effect, or an approval whose one-shot continuation was already consumed,
   * starts a new ledger entry.
   *
   * The search is scoped to one session: two sessions never share an effect,
   * even when they describe the same publication.
   */
  private reusableAction(sessionId: string, effectFingerprint: string): ExternalActionRow | null {
    return (this.sql
      .exec(
        `SELECT * FROM external_actions
         WHERE session_id = ?
           AND effect_fingerprint = ?
           AND state IN ('awaiting_approval', 'executing', 'indeterminate')
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        sessionId,
        effectFingerprint
      )
      .toArray()[0] ??
      this.sql
        .exec(
          `SELECT * FROM external_actions
           WHERE session_id = ?
             AND effect_fingerprint = ?
             AND state = 'approved' AND continuation_consumed_at IS NULL
           ORDER BY created_at DESC, id DESC LIMIT 1`,
          sessionId,
          effectFingerprint
        )
        .toArray()[0] ??
      null) as ExternalActionRow | null;
  }

  private insertBinding(
    actionId: string,
    operationId: string,
    request: ExternalActionPrepareRequest,
    fingerprint: string,
    now: number
  ): void {
    this.sql.exec(
      `INSERT INTO external_action_bindings
       (idempotency_key, action_id, operation_id, tool_call_id, fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      request.idempotencyKey,
      actionId,
      operationId,
      request.toolCallId,
      fingerprint,
      now
    );
  }

  private enqueueAudit(
    action: ExternalAction,
    requestId: string,
    actor: { kind: "user"; userId: string } | { kind: "service"; service: string },
    auditAction:
      "external_action.approved" | "external_action.denied" | "external_action.cancelled",
    beforeState: ExternalAction["state"]
  ): void {
    this.sql.exec(
      `INSERT INTO external_action_audit_outbox
       (id, action_id, revision, request_id, actor_user_id, actor_kind, action, session_id,
        before_state, after_state, next_attempt_at, created_at, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      `external-action-audit:${action.id}:${action.revision}:${auditAction}`,
      action.id,
      action.revision,
      requestId,
      actor.kind === "user" ? actor.userId : actor.service,
      actor.kind,
      auditAction,
      action.sessionId,
      beforeState,
      action.state,
      this.now(),
      this.now(),
      // The audit event records when the decision happened, not when the
      // projection later managed to flush it.
      action.updatedAt
    );
  }

  private deferReconciliation(
    id: string,
    current: ExternalAction,
    reason: string,
    actorKind: "executor" | "system"
  ): ExternalAction {
    return this.transaction(() => {
      const latest = this.requireAction(id);
      if (latest.revision !== current.revision) return latest;
      const row = this.requireRow(id);
      const attempts = row.reconciliation_attempts + 1;
      return this.transition(id, latest.revision, {
        state: "indeterminate",
        event: "reconciliation_pending",
        actorKind,
        reason,
        error: reason,
        leaseToken: null,
        leaseExpiresAt: null,
        reconciliationAttempts: attempts,
        reconcileAfter: this.now() + reconciliationBackoffMs(attempts),
      });
    });
  }
}

function toAction(row: ExternalActionRow): ExternalAction {
  return {
    id: row.id,
    sessionId: row.session_id,
    operationId: row.operation_id,
    toolCallId: row.tool_call_id,
    idempotencyKey: row.idempotency_key,
    provider: row.provider,
    action: row.action,
    summary: row.summary,
    target: JSON.parse(row.target_json) as Record<string, JsonValue>,
    arguments: JSON.parse(row.arguments_json) as Record<string, JsonValue>,
    fingerprint: row.fingerprint,
    state: row.state,
    approval:
      row.approval_source && row.approval_actor_id && row.approved_at !== null
        ? {
            source: row.approval_source,
            actorId: row.approval_actor_id,
            grantId: row.approval_grant_id,
            approvedAt: row.approved_at,
          }
        : null,
    providerReference: row.provider_reference,
    publicResult:
      row.public_result_json === null ? null : (JSON.parse(row.public_result_json) as JsonValue),
    error: row.error,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at ?? null,
  };
}

async function actionFingerprint(
  sessionId: string,
  operationId: string,
  request: ExternalActionPrepareRequest
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson({ sessionId, operationId, ...request }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
}

async function externalEffectFingerprint(request: ExternalActionPrepareRequest): Promise<string> {
  const bytes = new TextEncoder().encode(
    canonicalJson({
      provider: request.provider,
      action: request.action,
      target: request.target,
      arguments: request.arguments,
    })
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function reconciliationBackoffMs(attempts: number): number {
  return Math.min(
    MAX_RECONCILIATION_BACKOFF_MS,
    RECONCILIATION_POLL_MS * 2 ** Math.min(Math.max(0, attempts - 1), 4)
  );
}

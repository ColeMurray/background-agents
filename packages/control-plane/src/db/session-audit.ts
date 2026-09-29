import type { SqlDatabase, SqlStatement } from "./sql-database";

export type SessionAuditAction =
  | "session.visibility_changed"
  | "session.moved"
  | "session.collaborator_added"
  | "session.collaborator_removed"
  | "session.created_private";

export interface SessionAuditInput {
  requestId: string;
  actorUserId: string;
  action: SessionAuditAction;
  sessionId: string;
  teamId: string | null;
  targetUserId?: string | null;
  before: unknown;
  after: unknown;
}

export class SessionAuditStore {
  constructor(private readonly db: SqlDatabase) {}

  bind(input: SessionAuditInput, onlyIfPreviousChanged = false): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO authorization_audit_events
        (id, occurred_at, request_id, principal_kind, actor_user_id_snapshot, action,
         resource_type, resource_id, target_user_id_snapshot, team_id, reason_code,
         operation_result, metadata_json)
        SELECT ?, ?, ?, 'user', ?, ?, 'session', ?, ?, ?, ?, 'applied', ?
        ${onlyIfPreviousChanged ? "WHERE changes() = 1" : ""}`
      )
      .bind(
        crypto.randomUUID(),
        Date.now(),
        input.requestId,
        input.actorUserId,
        input.action,
        input.sessionId,
        input.targetUserId ?? null,
        input.teamId,
        input.action,
        JSON.stringify({ before: input.before ?? {}, requested: {}, after: input.after ?? {} })
      );
  }

  async write(input: SessionAuditInput): Promise<void> {
    await this.bind(input).run();
  }
}

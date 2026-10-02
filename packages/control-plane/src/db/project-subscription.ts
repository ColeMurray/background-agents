import type { SqlDatabase } from "./sql-database";
import { projectAccessPredicate, activePermissionPredicate } from "./project-access-sql";
import type { ProjectActor } from "./project-store";

/**
 * An operation receipt and commit-time authorization fence in the same batch as
 * every automation mutation. A revoked grant produces a NOT NULL violation on
 * action, rolling the entire batch back (including target/provider replacements).
 * D1 has no interactive transaction API; a zero-row UPDATE alone cannot do this.
 */
export function projectSubscriptionReceipt(
  db: SqlDatabase,
  actor: ProjectActor,
  automationId: string,
  projectId: string | null,
  previousProjectId: string | null,
  executorUserId: string,
  creating = false
) {
  const actorRead = projectAccessPredicate(actor.userId, "read");
  const executorRead = projectAccessPredicate(executorUserId, "read");
  const create = activePermissionPredicate(actor.userId, ["automations.create"]);
  const any = activePermissionPredicate(actor.userId, ["automations.manage.any"]);
  const own = activePermissionPredicate(actor.userId, ["automations.manage.own"]);
  const canManage = creating
    ? create
    : {
        sql: `(${any.sql} OR ((a.user_id = ? OR EXISTS(SELECT 1 FROM team_memberships tm WHERE tm.team_id = a.owner_team_id AND tm.user_id = ? AND tm.role = 'lead')) AND ${own.sql}))`,
        params: [...any.params, actor.userId, actor.userId, ...own.params],
      };
  const guard = projectId
    ? `EXISTS(SELECT 1 FROM projects p WHERE p.id = ? AND p.owner_team_id IS a.owner_team_id AND ${actorRead.sql} AND ${executorRead.sql})`
    : "1 = 1";
  const guardParams = projectId ? [projectId, ...actorRead.params, ...executorRead.params] : [];
  return db
    .prepare(
      `INSERT INTO authorization_audit_events
 (id,occurred_at,request_id,principal_kind,actor_user_id_snapshot,action,resource_type,resource_id,team_id,reason_code,operation_result,metadata_json)
 SELECT ?,?,?,'user',?,CASE WHEN a.deleted_at IS NULL AND a.user_id = ? AND a.project_id IS ? AND ${canManage.sql} AND (a.owner_team_id IS NULL OR EXISTS(SELECT 1 FROM team_memberships tm WHERE tm.team_id=a.owner_team_id AND tm.user_id=?) OR EXISTS(SELECT 1 FROM user_role_assignments ura JOIN roles r ON r.id=ura.role_id WHERE ura.user_id=? AND r.key IN ('owner','administrator'))) AND ${guard} THEN 'project.automation_subscribed' ELSE NULL END,
 'project',?,a.owner_team_id,'project.automation_subscribed','applied',? FROM automations a WHERE a.id = ?`
    )
    .bind(
      crypto.randomUUID(),
      Date.now(),
      actor.requestId,
      actor.userId,
      executorUserId,
      projectId,
      ...canManage.params,
      actor.userId,
      actor.userId,
      ...guardParams,
      projectId ?? previousProjectId,
      JSON.stringify({
        before: { projectId: previousProjectId },
        requested: { automationId, projectId },
        after: { automationId, projectId },
      }),
      automationId
    );
}

export function isProjectSubscriptionConflict(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    (cause.message.includes("NOT NULL constraint failed: authorization_audit_events.action") ||
      isProjectSubscriptionConflict(cause.cause))
  );
}

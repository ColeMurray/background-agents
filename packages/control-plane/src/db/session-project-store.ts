import type { Project } from "@open-inspect/shared/types/projects";
import { projectAccessPredicate, activePermissionPredicate } from "./project-access-sql";
import { projectAudit, type ProjectActor, ProjectWriteConflict } from "./project-store";
import type { SqlDatabase } from "./sql-database";

export class ProjectAssociationError extends ProjectWriteConflict {
  constructor(readonly reason: "not_visible" | "team_mismatch" | "conflict") {
    super();
  }
}

export class SessionProjectStore {
  constructor(private readonly db: SqlDatabase) {}
  async associate(
    sessionId: string,
    project: Project | null,
    includeChildren: boolean,
    actor: ProjectActor
  ): Promise<number> {
    const previous = await this.db
      .prepare(
        "SELECT project_id AS projectId,owner_team_id AS ownerTeamId FROM sessions WHERE id = ?"
      )
      .bind(sessionId)
      .first<{ projectId: string | null; ownerTeamId: string | null }>();
    const active = activePermissionPredicate(actor.userId, ["sessions.read", "sessions.lifecycle"]);
    const projectRead = project ? projectAccessPredicate(actor.userId, "read") : null;
    // UNION terminates even malformed cyclic lineages. No status filter: terminal children move too.
    const tree = `WITH RECURSIVE affected(id) AS (SELECT id FROM sessions WHERE id = ? ${includeChildren ? "UNION SELECT s.id FROM sessions s JOIN affected a ON s.parent_session_id = a.id" : ""})`;
    const eligible = `EXISTS (SELECT 1 FROM users u JOIN user_role_assignments ura ON ura.user_id = u.id JOIN roles r ON r.id = ura.role_id
    WHERE u.id = ? AND u.suspended_at IS NULL
    AND (s.owner_team_id IS NULL OR EXISTS (SELECT 1 FROM team_memberships tm WHERE tm.team_id = s.owner_team_id AND tm.user_id = u.id))
    AND (s.visibility != 'private' OR s.user_id = u.id OR r.key = 'owner' OR EXISTS (
      SELECT 1 FROM session_collaborators sc WHERE sc.session_id = s.id AND sc.user_id = u.id)))`;
    const guard = `EXISTS (SELECT 1 FROM sessions root WHERE root.id = ? AND root.project_id IS ?) AND ${active.sql}
    ${projectRead ? `AND EXISTS (SELECT 1 FROM projects p WHERE p.id = ? AND p.owner_team_id IS ? AND ${projectRead.sql})` : ""}
    AND NOT EXISTS (SELECT 1 FROM sessions s JOIN affected a ON a.id = s.id WHERE NOT (${eligible}) ${project ? "OR s.owner_team_id IS NOT ?" : ""})`;
    const result = await this.db.batch([
      this.db
        .prepare(
          `${tree} UPDATE sessions SET project_id = ? WHERE id IN (SELECT id FROM affected) AND ${guard}`
        )
        .bind(
          sessionId,
          project?.id ?? null,
          sessionId,
          previous?.projectId ?? null,
          ...active.params,
          ...(projectRead ? [project!.id, project!.ownerTeamId, ...projectRead.params] : []),
          actor.userId,
          ...(project ? [project.ownerTeamId] : [])
        ),
      projectAudit(
        this.db,
        actor,
        project ?? {
          id: previous?.projectId ?? sessionId,
          ownerTeamId: previous?.ownerTeamId ?? null,
        },
        "project.session_associated",
        { projectId: previous?.projectId ?? null },
        { sessionId, projectId: project?.id ?? null, includeChildren }
      ),
    ]);
    if (!result[0].meta.changes) {
      // Only classify a rejected write. The committing recursive guard above remains
      // authoritative, including if authorization changes again before this read.
      const failure = await this.db
        .prepare(
          `${tree} SELECT CASE
        WHEN NOT (${active.sql}) OR NOT EXISTS (SELECT 1 FROM affected)
          OR EXISTS (SELECT 1 FROM sessions s JOIN affected a ON a.id=s.id WHERE NOT (${eligible})) THEN 'not_visible'
        ${project ? "WHEN EXISTS (SELECT 1 FROM sessions s JOIN affected a ON a.id=s.id WHERE s.owner_team_id IS NOT ?) THEN 'team_mismatch'" : ""}
        ELSE 'conflict' END AS reason`
        )
        .bind(sessionId, ...active.params, actor.userId, ...(project ? [project.ownerTeamId] : []))
        .first<{ reason: "not_visible" | "team_mismatch" | "conflict" }>();
      throw new ProjectAssociationError(failure?.reason ?? "conflict");
    }
    return result[0].meta.changes;
  }
  async snapshot(sessionId: string) {
    const row = await this.db
      .prepare(
        "SELECT project_id AS projectId, injected_text AS text, injected_bytes AS bytes, manifest_json AS manifestJson FROM session_project_snapshots WHERE session_id = ?"
      )
      .bind(sessionId)
      .first<{ projectId: string; text: string; bytes: number; manifestJson: string }>();
    return row
      ? {
          projectId: row.projectId,
          text: row.text,
          bytes: row.bytes,
          manifest: JSON.parse(row.manifestJson) as unknown,
        }
      : null;
  }
}

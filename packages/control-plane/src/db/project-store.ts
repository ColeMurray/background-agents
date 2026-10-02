import {
  projectSchema,
  type Project,
  type CreateProjectInput,
  type UpdateProjectInput,
  type ProjectSource,
  type ProjectSourceInput,
  type ProjectPin,
  type ProjectPinInput,
} from "@open-inspect/shared/types/projects";
import type { SqlDatabase, SqlStatement } from "./sql-database";
import { activePermissionPredicate, projectAccessPredicate } from "./project-access-sql";

export interface ProjectActor {
  userId: string;
  requestId: string;
}
export class ProjectWriteConflict extends Error {
  constructor() {
    super("Project or authorization changed; refresh and try again");
  }
}
const columns = {
  id: "id",
  slug: "slug",
  name: "name",
  brief: "brief",
  status: "status",
  shippedAt: "shipped_at",
  archivedAt: "archived_at",
  ownerTeamId: "owner_team_id",
  ownerUserId: "owner_user_id",
  defaultEnvironmentId: "default_environment_id",
  defaultRepoOwner: "default_repo_owner",
  defaultRepoName: "default_repo_name",
  defaultAgentProfileId: "default_agent_profile_id",
  linearProjectId: "linear_project_id",
  linearProjectUrl: "linear_project_url",
  primarySlackChannelId: "primary_slack_channel_id",
  statusSummary: "status_summary",
  statusSummarySource: "status_summary_source",
  statusSummarySessionId: "status_summary_session_id",
  statusSummaryUpdatedAt: "status_summary_updated_at",
  createdAt: "created_at",
  updatedAt: "updated_at",
} as const;
const selectProject = Object.entries(columns)
  .map(([field, column]) => `p.${column} AS ${field}`)
  .join(", ");
const sourceColumns = {
  id: "id",
  projectId: "project_id",
  sourceType: "source_type",
  externalIdOrUrl: "external_id_or_url",
  title: "title",
  role: "role",
  refreshPolicy: "refresh_policy",
  provenance: "provenance",
  provenanceSessionId: "provenance_session_id",
  visibility: "visibility",
  position: "position",
  createdBy: "created_by",
  createdAt: "created_at",
  updatedAt: "updated_at",
};
const pinColumns = {
  id: "id",
  projectId: "project_id",
  kind: "kind",
  title: "title",
  body: "body",
  url: "url",
  sessionId: "session_id",
  artifactId: "artifact_id",
  decidedAt: "decided_at",
  position: "position",
  createdBy: "created_by",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

function auditIdentifiers(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).filter(([key]) =>
      ["id", "projectId", "sessionId", "artifactId"].includes(key)
    )
  );
}

export function projectAudit(
  db: SqlDatabase,
  actor: ProjectActor,
  project: Pick<Project, "id" | "ownerTeamId">,
  action: string,
  before: unknown,
  after: unknown
): SqlStatement {
  return db
    .prepare(
      `INSERT INTO authorization_audit_events
    (id, occurred_at, request_id, principal_kind, actor_user_id_snapshot, action, resource_type, resource_id,
     team_id, reason_code, operation_result, metadata_json)
    SELECT ?, ?, ?, 'user', ?, ?, 'project', ?, ?, ?, 'applied', ? WHERE changes() > 0`
    )
    .bind(
      crypto.randomUUID(),
      Date.now(),
      actor.requestId,
      actor.userId,
      action,
      project.id,
      project.ownerTeamId,
      action,
      JSON.stringify({
        before: auditIdentifiers(before),
        requested: auditIdentifiers(after),
        after: auditIdentifiers(after),
        changedFields: [
          ...new Set([
            ...Object.keys((before ?? {}) as object),
            ...Object.keys((after ?? {}) as object),
          ]),
        ].filter(
          (key) =>
            JSON.stringify((before as Record<string, unknown> | null)?.[key]) !==
            JSON.stringify((after as Record<string, unknown> | null)?.[key])
        ),
      })
    );
}

export class ProjectStore {
  constructor(private readonly db: SqlDatabase) {}
  async get(id: string): Promise<Project | null> {
    const row = await this.db
      .prepare(`SELECT ${selectProject} FROM projects p WHERE p.id = ?`)
      .bind(id)
      .first();
    return row ? projectSchema.parse(row) : null;
  }
  async getBySlug(slug: string): Promise<Project | null> {
    const row = await this.db
      .prepare(`SELECT ${selectProject} FROM projects p WHERE lower(p.slug) = lower(?)`)
      .bind(slug)
      .first();
    return row ? projectSchema.parse(row) : null;
  }
  async list(
    userId: string,
    options: {
      status?: Project["status"];
      search?: string;
      teamId?: string;
      mine?: boolean;
      cursor?: { updatedAt: number; id: string };
      limit?: number;
    } = {}
  ): Promise<Project[]> {
    const access = projectAccessPredicate(userId, "read");
    const conditions = [access.sql];
    const params: unknown[] = [...access.params];
    if (options.status) {
      conditions.push("p.status = ?");
      params.push(options.status);
    }
    if (options.teamId === "null") conditions.push("p.owner_team_id IS NULL");
    else if (options.teamId) {
      conditions.push("p.owner_team_id = ?");
      params.push(options.teamId);
    }
    if (options.search) {
      conditions.push("(instr(lower(p.name), lower(?)) > 0 OR instr(lower(p.slug), lower(?)) > 0)");
      params.push(options.search, options.search);
    }
    if (options.mine) {
      conditions.push(
        "(p.owner_user_id = ? OR EXISTS (SELECT 1 FROM sessions s WHERE s.project_id = p.id AND s.user_id = ?))"
      );
      params.push(userId, userId);
    }
    if (options.cursor) {
      conditions.push("(p.updated_at < ? OR (p.updated_at = ? AND p.id > ?))");
      params.push(options.cursor.updatedAt, options.cursor.updatedAt, options.cursor.id);
    }
    const result = await this.db
      .prepare(
        `SELECT ${selectProject} FROM projects p WHERE ${conditions.join(" AND ")} ORDER BY p.updated_at DESC, p.id LIMIT ?`
      )
      .bind(...params, options.limit ?? 200)
      .all();
    return result.results.map((row) => projectSchema.parse(row));
  }
  async create(input: CreateProjectInput, actor: ProjectActor): Promise<Project> {
    const now = Date.now();
    const id = `proj_${crypto.randomUUID()}`;
    const project: Project = {
      id,
      slug: input.slug,
      name: input.name,
      brief: input.brief ?? null,
      status: "active",
      shippedAt: null,
      archivedAt: null,
      ownerTeamId: input.ownerTeamId ?? null,
      ownerUserId: actor.userId,
      defaultEnvironmentId: input.defaultEnvironmentId ?? null,
      defaultRepoOwner: input.defaultRepoOwner ?? null,
      defaultRepoName: input.defaultRepoName ?? null,
      defaultAgentProfileId: null,
      linearProjectId: input.linearProjectId ?? null,
      linearProjectUrl: input.linearProjectUrl ?? null,
      primarySlackChannelId: input.primarySlackChannelId ?? null,
      statusSummary: null,
      statusSummarySource: null,
      statusSummarySessionId: null,
      statusSummaryUpdatedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const active = activePermissionPredicate(actor.userId, ["projects.create"]);
    const team = project.ownerTeamId;
    const teamSql =
      team === null
        ? "1"
        : `EXISTS (SELECT 1 FROM teams t WHERE t.id = ? AND t.archived_at IS NULL AND EXISTS (SELECT 1 FROM team_memberships tm WHERE tm.team_id = t.id AND tm.user_id = ?))`;
    const entries = Object.entries(columns) as [keyof Project, string][];
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO projects (${entries.map(([, col]) => col).join(",")}) SELECT ${entries.map(() => "?").join(",")} WHERE ${active.sql} AND ${teamSql}`
        )
        .bind(
          ...entries.map(([key]) => project[key]),
          ...active.params,
          ...(team === null ? [] : [team, actor.userId])
        ),
      projectAudit(this.db, actor, project, "project.created", null, project),
    ]);
    if (!results[0].meta.changes) throw new ProjectWriteConflict();
    return project;
  }
  async update(
    project: Project,
    input:
      | UpdateProjectInput
      | Partial<
          Pick<
            Project,
            | "status"
            | "shippedAt"
            | "archivedAt"
            | "statusSummary"
            | "statusSummarySource"
            | "statusSummarySessionId"
            | "statusSummaryUpdatedAt"
          >
        >,
    actor: ProjectActor
  ): Promise<Project> {
    const after = { ...project, ...input, updatedAt: Math.max(Date.now(), project.updatedAt + 1) };
    const keys = [...Object.keys(input), "updatedAt"] as (keyof Project)[];
    const access = projectAccessPredicate(actor.userId, "manage", "projects");
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE projects SET ${keys.map((key) => `${columns[key]} = ?`).join(", ")} WHERE id = ? AND updated_at = ? AND ${access.sql}`
        )
        .bind(...keys.map((key) => after[key]), project.id, project.updatedAt, ...access.params),
      projectAudit(this.db, actor, project, "project.updated", project, after),
    ]);
    if (!results[0].meta.changes) throw new ProjectWriteConflict();
    return after;
  }
  async sources(projectId: string): Promise<ProjectSource[]> {
    return (
      await this.db
        .prepare(
          `SELECT ${Object.entries(sourceColumns)
            .map(([key, col]) => `${col} AS ${key}`)
            .join(",")} FROM project_context_sources WHERE project_id = ? ORDER BY position, id`
        )
        .bind(projectId)
        .all<ProjectSource>()
    ).results;
  }
  async pins(projectId: string): Promise<ProjectPin[]> {
    return (
      await this.db
        .prepare(
          `SELECT ${Object.entries(pinColumns)
            .map(([key, col]) => `${col} AS ${key}`)
            .join(",")} FROM project_pins WHERE project_id = ? ORDER BY position, id`
        )
        .bind(projectId)
        .all<ProjectPin>()
    ).results;
  }
  async putSource(
    project: Project,
    input: ProjectSourceInput,
    actor: ProjectActor,
    id?: string
  ): Promise<string> {
    return this.putItem(
      project,
      "source",
      { ...input, provenance: "user", provenanceSessionId: null },
      actor,
      id
    );
  }
  async putPin(
    project: Project,
    input: ProjectPinInput,
    actor: ProjectActor,
    id?: string
  ): Promise<string> {
    return this.putItem(project, "pin", input, actor, id);
  }
  private async putItem(
    project: Project,
    kind: "source" | "pin",
    input: object,
    actor: ProjectActor,
    id?: string
  ): Promise<string> {
    const table = kind === "source" ? "project_context_sources" : "project_pins";
    const mapping = kind === "source" ? sourceColumns : pinColumns;
    const now = Date.now();
    const itemId = id ?? `${kind === "source" ? "pcs" : "pin"}_${crypto.randomUUID()}`;
    const data: Record<string, unknown> = {
      ...input,
      id: itemId,
      projectId: project.id,
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    };
    const entries = Object.entries(mapping);
    const access = projectAccessPredicate(actor.userId, "manage");
    const mutable = entries.filter(
      ([key]) => !["id", "projectId", "createdBy", "createdAt"].includes(key)
    );
    const sql = id
      ? `UPDATE ${table} SET ${mutable.map(([, col]) => `${col} = ?`).join(",")} WHERE id = ? AND project_id = ?`
      : `INSERT INTO ${table} (${entries.map(([, col]) => col).join(",")}) SELECT ${entries.map(() => "?").join(",")} WHERE (SELECT COUNT(*) FROM ${table} WHERE project_id = ?) < 200`;
    const values = id
      ? [...mutable.map(([key]) => data[key] ?? null), itemId, project.id]
      : [...entries.map(([key]) => data[key] ?? null), project.id];
    const results = await this.db.batch([
      this.db
        .prepare(`${sql} AND EXISTS (SELECT 1 FROM projects p WHERE p.id = ? AND ${access.sql})`)
        .bind(...values, project.id, ...access.params),
      projectAudit(this.db, actor, project, `project.${kind}_saved`, null, {
        id: itemId,
        ...input,
      }),
      this.db
        .prepare(
          "UPDATE projects SET updated_at = CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END WHERE id = ? AND changes() > 0"
        )
        .bind(now, now, project.id),
    ]);
    if (!results[0].meta.changes) throw new ProjectWriteConflict();
    return itemId;
  }
  async deleteItem(
    project: Project,
    kind: "source" | "pin",
    id: string,
    actor: ProjectActor
  ): Promise<void> {
    const table = kind === "source" ? "project_context_sources" : "project_pins";
    const now = Date.now();
    const access = projectAccessPredicate(actor.userId, "manage");
    const results = await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM ${table} WHERE id = ? AND project_id = ? AND EXISTS (SELECT 1 FROM projects p WHERE p.id = ? AND ${access.sql})`
        )
        .bind(id, project.id, project.id, ...access.params),
      projectAudit(this.db, actor, project, `project.${kind}_removed`, { id }, null),
      this.db
        .prepare(
          "UPDATE projects SET updated_at = CASE WHEN updated_at >= ? THEN updated_at + 1 ELSE ? END WHERE id = ? AND changes() > 0"
        )
        .bind(now, now, project.id),
    ]);
    if (!results[0].meta.changes) throw new ProjectWriteConflict();
  }
}

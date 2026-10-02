import type { SessionViewer } from "@open-inspect/shared";
import { canReadProject, type Project } from "@open-inspect/shared/types/projects";
import {
  buildInjectionBlock,
  buildToolResult,
  type ProjectContextInput,
  type ProjectSessionSummary,
} from "@open-inspect/shared/project-context";
import { AuthorizationService, AuthorizationError } from "../authorization/service";
import { TeamMembershipStore } from "../db/team-memberships";
import { ProjectStore } from "../db/project-store";
import { visibleSessionsPredicate } from "../db/session-visibility";
import type { SqlDatabase } from "../db/sql-database";

export async function projectViewer(db: SqlDatabase, userId: string): Promise<SessionViewer> {
  let auth;
  try {
    auth = await new AuthorizationService(db).getEffectiveAuthorization(userId);
  } catch (cause) {
    if (cause instanceof AuthorizationError)
      return {
        kind: "user",
        userId,
        roleKey: null,
        permissions: [],
        suspended: true,
        memberships: new Map(),
      };
    throw cause;
  }
  return {
    kind: "user",
    userId,
    roleKey: auth.role.key,
    permissions: auth.permissions,
    suspended: auth.suspendedAt !== null,
    memberships: await new TeamMembershipStore(db).listForUser(userId),
  };
}
/** Inputs are filtered before assembly; no conversation bodies enter this module. */
export async function loadProjectSnapshotContext(
  db: SqlDatabase,
  projectId: string,
  viewer: SessionViewer,
  repositories: ProjectContextInput["sessionRepositories"] = [],
  excludePrivate = false
): Promise<(ProjectContextInput & { project: Project }) | null> {
  const store = new ProjectStore(db);
  const project = await store.get(projectId);
  if (!project || !canReadProject(viewer, project)) return null;
  const visible =
    viewer.kind === "user" && !viewer.permissions.includes("sessions.read")
      ? { sql: "0 = 1", params: [] }
      : visibleSessionsPredicate("s", viewer, { mode: "on", excludePrivate });
  const [sources, pins] = await Promise.all([store.sources(projectId), store.pins(projectId)]);
  const sessionSources = sources.some(
    (source) => source.sourceType === "session" && source.visibility === "agent"
  )
    ? await db
        .prepare(
          `SELECT DISTINCT s.id FROM project_context_sources pcs JOIN sessions s ON s.id = pcs.external_id_or_url WHERE pcs.project_id = ? AND pcs.source_type = 'session' AND pcs.visibility = 'agent' AND ${visible.sql}`
        )
        .bind(projectId, ...visible.params)
        .all<{ id: string }>()
    : { results: [] };
  const visibleSessionIds = new Set(sessionSources.results.map((row) => row.id));
  const visibleSources: ProjectContextInput["sources"] = sources.filter(
    (source) =>
      source.visibility === "agent" &&
      (source.sourceType !== "session" || visibleSessionIds.has(source.externalIdOrUrl))
  );
  const primarySources: ProjectContextInput["sources"] = [];
  if (project.linearProjectUrl || project.linearProjectId)
    primarySources.push({
      id: `${project.id}:linear`,
      sourceType: "linear_project",
      externalIdOrUrl: project.linearProjectUrl ?? project.linearProjectId!,
      role: "tickets",
      visibility: "agent",
      position: 0,
    });
  if (project.primarySlackChannelId)
    primarySources.push({
      id: `${project.id}:slack`,
      sourceType: "slack_channel",
      externalIdOrUrl: project.primarySlackChannelId,
      role: "channel",
      visibility: "agent",
      position: 0,
    });
  for (const source of primarySources)
    if (
      !sources.some(
        (existing) =>
          existing.sourceType === source.sourceType &&
          existing.externalIdOrUrl === source.externalIdOrUrl
      )
    )
      visibleSources.push(source);
  return {
    project,
    decisions: pins.filter((pin) => pin.kind === "decision"),
    links: pins.filter((pin) => pin.kind === "link"),
    sources: visibleSources,
    sessions: [],
    memories: [],
    sessionRepositories: repositories,
  };
}
/** Live summaries add two set-based queries; immutable snapshots never load them. */
export async function loadProjectContext(
  db: SqlDatabase,
  projectId: string,
  viewer: SessionViewer,
  repositories: ProjectContextInput["sessionRepositories"] = [],
  excludePrivate = false
): Promise<(ProjectContextInput & { project: Project }) | null> {
  const context = await loadProjectSnapshotContext(
    db,
    projectId,
    viewer,
    repositories,
    excludePrivate
  );
  if (!context) return null;
  const visible =
    viewer.kind === "user" && !viewer.permissions.includes("sessions.read")
      ? { sql: "0 = 1", params: [] }
      : visibleSessionsPredicate("s", viewer, { mode: "on", excludePrivate });
  const rows = await db
    .prepare(
      `SELECT s.id,s.title,s.status,s.repo_owner,s.repo_name,s.updated_at FROM sessions s WHERE s.project_id = ? AND ${visible.sql} ORDER BY s.updated_at DESC,s.id LIMIT 20`
    )
    .bind(projectId, ...visible.params)
    .all<{
      id: string;
      title: string | null;
      status: string;
      repo_owner: string | null;
      repo_name: string | null;
      updated_at: number;
    }>();
  const prs = rows.results.length
    ? await db
        .prepare(
          `SELECT session_id, url, lifecycle_state AS state, is_draft AS isDraft FROM session_pull_requests WHERE session_id IN (${rows.results.map(() => "?").join(",")})`
        )
        .bind(...rows.results.map((row) => row.id))
        .all<{ session_id: string; url: string; state: string; isDraft: number }>()
    : { results: [] };
  const sessions: ProjectSessionSummary[] = rows.results.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    target: row.repo_owner && row.repo_name ? `${row.repo_owner}/${row.repo_name}` : "",
    updatedAt: row.updated_at,
    pullRequests: prs.results
      .filter((pr) => pr.session_id === row.id)
      .map(({ url, state, isDraft }) => ({ url, state, isDraft: !!isDraft })),
  }));
  return { ...context, sessions };
}

export async function resolveProjectCreation(
  db: SqlDatabase,
  input: {
    projectId?: string | null;
    userId: string | null;
    ownerTeamId: string | null;
    repositories?: ProjectContextInput["sessionRepositories"];
  }
) {
  if (!input.projectId) return {};
  if (!input.userId) throw new Error("Project sessions require a canonical owner");
  const context = await loadProjectSnapshotContext(
    db,
    input.projectId,
    await projectViewer(db, input.userId),
    input.repositories
  );
  if (!context) throw new Error("Project not found or not accessible");
  if (context.project.ownerTeamId !== input.ownerTeamId) throw new Error("project_team_mismatch");
  return { projectId: input.projectId, projectSnapshot: await buildInjectionBlock(context) };
}
export { buildToolResult };

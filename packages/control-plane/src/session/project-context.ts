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
export async function loadProjectContext(
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
  const [sources, pins, rows] = await Promise.all([
    store.sources(projectId),
    store.pins(projectId),
    db
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
      }>(),
  ]);
  const sessions: ProjectSessionSummary[] = await Promise.all(
    rows.results.map(async (row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      target: row.repo_owner && row.repo_name ? `${row.repo_owner}/${row.repo_name}` : "",
      updatedAt: row.updated_at,
      pullRequests: (
        await db
          .prepare(
            "SELECT url, lifecycle_state AS state, is_draft AS isDraft FROM session_pull_requests WHERE session_id = ?"
          )
          .bind(row.id)
          .all<{ url: string; state: string; isDraft: number }>()
      ).results.map((pr) => ({ ...pr, isDraft: !!pr.isDraft })),
    }))
  );
  const visibleSources: ProjectContextInput["sources"] = [];
  for (const source of sources) {
    if (source.visibility !== "agent") continue;
    if (
      source.sourceType === "session" &&
      !(await db
        .prepare(`SELECT 1 FROM sessions s WHERE s.id = ? AND ${visible.sql}`)
        .bind(source.externalIdOrUrl, ...visible.params)
        .first())
    )
      continue;
    visibleSources.push(source);
  }
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
    sessions,
    memories: [],
    sessionRepositories: repositories,
  };
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
  const context = await loadProjectContext(
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

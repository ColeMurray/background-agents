import { authorizeEnvironmentTarget, authorizeSessionTarget } from "./session-target-authorization";
import { loadProjectContext } from "../session/project-context";
import { createSessionRuntimeClient } from "../session/runtime-client";
import { SessionInternalPaths } from "../session/contracts";
import { visibleSessionsPredicate } from "../db/session-visibility";
import { Hono } from "hono";
import { z } from "zod";
import {
  createProjectSchema,
  updateProjectSchema,
  projectSourceInputSchema,
  projectPinInputSchema,
  projectStatusSchema,
  projectCapabilities,
  canReadProject,
  type Project,
} from "@open-inspect/shared/types/projects";
import { buildInjectionBlock, utf8Bytes } from "@open-inspect/shared/project-context";
import { admittedProject } from "../authorization/project-admission";
import { resourceViewer } from "../authorization/resource-viewer";
import { evaluateSessionAdmission } from "../authorization/session-admission";
import { ProjectStore, ProjectWriteConflict } from "../db/project-store";
import { isUniqueConstraintError } from "../db/errors";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { parseBody } from "./body";
import { parseQuery } from "./query";
import {
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  requirePermission,
  requireProject,
  json,
  error,
  type RequestContext,
} from "./shared";
import { resolveCreationOwnerTeam } from "./team-ownership";
import type { Env } from "../types";

const actor = (ctx: RequestContext) => ({
  userId: ctx.authorization!.userId,
  requestId: ctx.request_id,
});
const view = (project: Project, ctx: RequestContext) => ({
  ...project,
  capabilities: projectCapabilities(ctx.projectAdmission!.viewer, project),
});
function validDefaults(
  input: Pick<Project, "defaultEnvironmentId" | "defaultRepoOwner" | "defaultRepoName">
): boolean {
  return (
    !(input.defaultEnvironmentId && input.defaultRepoOwner) &&
    !!input.defaultRepoOwner === !!input.defaultRepoName
  );
}
async function writeResult(operation: () => Promise<Response>): Promise<Response> {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof ProjectWriteConflict)
      return json({ error: cause.message, code: "project_changed" }, 409);
    if (isUniqueConstraintError(cause))
      return json(
        { error: "Project slug or source already exists", code: "project_conflict" },
        409
      );
    throw cause;
  }
}
async function handleList(request: Request, _env: Env, _params: object, ctx: RequestContext) {
  const query = parseQuery(
    request,
    z.object({
      status: projectStatusSchema.optional(),
      search: z.string().max(200).optional(),
      teamId: z.string().optional(),
      mine: z.enum(["true", "false"]).optional(),
      cursor: z.string().max(512).optional(),
    })
  );
  if (query instanceof Response) return query;
  let cursor: { updatedAt: number; id: string } | undefined;
  if (query.cursor) {
    try {
      cursor = z
        .object({ updatedAt: z.number().int().nonnegative(), id: z.string().min(1).max(100) })
        .parse(JSON.parse(atob(query.cursor)));
    } catch {
      return error("Invalid project cursor", 400);
    }
  }
  const viewer = await resourceViewer(ctx);
  const rows = await new ProjectStore(ctx.db).list(actor(ctx).userId, {
    ...query,
    mine: query.mine === "true",
    cursor,
    limit: 201,
  });
  const projects = rows.slice(0, 200);
  const last = projects.at(-1);
  const visible = ctx.authorization?.permissions.includes("sessions.read")
    ? visibleSessionsPredicate("s", viewer, { mode: "on" })
    : { sql: "0 = 1", params: [] };
  const activity = await ctx.db
    .prepare(
      `SELECT s.project_id AS projectId, MAX(s.updated_at) AS lastActivityAt,
    COALESCE(SUM((SELECT COUNT(*) FROM session_pull_requests pr WHERE pr.session_id = s.id AND pr.lifecycle_state = 'open')),0) AS openPrCount
    FROM sessions s WHERE s.project_id IS NOT NULL AND ${visible.sql} GROUP BY s.project_id`
    )
    .bind(...visible.params)
    .all<{ projectId: string; lastActivityAt: number; openPrCount: number }>();
  const activityByProject = new Map(activity.results.map((row) => [row.projectId, row]));
  return json({
    hasMore: rows.length > 200,
    nextCursor:
      rows.length > 200 && last
        ? btoa(JSON.stringify({ updatedAt: last.updatedAt, id: last.id }))
        : null,
    projects: projects.map((project) => ({
      ...project,
      openPrCount: activityByProject.get(project.id)?.openPrCount ?? 0,
      lastActivityAt: Math.max(
        project.updatedAt,
        activityByProject.get(project.id)?.lastActivityAt ?? 0
      ),
      capabilities: projectCapabilities(viewer, project),
    })),
  });
}
async function handleCreate(request: Request, _env: Env, _params: object, ctx: RequestContext) {
  const input = await parseBody(request, createProjectSchema);
  if (input instanceof Response) return input;
  if (
    !validDefaults({
      defaultEnvironmentId: input.defaultEnvironmentId ?? null,
      defaultRepoOwner: input.defaultRepoOwner ?? null,
      defaultRepoName: input.defaultRepoName ?? null,
    })
  )
    return error("Choose either an environment or a complete repository pair", 400);
  const team = await resolveCreationOwnerTeam(ctx, input.ownerTeamId ?? null);
  if (team instanceof Response) return team;
  const defaultError = await validateProjectDefaults(ctx, {
    ...input,
    ownerTeamId: team?.id ?? null,
  });
  if (defaultError) return defaultError;
  const viewer = await resourceViewer(ctx);
  if (team && (viewer.kind !== "user" || !viewer.memberships.has(team.id)))
    return error("Team membership required", 403);
  return writeResult(async () => {
    const project = await new ProjectStore(ctx.db).create(input, actor(ctx));
    return json(
      { project: { ...project, capabilities: projectCapabilities(viewer, project) } },
      201
    );
  });
}
async function handleGet(_request: Request, _env: Env, _params: object, ctx: RequestContext) {
  return json({ project: view(admittedProject(ctx).project, ctx) });
}
async function handleBySlug(
  _request: Request,
  _env: Env,
  params: { slug: string },
  ctx: RequestContext
) {
  const project = await new ProjectStore(ctx.db).getBySlug(params.slug);
  const viewer = await resourceViewer(ctx);
  if (!project || !canReadProject(viewer, project)) return error("Project not found", 404);
  return json({ project: { ...project, capabilities: projectCapabilities(viewer, project) } });
}
async function handleUpdate(request: Request, _env: Env, _params: object, ctx: RequestContext) {
  const input = await parseBody(request, updateProjectSchema);
  if (input instanceof Response) return input;
  const project = admittedProject(ctx).project;
  if (!validDefaults({ ...project, ...input }))
    return error("Choose either an environment or a complete repository pair", 400);
  const defaultError = await validateProjectDefaults(ctx, { ...project, ...input });
  if (defaultError) return defaultError;
  return writeResult(async () =>
    json({ project: view(await new ProjectStore(ctx.db).update(project, input, actor(ctx)), ctx) })
  );
}
async function handleStatus(request: Request, _env: Env, _params: object, ctx: RequestContext) {
  const action = new URL(request.url).pathname.split("/").at(-1);
  const project = admittedProject(ctx).project;
  const status = action === "ship" ? "shipped" : action === "archive" ? "archived" : "active";
  return writeResult(async () =>
    json({
      project: view(
        await new ProjectStore(ctx.db).update(
          project,
          {
            status,
            shippedAt: status === "shipped" ? Date.now() : null,
            archivedAt: status === "archived" ? Date.now() : null,
          },
          actor(ctx)
        ),
        ctx
      ),
    })
  );
}
async function handleSummary(request: Request, _env: Env, _params: object, ctx: RequestContext) {
  const input = await parseBody(request, z.strictObject({ statusSummary: z.string().max(4000) }));
  if (input instanceof Response) return input;
  return writeResult(async () =>
    json({
      project: view(
        await new ProjectStore(ctx.db).update(
          admittedProject(ctx).project,
          {
            ...input,
            statusSummarySource: "user",
            statusSummarySessionId: null,
            statusSummaryUpdatedAt: Date.now(),
          },
          actor(ctx)
        ),
        ctx
      ),
    })
  );
}
async function handleSources(
  request: Request,
  env: Env,
  params: { id: string; sourceId?: string },
  ctx: RequestContext
) {
  const project = admittedProject(ctx).project;
  const store = new ProjectStore(ctx.db);
  if (request.method === "GET") {
    const visible = ctx.authorization?.permissions.includes("sessions.read")
      ? visibleSessionsPredicate("s", admittedProject(ctx).viewer, { mode: "on" })
      : { sql: "0 = 1", params: [] };
    const sources = [];
    for (const source of await store.sources(project.id)) {
      if (
        source.sourceType !== "session" ||
        (await ctx.db
          .prepare(`SELECT 1 FROM sessions s WHERE s.id = ? AND ${visible.sql}`)
          .bind(source.externalIdOrUrl, ...visible.params)
          .first())
      )
        sources.push(source);
    }
    return json({ sources });
  }
  if (request.method === "DELETE")
    return writeResult(async () => {
      await store.deleteItem(project, "source", params.sourceId!, actor(ctx));
      return json({ deleted: true });
    });
  const input = await parseBody(request, projectSourceInputSchema);
  if (input instanceof Response) return input;
  if (input.sourceType === "session") {
    const admission = await evaluateSessionAdmission(
      ctx,
      env,
      input.externalIdOrUrl,
      "read",
      null,
      true
    );
    if (admission.kind !== "allowed") return error("Session not found", 404);
  }
  return writeResult(async () => {
    const id = await store.putSource(project, input, actor(ctx), params.sourceId);
    return json({ id });
  });
}
async function handlePins(
  request: Request,
  env: Env,
  params: { id: string; pinId?: string },
  ctx: RequestContext
) {
  const project = admittedProject(ctx).project;
  const store = new ProjectStore(ctx.db);
  if (request.method === "GET") {
    const visible = ctx.authorization?.permissions.includes("sessions.read")
      ? visibleSessionsPredicate("s", admittedProject(ctx).viewer, { mode: "on" })
      : { sql: "0 = 1", params: [] };
    const pins = [];
    const artifacts = new Map<string, Promise<Set<string>>>();
    const exists = (sessionId: string, artifactId: string) => {
      if (!artifacts.has(sessionId)) artifacts.set(sessionId, artifactIds(env, ctx, sessionId));
      return artifacts.get(sessionId)!.then((ids) => ids.has(artifactId));
    };
    for (const pin of await store.pins(project.id)) {
      if (
        pin.kind !== "artifact" ||
        ((await ctx.db
          .prepare(`SELECT 1 FROM sessions s WHERE s.id = ? AND ${visible.sql}`)
          .bind(pin.sessionId, ...visible.params)
          .first()) &&
          (await exists(pin.sessionId!, pin.artifactId!)))
      )
        pins.push(pin);
      else
        pins.push({
          id: pin.id,
          kind: "artifact",
          title: "Unavailable artifact",
          unavailable: true,
        });
    }
    return json({ pins });
  }
  if (request.method === "DELETE")
    return writeResult(async () => {
      await store.deleteItem(project, "pin", params.pinId!, actor(ctx));
      return json({ deleted: true });
    });
  const input = await parseBody(request, projectPinInputSchema);
  if (input instanceof Response) return input;
  if (input.kind === "artifact") {
    const admission = await evaluateSessionAdmission(
      ctx,
      env,
      input.sessionId!,
      "read",
      null,
      true
    );
    if (admission.kind !== "allowed") return error("Session not found", 404);
    if (!(await artifactIds(env, ctx, input.sessionId!)).has(input.artifactId!))
      return error("Artifact not found", 404);
  }
  return writeResult(async () => {
    const id = await store.putPin(project, input, actor(ctx), params.pinId);
    return json({ id });
  });
}
async function handlePreview(_request: Request, _env: Env, _params: object, ctx: RequestContext) {
  const project = admittedProject(ctx).project;
  const input = await loadProjectContext(ctx.db, project.id, admittedProject(ctx).viewer);
  if (!input) return error("Project not found", 404);
  const snapshot = await buildInjectionBlock(input);
  return json({ ...snapshot, bytes: utf8Bytes(snapshot.text) });
}
const read = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  authorization: requireProject("read"),
  cacheControl: "private, no-store",
});
const manage = admit({ ...SCM_AGNOSTIC_HUMAN_USER_ROUTE, authorization: requireProject("manage") });
export const projectRoutes = new Hono<ControlPlaneHonoEnv>();
projectRoutes.get(
  "/projects",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    authorization: requirePermission("projects.read", { service: "deny" }),
  }),
  (c) => dispatch(c, handleList)
);
projectRoutes.post(
  "/projects",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    authorization: requirePermission("projects.create", { service: "deny" }),
  }),
  (c) => dispatch(c, handleCreate)
);
projectRoutes.get(
  "/projects/by-slug/:slug",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    authorization: requirePermission("projects.read", { service: "deny" }),
  }),
  (c) => dispatch(c, handleBySlug)
);
projectRoutes.get("/projects/:id", read, (c) => dispatch(c, handleGet));
projectRoutes.patch("/projects/:id", manage, (c) => dispatch(c, handleUpdate));
for (const action of ["ship", "archive", "restore"])
  projectRoutes.post(`/projects/:id/${action}`, manage, (c) => dispatch(c, handleStatus));
projectRoutes.put("/projects/:id/status-summary", manage, (c) => dispatch(c, handleSummary));
projectRoutes.get("/projects/:id/context/preview", read, (c) => dispatch(c, handlePreview));
projectRoutes.get("/projects/:id/sources", read, (c) => dispatch(c, handleSources));
projectRoutes.put("/projects/:id/sources", manage, (c) => dispatch(c, handleSources));
projectRoutes.put("/projects/:id/sources/:sourceId", manage, (c) => dispatch(c, handleSources));
projectRoutes.delete("/projects/:id/sources/:sourceId", manage, (c) => dispatch(c, handleSources));
projectRoutes.get("/projects/:id/pins", read, (c) => dispatch(c, handlePins));
projectRoutes.put("/projects/:id/pins", manage, (c) => dispatch(c, handlePins));
projectRoutes.put("/projects/:id/pins/:pinId", manage, (c) => dispatch(c, handlePins));
projectRoutes.delete("/projects/:id/pins/:pinId", manage, (c) => dispatch(c, handlePins));

async function validateProjectDefaults(
  ctx: RequestContext,
  project: {
    ownerTeamId?: string | null;
    defaultEnvironmentId?: string | null;
    defaultRepoOwner?: string | null;
    defaultRepoName?: string | null;
  }
) {
  if (project.defaultEnvironmentId) {
    const permission = await authorizeSessionTarget(ctx, {
      teamId: null,
      environmentId: project.defaultEnvironmentId,
    });
    if (permission) return permission;
    return authorizeEnvironmentTarget(ctx, {
      environmentId: project.defaultEnvironmentId,
      ownerTeamId: project.ownerTeamId ?? null,
    });
  }
  if (project.defaultRepoOwner && project.defaultRepoName)
    return authorizeSessionTarget(ctx, {
      teamId: project.ownerTeamId ?? null,
      repositories: [{ owner: project.defaultRepoOwner, name: project.defaultRepoName }],
    });
  return null;
}

async function artifactIds(env: Env, ctx: RequestContext, sessionId: string): Promise<Set<string>> {
  const response = await createSessionRuntimeClient(env, ctx).fetch(
    sessionId,
    SessionInternalPaths.artifacts
  );
  if (!response.ok) return new Set();
  const parsed = z
    .object({ artifacts: z.array(z.object({ id: z.string() })) })
    .safeParse(await response.json());
  return new Set(parsed.success ? parsed.data.artifacts.map((artifact) => artifact.id) : []);
}

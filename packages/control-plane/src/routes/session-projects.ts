import { readSessionReference } from "../session/session-references";
import { resourceViewer } from "../authorization/resource-viewer";
import { createSessionRuntimeClient } from "../session/runtime-client";
import { SessionInternalPaths } from "../session/contracts";
import { Hono } from "hono";
import { z } from "zod";
import { canReadProject, projectCapabilities } from "@open-inspect/shared/types/projects";
import { ProjectStore, ProjectWriteConflict } from "../db/project-store";
import { SessionProjectStore } from "../db/session-project-store";
import { SessionScopeStore } from "../db/session-scope-store";
import { SessionIndexStore } from "../db/session-index";
import { evaluateProjectAdmission } from "../authorization/project-admission";
import { evaluateSessionAdmission } from "../authorization/session-admission";
import { projectViewer, loadProjectContext, buildToolResult } from "../session/project-context";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import {
  json,
  error,
  requireSession,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  NO_AUTHORIZATION,
  type RequestContext,
} from "./shared";

async function associate(request: Request, env: Env, params: { id: string }, ctx: RequestContext) {
  const input = await parseBody(
    request,
    z.strictObject({
      projectId: z.string().min(1).nullable(),
      includeChildren: z.boolean().default(true),
    })
  );
  if (input instanceof Response) return input;
  let project = null;
  if (input.projectId) {
    const admission = await evaluateProjectAdmission(ctx, input.projectId, "read");
    if (admission instanceof Response) return admission;
    project = admission.project;
  }
  const ids = [
    params.id,
    ...(input.includeChildren
      ? await new SessionScopeStore(ctx.db).listDescendantIds(params.id)
      : []),
  ];
  for (const id of ids) {
    const access = await evaluateSessionAdmission(ctx, env, id, "lifecycle", null, true);
    if (access.kind !== "allowed") return error("Session is unavailable or cannot be moved", 403);
    const row = await new SessionIndexStore(ctx.db).get(id);
    if (project && row?.ownerTeamId !== project.ownerTeamId)
      return json(
        { error: "Project and session teams differ", code: "project_team_mismatch" },
        409
      );
  }
  try {
    const updated = await new SessionProjectStore(ctx.db).associate(
      params.id,
      project,
      input.includeChildren,
      { userId: ctx.authorization!.userId, requestId: ctx.request_id }
    );
    return json({ projectId: input.projectId, updated });
  } catch (cause) {
    if (cause instanceof ProjectWriteConflict)
      return json({ error: cause.message, code: "project_changed" }, 409);
    throw cause;
  }
}
async function snapshot(_request: Request, _env: Env, params: { id: string }, ctx: RequestContext) {
  const session = await new SessionIndexStore(ctx.db).get(params.id);
  const project = session?.projectId ? await new ProjectStore(ctx.db).get(session.projectId) : null;
  const viewer = await resourceViewer(ctx);
  return json({
    snapshot: await new SessionProjectStore(ctx.db).snapshot(params.id),
    project:
      project && canReadProject(viewer, project)
        ? { ...project, capabilities: projectCapabilities(viewer, project) }
        : null,
  });
}
async function context(request: Request, env: Env, params: { id: string }, ctx: RequestContext) {
  const part = new URL(request.url).searchParams.get("part") ?? "tool";
  if (part !== "tool" && part !== "injection") return error("Invalid part", 400);
  const session = await new SessionIndexStore(ctx.db).get(params.id);
  if (!session?.userId) return error("Project context unavailable", 404);
  const viewer = await projectViewer(ctx.db, session.userId);
  if (part === "injection") {
    const pinned = await new SessionProjectStore(ctx.db).snapshot(params.id);
    if (!pinned)
      return session.projectId ? json({ text: "", bytes: 0 }) : error("No project context", 404);
    const project = await new ProjectStore(ctx.db).get(pinned.projectId);
    if (!project || !canReadProject(viewer, project))
      return error("Project context unavailable", 404);
    return json(pinned);
  }
  if (!session.projectId) return error("No project associated", 404);
  // Private sibling summaries must not be exposed to an entire shared session audience.
  const input = await loadProjectContext(
    ctx.db,
    session.projectId,
    viewer,
    (session.repositories ?? []).map((repo) => ({ owner: repo.repoOwner, name: repo.repoName })),
    session.visibility !== "private"
  );
  if (!input) return error("Project context unavailable", 404);
  const result = buildToolResult(input);
  const recorded = await createSessionRuntimeClient(env, ctx).fetch(
    params.id,
    SessionInternalPaths.sandboxEvent,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "project_context.read",
        sandboxId: ctx.principal?.kind === "sandbox" ? ctx.principal.sandboxId : "",
        timestamp: Date.now() / 1000, // Sandbox-event wire timestamps are seconds.
        projectId: session.projectId,
        bytes: result.budget.bytes,
        truncated: result.budget.truncated,
      }),
    }
  );
  if (!recorded.ok) return error("Unable to record project context read", 503);
  const response = json(result);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
export const sessionProjectRoutes = new Hono<ControlPlaneHonoEnv>();
sessionProjectRoutes.put(
  "/sessions/:id/project",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    authorization: requireSession("lifecycle", { enforceAlways: true }),
  }),
  (c) => dispatch(c, associate)
);
sessionProjectRoutes.get(
  "/sessions/:id/project-snapshot",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    authorization: requireSession("read", { enforceAlways: true }),
    cacheControl: "private, no-store",
  }),
  (c) => dispatch(c, snapshot)
);
sessionProjectRoutes.get(
  "/sessions/:id/project-context",
  admit({
    ...SCM_AGNOSTIC_SANDBOX_ROUTE,
    authorization: NO_AUTHORIZATION,
    cacheControl: "private, no-store",
  }),
  (c) => dispatch(c, context)
);

sessionProjectRoutes.get(
  "/sessions/:id/reference-summary",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    authorization: requireSession("read", { enforceAlways: true }),
    cacheControl: "private, no-store",
  }),
  (c) =>
    dispatch(c, async (_request, env, params, ctx) =>
      json(
        await readSessionReference(
          ctx.db,
          createSessionRuntimeClient(env, ctx),
          ctx.authorization!.userId,
          params.id
        )
      )
    )
);

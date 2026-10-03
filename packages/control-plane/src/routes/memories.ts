import { Hono } from "hono";
import { z } from "zod";
import {
  createMemorySchema,
  memoryActionSchema,
  memoryPreferencesSchema,
  memoryScopeSchema,
  memoryStatusSchema,
  reviseMemorySchema,
  type MemoryRecord,
} from "@open-inspect/shared/types/memories";
import { repositoriesInputSchema } from "@open-inspect/shared/types/repositories";
import {
  MemoryConflictError,
  MemoryStore,
  MemoryValidationError,
  type MemoryActor,
} from "../db/memories";
import { EnvironmentStore } from "../db/environments";
import { resolveSessionMemory } from "../session/memory-resolution";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import {
  activeSelf,
  error,
  json,
  requirePermission,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  type UserRouteContext,
} from "./shared";
import { authorizeMemoryScope } from "./memory-access";

/** Bind human provenance to the admitted canonical principal, not editable request fields. */
const actor = (ctx: UserRouteContext): MemoryActor => ({
  kind: "user",
  userId: ctx.principal.userId,
  requestId: ctx.request_id,
});
/** Project server-derived management capabilities; the UI never infers permission from status alone. */
function view(record: MemoryRecord, canManage: boolean) {
  return {
    ...record,
    capabilities: {
      canEdit: canManage && record.status !== "archived",
      canArchive: canManage,
      canApprove: canManage && record.status === "proposed",
    },
  };
}
/** Translate expected write conflicts/validation failures while preserving unexpected errors. */
export function memoryWriteError(cause: unknown): Response {
  if (cause instanceof MemoryConflictError) return error(cause.message, 409);
  if (cause instanceof MemoryValidationError) return error(cause.message, 400);
  throw cause;
}
const previewSchema = z
  .object({
    repositories: repositoriesInputSchema.optional(),
    environmentId: z.string().min(1).optional(),
    includePersonalMemories: z.boolean().optional(),
  })
  .strict();

/** Authorize one catalog scope before returning a bounded management page. */
async function list(request: Request, env: Env, _params: object, ctx: UserRouteContext) {
  const query = new URL(request.url).searchParams;
  const scopeResult = memoryScopeSchema.safeParse(
    query.get("scope") === "repository"
      ? { type: "repository", repoOwner: query.get("repoOwner"), repoName: query.get("repoName") }
      : query.get("scope") === "environment"
        ? { type: "environment", environmentId: query.get("environmentId") }
        : { type: query.get("scope") ?? "personal" }
  );
  const status = memoryStatusSchema.safeParse(query.get("status") ?? "active");
  if (!scopeResult.success || !status.success) return error("Invalid memory scope or status", 400);
  const pagination = z
    .object({
      offset: z.coerce.number().int().min(0).max(1_000_000),
      limit: z.coerce.number().int().min(1).max(100),
    })
    .safeParse({ offset: query.get("offset") ?? 0, limit: query.get("limit") ?? 50 });
  if (!pagination.success) return error("Invalid memory pagination", 400);
  const { offset, limit } = pagination.data;
  const access = await authorizeMemoryScope(ctx, env, scopeResult.data, false);
  if (access instanceof Response) return access;
  const records = await new MemoryStore(ctx.db).list(
    scopeResult.data,
    ctx.principal.userId,
    status.data,
    access.repoId,
    offset,
    limit + 1
  );
  return json({
    memories: records.slice(0, limit).map((record) => view(record, access.canManage)),
    nextOffset: records.length > limit ? offset + limit : null,
    canCreate: access.canManage,
  });
}
/** Admit human creation/replacement and bind the resolved stable repository identity. */
async function create(request: Request, env: Env, _params: object, ctx: UserRouteContext) {
  const body = await parseBody(request, createMemorySchema, "Invalid memory");
  if (body instanceof Response) return body;
  const access = await authorizeMemoryScope(ctx, env, body.scope, true);
  if (access instanceof Response) return access;
  try {
    return json(
      { memory: view(await new MemoryStore(ctx.db).create(body, actor(ctx), access.repoId), true) },
      201
    );
  } catch (cause) {
    return memoryWriteError(cause);
  }
}
/** Conceal inaccessible records and return the current revision with management capabilities. */
async function get(_request: Request, env: Env, params: { id: string }, ctx: UserRouteContext) {
  const record = await new MemoryStore(ctx.db).get(params.id);
  if (!record) return error("Memory not found", 404);
  const access = await authorizeMemoryScope(ctx, env, record.scope, false, record);
  return access instanceof Response ? access : json({ memory: view(record, access.canManage) });
}
/** Authorize an edit and require the revision the user actually reviewed. */
async function revise(request: Request, env: Env, params: { id: string }, ctx: UserRouteContext) {
  const store = new MemoryStore(ctx.db);
  const record = await store.get(params.id);
  if (!record) return error("Memory not found", 404);
  const access = await authorizeMemoryScope(ctx, env, record.scope, true, record);
  if (access instanceof Response) return access;
  const body = await parseBody(request, reviseMemorySchema, "Invalid memory revision");
  if (body instanceof Response) return body;
  const { expectedRevisionId, ...content } = body;
  try {
    return json({
      memory: view(await store.revise(record.id, content, expectedRevisionId, actor(ctx)), true),
    });
  } catch (cause) {
    return memoryWriteError(cause);
  }
}
/** Apply record-level read authorization before exposing any historical content. */
async function revisions(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: UserRouteContext
) {
  const store = new MemoryStore(ctx.db);
  const record = await store.get(params.id);
  if (!record) return error("Memory not found", 404);
  const access = await authorizeMemoryScope(ctx, env, record.scope, false, record);
  return access instanceof Response
    ? access
    : json({ revisions: await store.revisions(record.id) });
}
/** Build a lifecycle endpoint with scope authorization and optimistic revision fencing. */
function transition(action: "archive" | "restore" | "approve" | "reject") {
  return async (request: Request, env: Env, params: { id: string }, ctx: UserRouteContext) => {
    const store = new MemoryStore(ctx.db);
    const record = await store.get(params.id);
    if (!record) return error("Memory not found", 404);
    const access = await authorizeMemoryScope(ctx, env, record.scope, true, record);
    if (access instanceof Response) return access;
    const body = await parseBody(request, memoryActionSchema, "Invalid memory action");
    if (body instanceof Response) return body;
    try {
      return json({
        memory: view(
          await store.transition(
            record.id,
            action,
            body.expectedRevisionId,
            actor(ctx),
            body.reason
          ),
          true
        ),
      });
    } catch (cause) {
      return memoryWriteError(cause);
    }
  };
}
/** Resolve a non-persisted selection after authorizing every environment/repository target. */
async function preview(request: Request, env: Env, _params: object, ctx: UserRouteContext) {
  const body = await parseBody(request, previewSchema, "Invalid memory target");
  if (body instanceof Response) return body;
  let repositories = body.repositories ?? [];
  if (body.environmentId) {
    const access = await authorizeMemoryScope(
      ctx,
      env,
      { type: "environment", environmentId: body.environmentId },
      false
    );
    if (access instanceof Response) return access;
    repositories = (
      await new EnvironmentStore(ctx.db).getRepositoriesForEnvironment(body.environmentId)
    ).map((repo) => ({ repoOwner: repo.repo_owner, repoName: repo.repo_name, baseBranch: null }));
  }
  const resolvedRepositories = [];
  for (const repo of repositories) {
    const access = await authorizeMemoryScope(
      ctx,
      env,
      { type: "repository", repoOwner: repo.repoOwner, repoName: repo.repoName },
      false
    );
    if (access instanceof Response) return access;
    resolvedRepositories.push({ ...repo, repoId: access.repoId });
  }
  return json(
    await resolveSessionMemory(
      ctx.db,
      {
        canonicalUserId: ctx.principal.userId,
        repositories: resolvedRepositories,
        environmentId: body.environmentId ?? null,
      },
      body.includePersonalMemories
    )
  );
}
/** Read only the admitted principal's canonical personal-memory default. */
async function getPreferences(
  _request: Request,
  _env: Env,
  _params: object,
  ctx: UserRouteContext
) {
  return json(await new MemoryStore(ctx.db).getPreferences(ctx.principal.userId));
}
/** Validate and save the owner default without changing existing sessions. */
async function setPreferences(request: Request, _env: Env, _params: object, ctx: UserRouteContext) {
  const body = await parseBody(request, memoryPreferencesSchema, "Invalid memory preferences");
  return body instanceof Response
    ? body
    : json(await new MemoryStore(ctx.db).setPreferences(ctx.principal.userId, body));
}

export const memoryRoutes = new Hono<ControlPlaneHonoEnv>();
const self = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  authorization: activeSelf({ auditAllowed: true }),
  cacheControl: "private, no-store",
});
memoryRoutes.get("/memory-preferences", self, (c) => dispatch(c, getPreferences));
memoryRoutes.put("/memory-preferences", self, (c) => dispatch(c, setPreferences));
memoryRoutes.post(
  "/memories/preview",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    authorization: requirePermission("sessions.create"),
    cacheControl: "private, no-store",
  }),
  (c) => dispatch(c, preview)
);
memoryRoutes.get("/memories", self, (c) => dispatch(c, list));
memoryRoutes.post("/memories", self, (c) => dispatch(c, create));
memoryRoutes.get("/memories/:id", self, (c) => dispatch(c, get));
memoryRoutes.patch("/memories/:id", self, (c) => dispatch(c, revise));
memoryRoutes.get("/memories/:id/revisions", self, (c) => dispatch(c, revisions));
for (const action of ["archive", "restore", "approve", "reject"] as const)
  memoryRoutes.post(`/memories/:id/${action}`, self, (c) => dispatch(c, transition(action)));

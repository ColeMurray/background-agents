import { Hono } from "hono";
import { z } from "zod";
import {
  createMemorySchema,
  MEMORY_ACTIONS,
  MEMORY_LIST_MAX_PAGE_SIZE,
  MEMORY_LIST_PAGE_SIZE,
  memoryActionSchema,
  memoryPreferencesSchema,
  memoryPreviewSchema,
  memoryScopeFromSearchParams,
  memoryStatusSchema,
  reviseMemorySchema,
  type MemoryAction,
  type MemoryDto,
  type MemoryScope,
} from "@open-inspect/shared/types/memories";
import {
  authorizeMemoryManagement,
  authorizeMemoryTarget,
  type MemoryManagementAccess,
} from "../authorization/memory-access";
import { EnvironmentStore } from "../db/environments";
import { MemoryPreferenceStore } from "../db/memory-preferences";
import { MemoryStore } from "../db/memories";
import { toMemoryDto } from "../memory/dto";
import { partitionScope } from "../memory/partition";
import { resolveSessionMemory } from "../memory/resolve-session-memory";
import type { MemoryActor, MemoryRecord } from "../memory/types";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import { expectedRevision, memoryErrorResponse } from "./memory-errors";
import {
  activeSelf,
  error,
  json,
  requirePermission,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  type UserRouteContext,
} from "./shared";

/** Bind human provenance to the admitted canonical principal, not editable request fields. */
const actor = (ctx: UserRouteContext): MemoryActor => ({
  kind: "user",
  userId: ctx.principal.userId,
  requestId: ctx.request_id,
});

const paginationSchema = z.object({
  offset: z.coerce.number().int().min(0).max(1_000_000),
  limit: z.coerce.number().int().min(1).max(MEMORY_LIST_MAX_PAGE_SIZE),
});

async function dto(
  store: MemoryStore,
  record: MemoryRecord,
  canManage: boolean
): Promise<MemoryDto> {
  const replacements = await store.replacementIds([record.id]);
  return toMemoryDto(record, canManage, replacements.get(record.id) ?? []);
}

/** Load a record and authorize it against its own partition; inaccessible records are concealed. */
async function authorizedRecord(
  store: MemoryStore,
  env: Env,
  ctx: UserRouteContext,
  id: string,
  mode: "read" | "write"
): Promise<{ record: MemoryRecord; access: MemoryManagementAccess } | Response> {
  const record = await store.get(id);
  if (!record) return error("Memory not found", 404);
  const scope: MemoryScope = partitionScope(record.partition);
  const access = await authorizeMemoryManagement(ctx, env, scope, mode, record);
  return access instanceof Response ? access : { record, access };
}

/** Authorize one catalog scope before returning a bounded management page. */
async function list(request: Request, env: Env, _params: object, ctx: UserRouteContext) {
  const query = new URL(request.url).searchParams;
  const scope = memoryScopeFromSearchParams(query);
  const status = memoryStatusSchema.safeParse(query.get("status") ?? "active");
  if (!scope || !status.success) return error("Invalid memory scope or status", 400);
  const pagination = paginationSchema.safeParse({
    offset: query.get("offset") ?? 0,
    limit: query.get("limit") ?? MEMORY_LIST_PAGE_SIZE,
  });
  if (!pagination.success) return error("Invalid memory pagination", 400);
  const { offset, limit } = pagination.data;
  const access = await authorizeMemoryManagement(ctx, env, scope, "read");
  if (access instanceof Response) return access;
  const store = new MemoryStore(ctx.db);
  // One extra row tells us whether another page exists.
  const records = await store.list(access.partition, {
    status: status.data,
    offset,
    limit: limit + 1,
  });
  const page = records.slice(0, limit);
  const replacements = await store.replacementIds(page.map((record) => record.id));
  return json({
    memories: page.map((record) =>
      toMemoryDto(record, access.canManage, replacements.get(record.id) ?? [])
    ),
    nextOffset: records.length > limit ? offset + limit : null,
    canCreate: access.canManage,
  });
}

/** Admit human creation/replacement into the authorized partition. */
async function create(request: Request, env: Env, _params: object, ctx: UserRouteContext) {
  const body = await parseBody(request, createMemorySchema, "Invalid memory");
  if (body instanceof Response) return body;
  const access = await authorizeMemoryManagement(ctx, env, body.scope, "write");
  if (access instanceof Response) return access;
  const { scope: _scope, supersedesMemoryId, ...content } = body;
  const store = new MemoryStore(ctx.db);
  try {
    const record = await store.create(
      { partition: access.partition, content, supersedesMemoryId },
      actor(ctx)
    );
    return json({ memory: await dto(store, record, true) }, 201);
  } catch (cause) {
    return memoryErrorResponse(cause);
  }
}

async function get(_request: Request, env: Env, params: { id: string }, ctx: UserRouteContext) {
  const store = new MemoryStore(ctx.db);
  const found = await authorizedRecord(store, env, ctx, params.id, "read");
  if (found instanceof Response) return found;
  return json({ memory: await dto(store, found.record, found.access.canManage) });
}

/** Edit against the revision the user reviewed (`If-Match`). */
async function revise(request: Request, env: Env, params: { id: string }, ctx: UserRouteContext) {
  const revision = expectedRevision(request);
  if (revision instanceof Response) return revision;
  const store = new MemoryStore(ctx.db);
  const found = await authorizedRecord(store, env, ctx, params.id, "write");
  if (found instanceof Response) return found;
  const content = await parseBody(request, reviseMemorySchema, "Invalid memory revision");
  if (content instanceof Response) return content;
  try {
    const record = await store.revise(found.record.id, content, revision, actor(ctx));
    return json({ memory: await dto(store, record, true) });
  } catch (cause) {
    return memoryErrorResponse(cause);
  }
}

/** Record-level read authorization applies before any historical content is exposed. */
async function revisions(
  _request: Request,
  env: Env,
  params: { id: string },
  ctx: UserRouteContext
) {
  const store = new MemoryStore(ctx.db);
  const found = await authorizedRecord(store, env, ctx, params.id, "read");
  if (found instanceof Response) return found;
  return json({ revisions: await store.revisions(found.record.id) });
}

/** A lifecycle endpoint fenced by the reviewed revision (`If-Match`). */
function transition(action: MemoryAction) {
  return async (request: Request, env: Env, params: { id: string }, ctx: UserRouteContext) => {
    const revision = expectedRevision(request);
    if (revision instanceof Response) return revision;
    const store = new MemoryStore(ctx.db);
    const found = await authorizedRecord(store, env, ctx, params.id, "write");
    if (found instanceof Response) return found;
    const body = await parseBody(request, memoryActionSchema, "Invalid memory action");
    if (body instanceof Response) return body;
    try {
      const record = await store.transition(
        found.record.id,
        action,
        revision,
        actor(ctx),
        body.reason
      );
      return json({ memory: await dto(store, record, true) });
    } catch (cause) {
      return memoryErrorResponse(cause);
    }
  };
}

/**
 * Resolve the selection a new session would pin, without persisting it. Targets get the same
 * human admission as management reads, then the same memory filtering as session creation.
 */
async function preview(request: Request, env: Env, _params: object, ctx: UserRouteContext) {
  const body = await parseBody(request, memoryPreviewSchema, "Invalid memory target");
  if (body instanceof Response) return body;
  let repositories: { repoOwner: string; repoName: string }[] = body.repositories ?? [];
  if (body.environmentId) {
    const access = await authorizeMemoryManagement(
      ctx,
      env,
      { type: "environment", environmentId: body.environmentId },
      "read"
    );
    if (access instanceof Response) return access;
    repositories = (
      await new EnvironmentStore(ctx.db).getRepositoriesForEnvironment(body.environmentId)
    ).map((repo) => ({ repoOwner: repo.repo_owner, repoName: repo.repo_name }));
  }
  const resolved = [];
  for (const repo of repositories) {
    const access = await authorizeMemoryManagement(
      ctx,
      env,
      { type: "repository", ...repo },
      "read"
    );
    if (access instanceof Response) return access;
    if (access.partition.type === "repository")
      resolved.push({ ...repo, repoId: access.partition.repoId });
  }
  const target = await authorizeMemoryTarget(ctx, {
    userId: ctx.principal.userId,
    ownerTeamId: null,
    repositories: resolved,
    environmentId: body.environmentId ?? null,
  });
  return json(await resolveSessionMemory(ctx.db, target, body.includePersonalMemories));
}

/** Read only the admitted principal's canonical personal-memory default. */
async function getPreferences(
  _request: Request,
  _env: Env,
  _params: object,
  ctx: UserRouteContext
) {
  return json(await new MemoryPreferenceStore(ctx.db).get(ctx.principal.userId));
}

/** Save the owner default for future sessions; existing sessions are unchanged. */
async function setPreferences(request: Request, _env: Env, _params: object, ctx: UserRouteContext) {
  const body = await parseBody(request, memoryPreferencesSchema, "Invalid memory preferences");
  return body instanceof Response
    ? body
    : json(await new MemoryPreferenceStore(ctx.db).set(ctx.principal.userId, body));
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
for (const action of MEMORY_ACTIONS)
  memoryRoutes.post(`/memories/:id/${action}`, self, (c) => dispatch(c, transition(action)));

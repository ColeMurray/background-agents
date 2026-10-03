import { Hono } from "hono";
import {
  createSandboxMemorySchema,
  memorySearchSchema,
  type MemoryRecord,
  type MemoryScope,
} from "@open-inspect/shared/types/memories";
import { MemoryStore } from "../db/memories";
import { SessionMemoryStore, MemorySearchScopeError } from "../db/session-memories";
import { searchMemories } from "../db/memory-search";
import { SessionIndexStore } from "../db/session-index";
import { TeamStore } from "../db/teams";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { EnvironmentStore } from "../db/environments";
import { AuthorizationError, AuthorizationService } from "../authorization/service";
import { authorizeWorkspaceRepositories } from "./workspace-repository-authorization";
import { matchesMemoryTarget, renderMemorySection } from "../session/memory-resolution";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import {
  error,
  json,
  NO_AUTHORIZATION,
  requireSession,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  SCM_AGNOSTIC_SANDBOX_ROUTE,
  type SandboxRouteContext,
  type UserRouteContext,
} from "./shared";
import { memoryWriteError } from "./memories";

/**
 * Recheck team activity, repository grants, and environment ownership for sandbox reads.
 * A pinned manifest or previously issued session token does not freeze shared-scope access.
 */
async function currentSharedAccess(
  ctx: SandboxRouteContext,
  sessionId: string,
  records: readonly Pick<MemoryRecord, "scope" | "repoId">[]
): Promise<boolean> {
  const session = await new SessionIndexStore(ctx.db).get(sessionId);
  if (!session) return false;
  const repositories = records.flatMap((record) =>
    record.scope.type === "repository"
      ? [
          {
            owner: record.scope.repoOwner,
            name: record.scope.repoName,
            repoId: record.repoId ?? null,
          },
        ]
      : []
  );
  if (repositories.some((repo) => repo.repoId === null)) return false;
  if (session.ownerTeamId) {
    if (!(await new TeamStore(ctx.db).isActive(session.ownerTeamId))) return false;
    const ids = records
      .filter((record) => record.scope.type === "repository")
      .map((record) => record.repoId ?? null);
    if (!(await new TeamRepositoryGrantStore(ctx.db).covers(session.ownerTeamId, ids)))
      return false;
  } else {
    if (!session.userId) return false;
    try {
      const authorization = await new AuthorizationService(ctx.db).getEffectiveAuthorization(
        session.userId
      );
      if (
        authorization.suspendedAt !== null ||
        (await authorizeWorkspaceRepositories(
          { ...ctx, authorization, sessionMemberships: undefined },
          { repositories }
        ))
      )
        return false;
    } catch (cause) {
      if (cause instanceof AuthorizationError) return false;
      throw cause;
    }
  }
  const environmentIds = new Set(
    records.flatMap((record) =>
      record.scope.type === "environment" ? [record.scope.environmentId] : []
    )
  );
  for (const id of environmentIds) {
    const environment = await new EnvironmentStore(ctx.db).getById(id);
    if (
      !environment ||
      (environment.owner_team_id && environment.owner_team_id !== session.ownerTeamId)
    )
      return false;
  }
  return true;
}
/** Return pinned metadata plus required live drift flags under session-read admission. */
async function view(_request: Request, _env: Env, params: { id: string }, ctx: UserRouteContext) {
  const loaded = await new SessionMemoryStore(ctx.db).load(params.id);
  return loaded ? json(loaded.diagnostics) : error("Session not found", 404);
}
/** Return pinned boot context only after validating all referenced shared scopes. */
async function installation(
  _request: Request,
  _env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
) {
  const store = new SessionMemoryStore(ctx.db);
  const loaded = await store.load(params.id);
  if (!loaded) return error("Session not found", 404);
  if (!(await currentSharedAccess(ctx, params.id, loaded.revisions)))
    return error("Memory scope is no longer available", 403);
  return json({
    schemaVersion: 1,
    manifestSha256: loaded.manifest.manifestSha256,
    rendered: renderMemorySection(loaded.manifest, loaded.revisions),
  });
}
/** Expose only live facts or pinned archive notices after current shared-scope admission. */
async function read(
  _request: Request,
  _env: Env,
  params: { id: string; memoryId: string },
  ctx: SandboxRouteContext
) {
  const record = await new SessionMemoryStore(ctx.db).read(params.id, params.memoryId);
  if (!record || !(await currentSharedAccess(ctx, params.id, [record])))
    return error("Memory not found", 404);
  return json(record.result);
}
/**
 * Derive agent identity and scope from the authenticated session, never from the request body.
 * Infer a sole repository or the session environment; require a selector for multiple repos.
 * Shared-session personal writes are proposals because credentials identify a session, not
 * an immutable prompt author; the store rechecks any auto-save eligibility atomically.
 */
async function write(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
) {
  const body = await parseBody(request, createSandboxMemorySchema, "Invalid memory");
  if (body instanceof Response) return body;
  const store = new SessionMemoryStore(ctx.db);
  const target = await store.target(params.id);
  const session = await new SessionIndexStore(ctx.db).get(params.id);
  if (!target || !session) return error("Session not found", 404);
  let scope: MemoryScope;
  let repoId: number | null = null;
  if (body.scope.type === "repository") {
    const requested = body.scope;
    if (requested.repoOwner === undefined && target.repositories.length > 1)
      return error(
        `This session spans multiple repositories — specify repoOwner and repoName (one of: ${target.repositories.map((repo) => `${repo.repoOwner}/${repo.repoName}`).join(", ")})`,
        400
      );
    const repo =
      requested.repoOwner === undefined
        ? target.repositories[0]
        : target.repositories.find(
            (repo) =>
              repo.repoOwner.toLowerCase() === requested.repoOwner &&
              repo.repoName.toLowerCase() === requested.repoName
          );
    if (!repo) return error("Repository is outside this session", 403);
    scope = { type: "repository", repoOwner: repo.repoOwner, repoName: repo.repoName };
    repoId = repo.repoId;
  } else if (body.scope.type === "environment") {
    if (!target.environmentId) return error("This session has no associated environment", 403);
    scope = { type: "environment", environmentId: target.environmentId };
  } else {
    scope = body.scope;
  }
  if (!matchesMemoryTarget({ scope, ownerUserId: target.canonicalUserId, repoId }, target))
    return error("Memory scope is outside this session", 403);
  // A collaborator-owned child can consume inherited context but cannot mutate its original owner's personal store.
  if (scope.type === "personal" && session.userId !== target.canonicalUserId)
    return error("Personal memory owner differs from this session owner", 403);
  if (!(await currentSharedAccess(ctx, params.id, [{ scope, repoId }])))
    return error("Memory scope is no longer available", 403);
  const autoSave = await ctx.db
    .prepare(
      "SELECT personal_auto_save_eligible FROM session_memory_manifests WHERE session_id = ?"
    )
    .bind(params.id)
    .first<{ personal_auto_save_eligible: number }>();
  try {
    const memory = await new MemoryStore(ctx.db).create(
      { ...body, scope },
      {
        kind: "agent",
        userId: scope.type === "personal" ? target.canonicalUserId : (session.userId ?? null),
        sessionId: params.id,
        requestId: ctx.request_id,
        allowPersonalAutoSave: autoSave?.personal_auto_save_eligible === 1,
      },
      repoId
    );
    return json(
      { id: memory.id, status: memory.status, revisionId: memory.currentRevisionId },
      201
    );
  } catch (cause) {
    return memoryWriteError(cause);
  }
}

export const sessionMemoryRoutes = new Hono<ControlPlaneHonoEnv>();
/** Search current facts under session admission, checking selected scopes before and after SQL. */
async function search(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
) {
  const input = await parseBody(request, memorySearchSchema, "Invalid memory search");
  if (input instanceof Response) return input;
  try {
    const scopes = await new SessionMemoryStore(ctx.db).searchScopes(params.id, input);
    if (!scopes) return error("Session not found", 404);
    if (!(await currentSharedAccess(ctx, params.id, scopes)))
      return error("Memory scope is no longer available", 403);
    const result = await searchMemories(ctx.db, input, scopes);
    if (!(await currentSharedAccess(ctx, params.id, scopes)))
      return error("Memory scope is no longer available", 403);
    return json(result);
  } catch (cause) {
    if (cause instanceof MemorySearchScopeError) return error(cause.message, 403);
    throw cause;
  }
}
const sandbox = admit({
  ...SCM_AGNOSTIC_SANDBOX_ROUTE,
  authorization: NO_AUTHORIZATION,
  cacheControl: "private, no-store",
});
sessionMemoryRoutes.get(
  "/sessions/:id/memories",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    authorization: requireSession("read"),
    cacheControl: "private, no-store",
  }),
  (c) => dispatch(c, view)
);
sessionMemoryRoutes.get("/sessions/:id/sandbox-memory", sandbox, (c) => dispatch(c, installation));
sessionMemoryRoutes.get("/sessions/:id/sandbox-memory/:memoryId", sandbox, (c) =>
  dispatch(c, read)
);
sessionMemoryRoutes.post("/sessions/:id/sandbox-memory", sandbox, (c) => dispatch(c, write));
sessionMemoryRoutes.post("/sessions/:id/sandbox-memory/search", sandbox, (c) =>
  dispatch(c, search)
);

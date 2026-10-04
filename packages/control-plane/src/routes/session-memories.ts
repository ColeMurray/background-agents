import { Hono } from "hono";
import { memorySearchSchema, sandboxMemoryWriteSchema } from "@open-inspect/shared/types/memories";
import { createSharedMemoryAccess } from "../authorization/memory-access-factory";
import { MemoryStore } from "../db/memories";
import { searchMemories } from "../db/memory-search";
import { SessionMemoryStore } from "../db/session-memories";
import { SessionMemoryService } from "../memory/session-memory-service";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import { memoryErrorResponse } from "./memory-errors";
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

/** Pinned selection plus live drift flags, under session-read admission. */
async function view(_request: Request, _env: Env, params: { id: string }, ctx: UserRouteContext) {
  const loaded = await new SessionMemoryStore(ctx.db).load(params.id);
  return loaded ? json(loaded.diagnostics) : error("Session not found", 404);
}

/** Compose the service from D1-backed dependencies for one admitted sandbox request. */
function sessionMemoryService(ctx: SandboxRouteContext): SessionMemoryService {
  const sharedAccess = createSharedMemoryAccess(ctx);
  return new SessionMemoryService({
    sessions: new SessionMemoryStore(ctx.db),
    memories: new MemoryStore(ctx.db),
    search: (input, partitions) => searchMemories(ctx.db, input, partitions),
    sharedAccess: (principal) => sharedAccess.forPrincipal(principal),
    requestId: ctx.request_id,
  });
}

/** Run one sandbox operation, translating expected memory failures. */
async function sandboxCall(
  ctx: SandboxRouteContext,
  operation: (service: SessionMemoryService) => Promise<unknown>,
  status = 200
): Promise<Response> {
  try {
    return json(await operation(sessionMemoryService(ctx)), status);
  } catch (cause) {
    return memoryErrorResponse(cause);
  }
}

async function installation(
  _request: Request,
  _env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
) {
  return sandboxCall(ctx, (service) => service.installation(params.id));
}

async function read(
  _request: Request,
  _env: Env,
  params: { id: string; memoryId: string },
  ctx: SandboxRouteContext
) {
  return sandboxCall(ctx, (service) => service.read(params.id, params.memoryId));
}

async function write(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
) {
  const body = await parseBody(request, sandboxMemoryWriteSchema, "Invalid memory");
  if (body instanceof Response) return body;
  return sandboxCall(ctx, (service) => service.write(params.id, body), 201);
}

async function search(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
) {
  const body = await parseBody(request, memorySearchSchema, "Invalid memory search");
  if (body instanceof Response) return body;
  return sandboxCall(ctx, (service) => service.search(params.id, body));
}

export const sessionMemoryRoutes = new Hono<ControlPlaneHonoEnv>();
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

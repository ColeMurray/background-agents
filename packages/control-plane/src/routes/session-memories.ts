import { Hono } from "hono";
import { memorySearchSchema, sandboxMemoryWriteSchema } from "@open-inspect/shared/types/memories";
import { createSessionMemoryAccessPolicy } from "../authorization/memory-access-factory";
import { MemoryRecordStore } from "../db/memory-records";
import { LexicalFactIndex } from "../db/lexical-fact-index";
import { SessionMemorySelectionStore } from "../db/session-memory-selections";
import { toSelectionStatus } from "../memory/dto";
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

/** The pinned selection as people see it, with live drift, under session-read admission. */
async function view(_request: Request, _env: Env, params: { id: string }, ctx: UserRouteContext) {
  const loaded = await new SessionMemorySelectionStore(ctx.db).loadSelection(params.id);
  return loaded
    ? json(toSelectionStatus(loaded.selection, loaded.drift))
    : error("Session not found", 404);
}

/** Compose the service from D1-backed dependencies for one admitted sandbox request. */
function sessionMemoryService(ctx: SandboxRouteContext): SessionMemoryService {
  return new SessionMemoryService({
    selections: new SessionMemorySelectionStore(ctx.db),
    records: new MemoryRecordStore(ctx.db),
    factIndex: new LexicalFactIndex(ctx.db),
    access: createSessionMemoryAccessPolicy(ctx),
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

async function renderedContext(
  _request: Request,
  _env: Env,
  params: { id: string },
  ctx: SandboxRouteContext
) {
  return sandboxCall(ctx, (service) => service.renderedContext(params.id));
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
sessionMemoryRoutes.get("/sessions/:id/sandbox-memory", sandbox, (c) =>
  dispatch(c, renderedContext)
);
sessionMemoryRoutes.get("/sessions/:id/sandbox-memory/:memoryId", sandbox, (c) =>
  dispatch(c, read)
);
sessionMemoryRoutes.post("/sessions/:id/sandbox-memory", sandbox, (c) => dispatch(c, write));
sessionMemoryRoutes.post("/sessions/:id/sandbox-memory/search", sandbox, (c) =>
  dispatch(c, search)
);

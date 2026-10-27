import { Hono } from "hono";
import { memorySearchSchema, sandboxMemoryWriteSchema } from "@open-inspect/shared/types/memories";
import { createSessionMemoryAccessPolicy } from "../authorization/memory-access-factory";
import { MemoryReadAuditStore } from "../db/memory-read-audit";
import { MemoryRecordStore } from "../db/memory-records";
import { LexicalFactIndex } from "../db/lexical-fact-index";
import { SessionMemorySelectionStore } from "../db/session-memory-selections";
import { toSelectionStatus } from "../memory/dto";
import { SessionMemoryService } from "../memory/session-memory-service";
import type { MemoryPromptContext } from "../memory/types";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { SessionInternalPaths } from "../session/contracts";
import { memoryPromptContextSchema } from "../session/memory-prompt-context";
import type { SessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";
import { parseBody } from "./body";
import { memoryErrorResponse } from "./memory-errors";
import { dispatchSession } from "./session-route";
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

type SandboxMemoryContext = SandboxRouteContext & { sessionRuntime: SessionRuntimeClient };

/** Treated as someone else's prompt: no personal reads, writes, or auto-save. */
const NO_OWNER_PROMPT: MemoryPromptContext = { authorUserId: null, othersPrompted: true };

/**
 * The pinned selection as people see it, with live drift, under session-read admission. Personal
 * items are listed only for the personal owner.
 */
async function view(_request: Request, _env: Env, params: { id: string }, ctx: UserRouteContext) {
  const loaded = await new SessionMemorySelectionStore(ctx.db).loadSelection(params.id);
  return loaded
    ? json(toSelectionStatus(loaded.selection, loaded.drift, ctx.principal.userId))
    : error("Session not found", 404);
}

/** Compose the service from D1-backed dependencies for one admitted sandbox request. */
function sessionMemoryService(ctx: SandboxRouteContext): SessionMemoryService {
  return new SessionMemoryService({
    selections: new SessionMemorySelectionStore(ctx.db),
    records: new MemoryRecordStore(ctx.db),
    factIndex: new LexicalFactIndex(ctx.db),
    access: createSessionMemoryAccessPolicy(ctx),
    audit: new MemoryReadAuditStore(ctx.db),
    requestId: ctx.request_id,
  });
}

/**
 * Who the agent is serving right now, from the session runtime. Anything but a clear answer counts
 * as someone else's prompt, so a shell call between prompts never reaches personal memory.
 */
async function promptContext(
  ctx: SandboxMemoryContext,
  sessionId: string
): Promise<MemoryPromptContext> {
  const response = await ctx.sessionRuntime.fetch(
    sessionId,
    SessionInternalPaths.memoryPromptContext
  );
  if (!response.ok) return NO_OWNER_PROMPT;
  const parsed = memoryPromptContextSchema.safeParse(await response.json());
  return parsed.success ? parsed.data : NO_OWNER_PROMPT;
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
  ctx: SandboxMemoryContext
) {
  const prompt = await promptContext(ctx, params.id);
  return sandboxCall(ctx, (service) => service.read(params.id, params.memoryId, prompt));
}

async function write(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: SandboxMemoryContext
) {
  const body = await parseBody(request, sandboxMemoryWriteSchema, "Invalid memory");
  if (body instanceof Response) return body;
  const prompt = await promptContext(ctx, params.id);
  return sandboxCall(ctx, (service) => service.write(params.id, body, prompt), 201);
}

async function search(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: SandboxMemoryContext
) {
  const body = await parseBody(request, memorySearchSchema, "Invalid memory search");
  if (body instanceof Response) return body;
  const prompt = await promptContext(ctx, params.id);
  return sandboxCall(ctx, (service) => service.search(params.id, body, prompt));
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
  dispatchSession(c, read)
);
sessionMemoryRoutes.post("/sessions/:id/sandbox-memory", sandbox, (c) => dispatchSession(c, write));
sessionMemoryRoutes.post("/sessions/:id/sandbox-memory/search", sandbox, (c) =>
  dispatchSession(c, search)
);

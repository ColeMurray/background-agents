import { Hono } from "hono";
import { memorySearchSchema, sandboxMemoryWriteSchema } from "@open-inspect/shared/types/memories";
import { createSessionMemoryAccessPolicy } from "../authorization/memory-access-factory";
import { MemoryRecordStore } from "../db/memory-records";
import { PersonalMemoryAuditStore } from "../db/personal-memory-audit";
import { LexicalFactIndex } from "../db/lexical-fact-index";
import { SessionMemorySelectionStore } from "../db/session-memory-selections";
import { toSelectionStatus } from "../memory/dto";
import { SessionMemoryService } from "../memory/session-memory-service";
import { UNATTRIBUTED_PROMPT } from "../memory/session-rules";
import type { MemoryPromptContext } from "../memory/types";
import { createLogger } from "../logger";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { SessionInternalPaths } from "../session/contracts";
import {
  memoryPromptContextResponseSchema,
  type MemoryPromptContextResponse,
} from "../session/memory-prompt-context";
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

const logger = createLogger("router:session-memories");

type SandboxMemoryContext = SandboxRouteContext & { sessionRuntime: SessionRuntimeClient };

/** Spawn depth is capped well below this; it only bounds a malformed parent chain. */
const MAX_PARENT_HOPS = 8;

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

/** Compose the service from D1-backed and session-runtime dependencies for one sandbox request. */
function sessionMemoryService(ctx: SandboxMemoryContext): SessionMemoryService {
  return new SessionMemoryService({
    selections: new SessionMemorySelectionStore(ctx.db),
    records: new MemoryRecordStore(ctx.db),
    factIndex: new LexicalFactIndex(ctx.db),
    access: createSessionMemoryAccessPolicy(ctx),
    prompts: { current: (sessionId) => promptContext(ctx, sessionId) },
    audit: new PersonalMemoryAuditStore(ctx.db),
    requestId: ctx.request_id,
  });
}

/** One session runtime's answer, or null when it gave none it could use. */
async function runtimePromptContext(
  ctx: SandboxMemoryContext,
  sessionId: string,
  relativeToUserId?: string
): Promise<MemoryPromptContextResponse | null> {
  try {
    const response = await ctx.sessionRuntime.fetch(
      sessionId,
      SessionInternalPaths.memoryPromptContext,
      undefined,
      relativeToUserId ? `?${new URLSearchParams({ userId: relativeToUserId })}` : undefined
    );
    if (!response.ok) return null;
    const parsed = memoryPromptContextResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch (cause) {
    logger.warn("memory.prompt_context_unavailable", {
      event: "memory.prompt_context_unavailable",
      session_id: sessionId,
      request_id: ctx.request_id,
      error: cause instanceof Error ? cause : String(cause),
    });
    return null;
  }
}

/**
 * Who the agent is serving right now, from the session runtime, and whether anyone else has
 * prompted this session or any session that spawned it: a parent's sandbox can spawn and prompt
 * its children on the owner's later prompts. Anything but a clear answer counts as someone else's
 * prompt, so a shell call between prompts never reaches personal memory.
 */
async function promptContext(
  ctx: SandboxMemoryContext,
  sessionId: string
): Promise<MemoryPromptContext> {
  const session = await runtimePromptContext(ctx, sessionId);
  if (!session) return UNATTRIBUTED_PROMPT;
  const { authorUserId } = session;
  if (authorUserId === null || session.othersPrompted)
    return { authorUserId, othersPrompted: true };
  let parentSessionId = session.parentSessionId;
  for (let hop = 0; parentSessionId; hop++) {
    const parent =
      hop < MAX_PARENT_HOPS ? await runtimePromptContext(ctx, parentSessionId, authorUserId) : null;
    if (!parent || parent.othersPrompted) return { authorUserId, othersPrompted: true };
    parentSessionId = parent.parentSessionId;
  }
  return { authorUserId, othersPrompted: false };
}

/** Run one sandbox operation, translating expected memory failures. */
async function sandboxCall(
  ctx: SandboxMemoryContext,
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
  ctx: SandboxMemoryContext
) {
  return sandboxCall(ctx, (service) => service.renderedContext(params.id));
}

async function read(
  _request: Request,
  _env: Env,
  params: { id: string; memoryId: string },
  ctx: SandboxMemoryContext
) {
  return sandboxCall(ctx, (service) => service.read(params.id, params.memoryId));
}

async function write(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: SandboxMemoryContext
) {
  const body = await parseBody(request, sandboxMemoryWriteSchema, "Invalid memory");
  if (body instanceof Response) return body;
  return sandboxCall(ctx, (service) => service.write(params.id, body), 201);
}

async function search(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: SandboxMemoryContext
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
  dispatchSession(c, renderedContext)
);
sessionMemoryRoutes.get("/sessions/:id/sandbox-memory/:memoryId", sandbox, (c) =>
  dispatchSession(c, read)
);
sessionMemoryRoutes.post("/sessions/:id/sandbox-memory", sandbox, (c) => dispatchSession(c, write));
sessionMemoryRoutes.post("/sessions/:id/sandbox-memory/search", sandbox, (c) =>
  dispatchSession(c, search)
);

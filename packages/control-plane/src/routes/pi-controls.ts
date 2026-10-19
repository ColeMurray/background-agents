import { Hono } from "hono";
import { z } from "zod";
import { piRuntimeControlSchema } from "../pi/runtime-contract";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { SessionInternalPaths } from "../session/contracts";
import { error, requireSession, SCM_AGNOSTIC_HUMAN_USER_ROUTE } from "./shared";
import { dispatchSession, type SessionRouteContext } from "./session-route";

const requestIdSchema = z.string().min(1).max(128);
function forward(control: unknown, sessionId: string, ctx: SessionRouteContext) {
  const candidate = typeof control === "object" && control !== null ? control : {};
  const parsed = piRuntimeControlSchema.safeParse({ ...candidate, sessionId });
  if (!parsed.success) return error("Invalid Pi control request", 400);
  const principal = ctx.principal;
  if (principal?.kind !== "user") return error("Pi controls require a user", 403);
  return ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.piControl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actorId: principal.userId, source: "web", control: parsed.data }),
  });
}
const COLLABORATION_ACTIONS = new Set(["submit", "send", "steer", "follow_up", "fork", "compact"]);
const LIFECYCLE_ACTIONS = new Set(["cancel_exact", "reset", "handoff"]);
function post(allowed: Set<string>) {
  return async (
    request: Request,
    _env: unknown,
    params: { id: string },
    ctx: SessionRouteContext
  ) => {
    const body = await request.json().catch(() => null);
    const action =
      typeof body === "object" && body !== null && "action" in body ? body.action : undefined;
    if (typeof action !== "string" || !allowed.has(action))
      return error("Pi control action is not allowed on this route", 400);
    return forward(body, params.id, ctx);
  };
}
function readAction(action: "list_conversations" | "get_conversation" | "inspect" | "task_graph") {
  return async (
    request: Request,
    _env: unknown,
    params: { id: string; conversationId?: string },
    ctx: SessionRouteContext
  ) => {
    const requestId = requestIdSchema.safeParse(new URL(request.url).searchParams.get("requestId"));
    if (!requestId.success) return error("requestId is required", 400);
    return forward(
      {
        action,
        requestId: requestId.data,
        ...(params.conversationId ? { conversationId: Number(params.conversationId) } : {}),
      },
      params.id,
      ctx
    );
  };
}
export const piControlRoutes = new Hono<ControlPlaneHonoEnv>();
const READ = admit({ ...SCM_AGNOSTIC_HUMAN_USER_ROUTE, authorization: requireSession("read") });
const COLLABORATE = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  authorization: requireSession("collaborate"),
});
const LIFECYCLE = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  authorization: requireSession("lifecycle"),
});
piControlRoutes.get("/sessions/:id/pi/conversations", READ, (c) =>
  dispatchSession(c, readAction("list_conversations"))
);
piControlRoutes.get("/sessions/:id/pi/conversations/:conversationId", READ, (c) =>
  dispatchSession(c, readAction("get_conversation"))
);
piControlRoutes.get("/sessions/:id/pi/inspect", READ, (c) =>
  dispatchSession(c, readAction("inspect"))
);
piControlRoutes.get("/sessions/:id/pi/task-graph", READ, (c) =>
  dispatchSession(c, readAction("task_graph"))
);
piControlRoutes.post("/sessions/:id/pi/control", COLLABORATE, (c) =>
  dispatchSession(c, post(COLLABORATION_ACTIONS))
);
piControlRoutes.post("/sessions/:id/pi/lifecycle-control", LIFECYCLE, (c) =>
  dispatchSession(c, post(LIFECYCLE_ACTIONS))
);

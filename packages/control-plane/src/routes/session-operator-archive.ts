import { Hono } from "hono";
import { z } from "zod";
import { SessionIndexStore } from "../db/session-index";
import { createLogger } from "../logger";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { archiveOperatorSessionPage, parseOperatorArchiveCursor } from "../session/operator-archive";
import type { SessionRuntimeClient } from "../session/runtime-client";
import type { Env } from "../types";
import { dispatchSession } from "./session-route";
import {
  error,
  json,
  requirePermission,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  type UserRouteContext,
} from "./shared";

const log = createLogger("operator-session-archive");
const requestSchema = z.object({ cursor: z.string().nullable().optional() }).strict();

/**
 * Archive one page of sessions on behalf of an operator.
 *
 * Who may call this is decided by the route's declared `sessions.archive_any`
 * requirement, so the router's authorization audit records the same decision
 * the caller observes. The handler only sees requests that already passed it.
 */
export async function handleOperatorSessionArchive(
  request: Request,
  _env: Env,
  _params: object,
  ctx: UserRouteContext & { sessionRuntime: SessionRuntimeClient }
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return error("Invalid request body", 400);
  }
  const parsedRequest = requestSchema.safeParse(raw);
  if (!parsedRequest.success) return error("Invalid request body", 400);

  const parsedCursor = parseOperatorArchiveCursor(parsedRequest.data.cursor);
  if (!parsedCursor.ok) return error(parsedCursor.error, 400);

  const result = await archiveOperatorSessionPage({
    index: new SessionIndexStore(ctx.db),
    runtime: ctx.sessionRuntime,
    log,
    operatorUserId: ctx.principal.userId,
    cursor: parsedCursor.cursor,
    now: Date.now(),
  });
  return json(result);
}

export const sessionOperatorArchiveRoutes = new Hono<ControlPlaneHonoEnv>();

sessionOperatorArchiveRoutes.post(
  "/operator/sessions/archive",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    authorization: requirePermission("sessions.archive_any", { service: "deny" }),
  }),
  (c) => dispatchSession(c, handleOperatorSessionArchive)
);

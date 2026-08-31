import { z } from "zod";
import { SessionIndexStore } from "../db/session-index";
import { createLogger } from "../logger";
import {
  archiveOperatorSessionPage,
  authorizeOperatorUserId,
  parseOperatorArchiveCursor,
  type VerifiedOperatorUserId,
} from "../session/operator-archive";
import type { Env } from "../types";
import { sessionRoute, type SessionRouteContext } from "./session-route";
import {
  ACTIVE_SELF,
  defineRoute,
  error,
  json,
  parsePattern,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  type Route,
} from "./shared";

const log = createLogger("operator-session-archive");
const requestSchema = z.object({ cursor: z.string().nullable().optional() }).strict();

async function handleOperatorSessionArchive(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  if (ctx.principal?.kind !== "user") return error("Operator access required", 403);

  const principalUserId = ctx.principal.userId;
  let operatorUserId: VerifiedOperatorUserId | null;
  try {
    operatorUserId = authorizeOperatorUserId(principalUserId, env.OPERATOR_USER_IDS);
  } catch (configurationError) {
    log.error("Operator session archive is misconfigured", {
      event: "operator.session_archive_misconfigured",
      error:
        configurationError instanceof Error
          ? configurationError.message
          : String(configurationError),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Operator authorization is misconfigured", 500);
  }

  if (operatorUserId === null) {
    log.warn("Operator session archive denied", {
      event: "operator.session_archive_denied",
      operator_user_id: principalUserId,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Operator access required", 403);
  }

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
    operatorUserId,
    cursor: parsedCursor.cursor,
    now: Date.now(),
  });
  return json(result);
}

export const sessionOperatorArchiveRoutes: Route[] = [
  defineRoute(
    SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    sessionRoute({
      method: "POST",
      pattern: parsePattern("/operator/sessions/archive"),
      authorization: ACTIVE_SELF,
      handler: handleOperatorSessionArchive,
    })
  ),
];

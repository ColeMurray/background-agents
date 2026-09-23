import { Hono } from "hono";
import {
  sessionBatchArchiveRequestSchema,
  type SessionBatchArchiveResponse,
} from "@open-inspect/shared/types/session-archive";
import { createLogger } from "../logger";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { archiveSessionBatch } from "../session/batch-archive";
import { parseBody } from "./body";
import type { SessionRuntimeClient } from "../session/runtime-client";
import { dispatchSession } from "./session-route";
import {
  json,
  requirePermission,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  type UserRouteContext,
} from "./shared";

export const sessionBatchArchiveRoutes = new Hono<ControlPlaneHonoEnv>();

sessionBatchArchiveRoutes.post(
  "/sessions/batch-archive",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    authorization: requirePermission("sessions.bulk_archive", { service: "deny" }),
    cacheControl: "private, no-store",
  }),
  (c) =>
    dispatchSession(
      c,
      async (
        request,
        _env,
        _params,
        ctx: UserRouteContext & { sessionRuntime: SessionRuntimeClient }
      ) => {
        const body = await parseBody(request, sessionBatchArchiveRequestSchema);
        if (body instanceof Response) return body;
        const log = createLogger("session-batch-archive", {
          trace_id: ctx.trace_id,
          request_id: ctx.request_id,
        });
        const results = await archiveSessionBatch(body.sessionIds, ctx.sessionRuntime, log);
        log.info("Session batch archive completed", {
          event: "session.batch_archive",
          user_id: ctx.principal.userId,
          results,
        });
        return json({ results } satisfies SessionBatchArchiveResponse);
      }
    )
);

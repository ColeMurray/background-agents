import { Hono } from "hono";
import {
  sessionBatchArchiveRequestSchema,
  type SessionBatchArchiveResponse,
} from "@open-inspect/shared/types/session-archive";
import { createLogger } from "../logger";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { archiveSessionBatch } from "../session/batch-archive";
import {
  auditPrivateSessionBreakGlass,
  auditShadowSessionDenial,
} from "../authorization/request-audit";
import { parseTeamsEnforcementMode } from "../authorization/teams-enforcement";
import {
  resolveSessionTarget,
  sessionTargetDenial,
  shadowSessionDenialReason,
} from "../routing/route-admission";
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
        env,
        _params,
        ctx: UserRouteContext & { sessionRuntime: SessionRuntimeClient }
      ) => {
        const body = await parseBody(request, sessionBatchArchiveRequestSchema);
        if (body instanceof Response) return body;
        const log = createLogger("session-batch-archive", {
          trace_id: ctx.trace_id,
          request_id: ctx.request_id,
        });
        const mode = parseTeamsEnforcementMode(env.TEAMS_ENFORCEMENT);
        const eligible: string[] = [];
        const skipped: SessionBatchArchiveResponse["skipped"] = [];
        for (const sessionId of body.sessionIds) {
          const target = await resolveSessionTarget(ctx, sessionId, "lifecycle", mode);
          const denial = sessionTargetDenial(target, mode);
          if (denial) {
            skipped.push({ sessionId, reason: denial });
            continue;
          }
          if (!target) throw new Error("Unreachable session target");
          if (mode === "shadow") {
            const reason = shadowSessionDenialReason(target);
            if (reason)
              await auditShadowSessionDenial({
                ctx,
                method: request.method,
                path: new URL(request.url).pathname,
                teamId: target.row.ownerTeamId,
                action: "lifecycle",
                reason,
              });
          }
          if (target.read?.allowed && target.read.audit === "session.private_break_glass") {
            await auditPrivateSessionBreakGlass(ctx, sessionId, target.row.ownerTeamId);
          }
          eligible.push(sessionId);
        }
        ctx.sessionAdmission = undefined;
        const results = await archiveSessionBatch(eligible, ctx.sessionRuntime, log);
        log.info("Session batch archive completed", {
          event: "session.batch_archive",
          user_id: ctx.principal.userId,
          results,
        });
        return json({ results, skipped } satisfies SessionBatchArchiveResponse);
      }
    )
);

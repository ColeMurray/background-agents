/**
 * Automation invocation and run read routes.
 */

import { checkSessionAccess } from "@open-inspect/shared";
import {
  MAX_AUTOMATION_INVOCATION_LIST_LIMIT,
  type AutomationRun,
} from "@open-inspect/shared/types/automations";
import { auditPrivateSessionBreakGlass } from "../authorization/request-audit";
import { AutomationStore, toAutomationRun } from "../db/automation-store";
import { SessionCollaboratorStore } from "../db/session-collaborators";
import { SessionIndexStore } from "../db/session-index";
import { Hono } from "hono";
import { dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { type RequestContext, json, error } from "./shared";
import type { Env } from "../types";
import { z } from "zod";
import { admittedAutomation, AUTOMATION_READ } from "./automation-shared";
import { parseQuery } from "./query";

export const DEFAULT_INVOCATION_LIST_LIMIT = 20;
/** Deepest page the list serves; beyond it an OFFSET scan is unbounded work for no reader. */
export const MAX_INVOCATION_LIST_OFFSET = 10_000;

const invocationListQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^[1-9]\d*$/, { error: "Invalid limit" })
    .optional()
    .transform((raw) => (raw === undefined ? DEFAULT_INVOCATION_LIST_LIMIT : Number(raw)))
    .refine((limit) => limit <= MAX_AUTOMATION_INVOCATION_LIST_LIMIT, {
      error: "Invalid limit",
    }),
  offset: z
    .string()
    .regex(/^\d+$/, { error: "Invalid offset" })
    .optional()
    .transform((raw) => (raw === undefined ? 0 : Number(raw)))
    .refine((offset) => offset <= MAX_INVOCATION_LIST_OFFSET, { error: "Invalid offset" }),
});

async function redactRunSessionMetadata(
  ctx: RequestContext,
  runs: AutomationRun[],
  readKind: "list" | "item"
): Promise<void> {
  const viewer = admittedAutomation(ctx).viewer;
  const sessionIds = [...new Set(runs.flatMap((run) => (run.sessionId ? [run.sessionId] : [])))];
  const [sessions, collaborators] = await Promise.all([
    new SessionIndexStore(ctx.db).getByIds(sessionIds),
    new SessionCollaboratorStore(ctx.db).listForSessions(sessionIds),
  ]);
  const readableSessionIds = new Set<string>();
  for (const [sessionId, session] of sessions) {
    const read = checkSessionAccess(
      viewer,
      {
        id: sessionId,
        ownerUserId: session.userId ?? null,
        ownerTeamId: session.ownerTeamId,
        visibility: session.visibility,
        collaboratorIds: collaborators.get(sessionId) ?? [],
      },
      "read"
    );
    if (!read.allowed) continue;
    if (read.audit === "session.private_break_glass") {
      // Lists must not enumerate private sessions through the Owner's break-glass privilege.
      if (readKind === "list") continue;
      await auditPrivateSessionBreakGlass(ctx, sessionId, session.ownerTeamId);
    }
    readableSessionIds.add(sessionId);
  }
  for (const run of runs) {
    if (run.sessionId && readableSessionIds.has(run.sessionId)) continue;
    run.sessionId = null;
    run.sessionTitle = null;
    run.artifactSummary = null;
  }
}

/** GET /automations/:id/invocations — one row per firing; `total` counts invocations. */
async function handleListInvocations(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const automationId = params.id;
  const query = parseQuery(request, invocationListQuerySchema);
  if (query instanceof Response) return query;

  const store = new AutomationStore(ctx.db);
  const result = await store.listInvocations(automationId, query);
  await redactRunSessionMetadata(
    ctx,
    result.invocations.flatMap((invocation) => invocation.runs),
    "list"
  );

  return json({
    invocations: result.invocations,
    total: result.total,
  });
}

async function handleGetRun(
  _request: Request,
  env: Env,
  params: { id: string; runId: string },
  ctx: RequestContext
): Promise<Response> {
  const { id: automationId, runId } = params;

  const store = new AutomationStore(ctx.db);
  const run = await store.getRunById(automationId, runId);
  if (!run) return error("Run not found", 404);

  const result = toAutomationRun(run);
  await redactRunSessionMetadata(ctx, [result], "item");
  return json({ run: result });
}

export const automationRunRoutes = new Hono<ControlPlaneHonoEnv>();

automationRunRoutes.get("/automations/:id/invocations", AUTOMATION_READ, (c) =>
  dispatch(c, handleListInvocations)
);
automationRunRoutes.get("/automations/:id/runs/:runId", AUTOMATION_READ, (c) =>
  dispatch(c, handleGetRun)
);

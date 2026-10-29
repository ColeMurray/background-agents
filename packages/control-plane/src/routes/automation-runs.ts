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

/**
 * Session IDs among `runs` the admitted viewer may read. The Owner's private-session
 * break-glass applies only to single-run reads, which audit it; lists never enumerate them.
 */
async function readableRunSessionIds(
  ctx: RequestContext,
  runs: readonly AutomationRun[],
  breakGlass: "exclude" | "audit"
): Promise<ReadonlySet<string>> {
  const viewer = admittedAutomation(ctx).viewer;
  const sessionIds = [...new Set(runs.flatMap((run) => (run.sessionId ? [run.sessionId] : [])))];
  const [sessions, collaborators] = await Promise.all([
    new SessionIndexStore(ctx.db).getByIds(sessionIds),
    new SessionCollaboratorStore(ctx.db).listForSessions(sessionIds),
  ]);
  const readable = new Set<string>();
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
      if (breakGlass === "exclude") continue;
      await auditPrivateSessionBreakGlass(ctx, sessionId, session.ownerTeamId);
    }
    readable.add(sessionId);
  }
  return readable;
}

/** Hide a run's linked-session details unless its session is readable. */
function redactRunSession(run: AutomationRun, readable: ReadonlySet<string>): AutomationRun {
  if (run.sessionId && readable.has(run.sessionId)) return run;
  return { ...run, sessionId: null, sessionTitle: null, artifactSummary: null };
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
  const readable = await readableRunSessionIds(
    ctx,
    result.invocations.flatMap((invocation) => invocation.runs),
    "exclude"
  );

  return json({
    invocations: result.invocations.map((invocation) => ({
      ...invocation,
      runs: invocation.runs.map((run) => redactRunSession(run, readable)),
    })),
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
  const readable = await readableRunSessionIds(ctx, [result], "audit");
  return json({ run: redactRunSession(result, readable) });
}

export const automationRunRoutes = new Hono<ControlPlaneHonoEnv>();

automationRunRoutes.get("/automations/:id/invocations", AUTOMATION_READ, (c) =>
  dispatch(c, handleListInvocations)
);
automationRunRoutes.get("/automations/:id/runs/:runId", AUTOMATION_READ, (c) =>
  dispatch(c, handleGetRun)
);

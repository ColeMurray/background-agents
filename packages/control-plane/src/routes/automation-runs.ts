/**
 * Automation invocation and run read routes.
 */

import { AutomationStore, toAutomationRun } from "../db/automation-store";
import { Hono } from "hono";
import { dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { type RequestContext, json, error } from "./shared";
import type { Env } from "../types";
import { AUTOMATIONS_READ } from "./automation-shared";

function parseRunListParams(request: Request): { limit: number; offset: number } {
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") || "20") || 20, 100));
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0") || 0);
  return { limit, offset };
}

/** GET /automations/:id/invocations — one row per firing; `total` counts invocations. */
async function handleListInvocations(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const automationId = params.id;

  const store = new AutomationStore(ctx.db);
  const automation = await store.getById(automationId);
  if (!automation) return error("Automation not found", 404);

  const { limit, offset } = parseRunListParams(request);
  const result = await store.listInvocations(automationId, { limit, offset });

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

  return json({ run: toAutomationRun(run) });
}

export const automationRunRoutes = new Hono<ControlPlaneHonoEnv>();

automationRunRoutes.get("/automations/:id/invocations", AUTOMATIONS_READ, (c) =>
  dispatch(c, handleListInvocations)
);
automationRunRoutes.get("/automations/:id/runs/:runId", AUTOMATIONS_READ, (c) =>
  dispatch(c, handleGetRun)
);

/**
 * Automation invocation and run read routes.
 */

import { MAX_AUTOMATION_INVOCATION_LIST_LIMIT } from "@open-inspect/shared/types/automations";
import { AutomationStore, toAutomationRun } from "../db/automation-store";
import { Hono } from "hono";
import { dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { type RequestContext, json, error } from "./shared";
import type { Env } from "../types";
import { z } from "zod";
import { AUTOMATIONS_READ } from "./automation-shared";
import { parseQuery } from "./query";

export const DEFAULT_INVOCATION_LIST_LIMIT = 20;
/** Deepest page the list serves; beyond it an OFFSET scan is unbounded work for no reader. */
export const MAX_INVOCATION_LIST_OFFSET = 10_000;

const invocationListQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^[1-9]\d*$/, { message: "Invalid limit" })
    .optional()
    .transform((raw) => (raw === undefined ? DEFAULT_INVOCATION_LIST_LIMIT : Number(raw)))
    .refine((limit) => limit <= MAX_AUTOMATION_INVOCATION_LIST_LIMIT, {
      message: "Invalid limit",
    }),
  offset: z
    .string()
    .regex(/^\d+$/, { message: "Invalid offset" })
    .optional()
    .transform((raw) => (raw === undefined ? 0 : Number(raw)))
    .refine((offset) => offset <= MAX_INVOCATION_LIST_OFFSET, { message: "Invalid offset" }),
});

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
  const automation = await store.getById(automationId);
  if (!automation) return error("Automation not found", 404);

  const result = await store.listInvocations(automationId, query);

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

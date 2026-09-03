/**
 * Automation listing route.
 */

import { AutomationStore, toAutomation } from "../db/automation-store";
import {
  encodeAutomationListCursor,
  parseAutomationListCursor,
} from "../db/automation-list-cursor";
import { AutomationModelProviderAuthStore } from "../db/automation-model-provider-auth";
import { Hono } from "hono";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { type RequestContext, json } from "./shared";
import type { Env } from "../types";
import { z } from "zod";
import { AUTOMATIONS_READ } from "./automation-shared";
import { parseQuery } from "./query";
import { MAX_NAME_LENGTH } from "./automation-validation";

const RECENT_EXECUTION_COUNT = 10;

const DEFAULT_AUTOMATION_LIST_PAGE_SIZE = 25;

const MAX_AUTOMATION_LIST_PAGE_SIZE = 100;

const automationListLimitSchema = z
  .string()
  .regex(/^\d+$/, { message: "Invalid limit" })
  .transform(Number)
  .refine((limit) => limit >= 1 && limit <= MAX_AUTOMATION_LIST_PAGE_SIZE, {
    message: "Invalid limit",
  });

const automationListQuerySchema = z.object({
  limit: automationListLimitSchema
    .optional()
    .transform((limit) => limit ?? DEFAULT_AUTOMATION_LIST_PAGE_SIZE),
  cursor: z
    .string()
    .optional()
    .transform((raw, context) => {
      const parsed = parseAutomationListCursor(raw ?? null);
      if (!parsed.ok) {
        context.addIssue({ code: "custom", message: parsed.error });
        return z.NEVER;
      }
      return parsed.cursor;
    }),
  search: z.string().trim().max(MAX_NAME_LENGTH, { message: "Search is too long" }).optional(),
  repoOwner: z.string().optional(),
  repoName: z.string().optional(),
});

async function handleListAutomations(
  request: Request,
  env: Env,
  ctx: RequestContext
): Promise<Response> {
  const query = parseQuery(request, automationListQuerySchema);
  if (query instanceof Response) return query;

  const store = new AutomationStore(ctx.db);
  const providerAuthStore = new AutomationModelProviderAuthStore(ctx.db);
  const result = await store.list({
    limit: query.limit,
    cursor: query.cursor,
    ...(query.search ? { nameSearch: query.search } : {}),
    ...(query.repoOwner ? { repoOwner: query.repoOwner } : {}),
    ...(query.repoName ? { repoName: query.repoName } : {}),
  });
  const automationIds = result.automations.map((row) => row.id);
  const [
    repositoriesByAutomation,
    environmentsByAutomation,
    providerAuthByAutomation,
    recentExecutionsByAutomation,
  ] = await Promise.all([
    store.getRepositoriesForAutomationIds(automationIds),
    store.getEnvironmentsForAutomationIds(automationIds),
    providerAuthStore.listForAutomationIds(automationIds),
    store.listRecentExecutionsForAutomationIds(automationIds, RECENT_EXECUTION_COUNT),
  ]);

  const automations = result.automations.map((row) => ({
    ...toAutomation(
      row,
      repositoriesByAutomation.get(row.id) ?? [],
      environmentsByAutomation.get(row.id) ?? [],
      providerAuthByAutomation.get(row.id) ?? []
    ),
    recentExecutions: recentExecutionsByAutomation.get(row.id) ?? [],
  }));
  return json({
    automations,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor ? encodeAutomationListCursor(result.nextCursor) : null,
  });
}

export const automationListRoutes = new Hono<ControlPlaneHonoEnv>();

automationListRoutes.get("/automations", AUTOMATIONS_READ, (c) =>
  handleListAutomations(c.var.admitted.request, c.env, c.var.admitted.ctx)
);

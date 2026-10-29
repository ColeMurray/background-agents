/**
 * Automation listing route.
 */

import { AutomationStore, toAutomation } from "../db/automation-store";
import { dispatch } from "../routing/admit";
import { encodeCreatedAtCursor, parseCreatedAtCursor } from "../created-at-cursor";
import { AutomationModelProviderAuthStore } from "../db/automation-model-provider-auth";
import { Hono } from "hono";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { type RequestContext, json } from "./shared";
import type { Env } from "../types";
import { z } from "zod";
import { AUTOMATIONS_READ_PERMISSION, automationResponseCapabilities } from "./automation-shared";
import { resourceViewer } from "../authorization/resource-viewer";
import { parseQuery } from "./query";
import {
  DEFAULT_AUTOMATION_LIST_PAGE_SIZE,
  MAX_AUTOMATION_LIST_PAGE_SIZE,
  MAX_AUTOMATION_NAME_LENGTH,
} from "@open-inspect/shared/types/automations";

const RECENT_EXECUTION_COUNT = 10;

const automationListLimitSchema = z
  .string()
  .regex(/^\d+$/, { error: "Invalid limit" })
  .transform(Number)
  .refine((limit) => limit >= 1 && limit <= MAX_AUTOMATION_LIST_PAGE_SIZE, {
    error: "Invalid limit",
  });

const automationListQuerySchema = z.object({
  limit: automationListLimitSchema
    .optional()
    .transform((limit) => limit ?? DEFAULT_AUTOMATION_LIST_PAGE_SIZE),
  cursor: z
    .string()
    .optional()
    .transform((raw, context) => {
      const parsed = parseCreatedAtCursor(raw);
      if (!parsed.ok) {
        context.addIssue({ code: "custom", message: parsed.error });
        return z.NEVER;
      }
      return parsed.cursor;
    }),
  search: z
    .string()
    .trim()
    .max(MAX_AUTOMATION_NAME_LENGTH, { error: "Search is too long" })
    .optional(),
  repoOwner: z.string().optional(),
  repoName: z.string().optional(),
  teamId: z
    .string()
    .min(1, { error: "Invalid teamId" })
    .optional()
    .transform((teamId) => (teamId === "null" ? null : teamId)),
});

async function handleListAutomations(
  request: Request,
  env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const query = parseQuery(request, automationListQuerySchema);
  if (query instanceof Response) return query;

  const store = new AutomationStore(ctx.db);
  const providerAuthStore = new AutomationModelProviderAuthStore(ctx.db);
  const viewer = await resourceViewer(ctx);
  const result = await store.list({
    viewer,
    limit: query.limit,
    cursor: query.cursor,
    ...(query.search ? { nameSearch: query.search } : {}),
    ...(query.repoOwner ? { repoOwner: query.repoOwner } : {}),
    ...(query.repoName ? { repoName: query.repoName } : {}),
    ...(query.teamId !== undefined ? { teamId: query.teamId } : {}),
  });
  const rows = await store.projectCanonicalOwners(result.automations);
  const automationIds = rows.map((row) => row.id);
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

  const automations = rows.map((row) => ({
    ...toAutomation(
      row,
      repositoriesByAutomation.get(row.id) ?? [],
      environmentsByAutomation.get(row.id) ?? [],
      providerAuthByAutomation.get(row.id) ?? []
    ),
    capabilities: automationResponseCapabilities(viewer, row),
    recentExecutions: recentExecutionsByAutomation.get(row.id) ?? [],
  }));
  return json({
    automations,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor ? encodeCreatedAtCursor(result.nextCursor) : null,
  });
}

export const automationListRoutes = new Hono<ControlPlaneHonoEnv>();

automationListRoutes.get("/automations", AUTOMATIONS_READ_PERMISSION, (c) =>
  dispatch(c, handleListAutomations)
);

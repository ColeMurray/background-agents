/**
 * Admission shared by the automation route modules.
 */

import { admit } from "../routing/admit";
import { automationCapabilities, type SessionViewer } from "@open-inspect/shared";
import type { AutomationRow } from "../db/automation-store";
import { hydrateAutomation } from "../automation/hydrate";
import {
  type RequestContext,
  GITHUB_USER_OR_SERVICE_ROUTE,
  requireAutomation,
  requirePermission,
  type AutomationRouteAdmission,
} from "./shared";

export function admittedAutomation(ctx: RequestContext): AutomationRouteAdmission {
  if (!ctx.automationAdmission) throw new Error("Missing automation route admission");
  return ctx.automationAdmission;
}

export function automationResponseCapabilities(viewer: SessionViewer, row: AutomationRow) {
  const capabilities = automationCapabilities(viewer, {
    ownerTeamId: row.owner_team_id,
    executorUserId: row.user_id,
  });
  return {
    canRead: capabilities.canRead,
    canManage: capabilities.canManage,
    canTrigger: capabilities.canTrigger,
  };
}

export async function hydrateAutomationResponse(
  ctx: RequestContext,
  row: AutomationRow,
  viewer: SessionViewer
) {
  return {
    ...(await hydrateAutomation(ctx.db, row)),
    ownerTeamId: row.owner_team_id,
    capabilities: automationResponseCapabilities(viewer, row),
  };
}

export const AUTOMATIONS_READ = admit({
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("automations.read", {
    actorlessGrants: [{ service: "slack-bot" }],
  }),
});

export const AUTOMATION_READ = admit({
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  authorization: requireAutomation("read"),
});

/** Admission for routes that change one automation; extend it for per-route response policy. */
export const AUTOMATION_MANAGE_POLICY = {
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  authorization: requireAutomation("manage"),
} as const;

export const AUTOMATION_MANAGE = admit(AUTOMATION_MANAGE_POLICY);

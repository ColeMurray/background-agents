/**
 * Admission shared by the automation route modules.
 */

import { admit } from "../routing/admit";
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

export const AUTOMATIONS_READ = admit({
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("automations.read"),
});

/** Admission for routes that change one automation; extend it for per-route response policy. */
export const AUTOMATION_MANAGE_POLICY = {
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  authorization: requireAutomation("manage"),
} as const;

export const AUTOMATION_MANAGE = admit(AUTOMATION_MANAGE_POLICY);

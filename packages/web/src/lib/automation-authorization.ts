import {
  resolveScopedPermission,
  type EffectiveAuthorization,
  type ScopedPermissionStem,
} from "@open-inspect/shared/rbac";
import type { Automation } from "@open-inspect/shared/types/automations";

/** Checks an automation capability against its canonical owner identity. */
export function canAccessAutomation(
  stem: ScopedPermissionStem,
  authorization: EffectiveAuthorization | null,
  automation: Pick<Automation, "userId">
): boolean {
  if (!authorization) return false;
  const scope = resolveScopedPermission(stem, authorization.permissions);
  return scope === "any" || (scope === "own" && automation.userId === authorization.userId);
}

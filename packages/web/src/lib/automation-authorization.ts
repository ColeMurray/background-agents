import {
  hasScopedPermission,
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
  return hasScopedPermission(
    stem,
    authorization.permissions,
    automation.userId === authorization.userId
  );
}

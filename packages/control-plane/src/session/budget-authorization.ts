import type { EffectiveAuthorization } from "@open-inspect/shared/rbac";

/** Both the API and the browser capability use canonical session ownership. */
export function canManageSessionBudget(
  ownerUserId: string | null | undefined,
  authorization: Pick<EffectiveAuthorization, "userId" | "permissions"> | undefined
): boolean {
  return (
    ownerUserId != null &&
    authorization?.userId === ownerUserId &&
    authorization.permissions.includes("sessions.lifecycle")
  );
}

import type { PermissionId } from "@open-inspect/shared/rbac";

/** Required session capability model shared by the page and every privileged child control. */
export interface SessionCapabilities {
  read: boolean;
  collaborate: boolean;
  lifecycle: boolean;
  sandboxAccess: boolean;
}

export function resolveSessionCapabilities(
  hasPermission: (permission: PermissionId) => boolean
): SessionCapabilities {
  return {
    read: hasPermission("sessions.read"),
    collaborate: hasPermission("sessions.collaborate"),
    lifecycle: hasPermission("sessions.lifecycle"),
    sandboxAccess: hasPermission("sessions.sandbox_access"),
  };
}

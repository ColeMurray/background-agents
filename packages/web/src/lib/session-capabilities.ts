import type { PermissionId } from "@open-inspect/shared/rbac";
import type { SessionCapabilities as ServerSessionCapabilities } from "@open-inspect/shared";

/** Required session capability model shared by the page and every privileged child control. */
export interface SessionCapabilities {
  read: boolean;
  collaborate: boolean;
  lifecycle: boolean;
  delete: boolean;
  move: boolean;
  manageCollaborators: boolean;
  changeVisibility: boolean;
  sandboxAccess: boolean;
  exportTrace: boolean;
}

export function resolveSessionCapabilities(
  hasPermission: (permission: PermissionId) => boolean,
  capabilities?: ServerSessionCapabilities
): SessionCapabilities {
  return {
    read: capabilities?.canRead ?? false,
    collaborate: capabilities?.canCollaborate ?? false,
    lifecycle: capabilities?.canManageLifecycle ?? false,
    delete: capabilities?.canDelete ?? false,
    move: capabilities?.canMove ?? false,
    manageCollaborators: capabilities?.canManageCollaborators ?? false,
    changeVisibility: capabilities?.canChangeVisibility ?? false,
    sandboxAccess: capabilities?.canSandbox ?? false,
    exportTrace: hasPermission("sessions.export"),
  };
}

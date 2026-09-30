import type { SessionCapabilities as ResponseCapabilities } from "@open-inspect/shared";

/** Required session capability model shared by the page and every privileged child control. */
export interface SessionCapabilities {
  read: boolean;
  collaborate: boolean;
  lifecycle: boolean;
  sandboxAccess: boolean;
  exportTrace: boolean;
}

export function resolveSessionCapabilities(
  capabilities: Partial<ResponseCapabilities> | null | undefined,
  canExportTrace = false
): SessionCapabilities {
  return {
    read: capabilities?.canRead === true,
    collaborate: capabilities?.canRead === true && capabilities.canCollaborate === true,
    lifecycle: capabilities?.canRead === true && capabilities.canManageLifecycle === true,
    sandboxAccess: capabilities?.canRead === true && capabilities.canSandbox === true,
    // Export is a workspace permission absent from the session capability contract.
    exportTrace: capabilities?.canRead === true && canExportTrace,
  };
}

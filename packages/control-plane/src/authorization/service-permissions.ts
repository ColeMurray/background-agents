import type { PermissionId } from "@open-inspect/shared/rbac";
import type { ServiceName } from "@open-inspect/shared/service-auth";

const SERVICE_PERMISSION_CEILINGS: Record<ServiceName, readonly PermissionId[]> = {
  web: [],
  "github-bot": [
    "repositories.read",
    "repositories.use",
    "environments.read",
    "environments.use",
    "integrations.read",
    "sessions.create",
    "sessions.read",
    "sessions.collaborate",
    "sessions.lifecycle",
    "skills.read",
  ],
  "slack-bot": [
    "automations.read",
    "repositories.read",
    "repositories.use",
    "environments.read",
    "environments.use",
    "integrations.read",
    "sessions.create",
    "sessions.read",
    "sessions.collaborate",
    "sessions.lifecycle",
    "sessions.sandbox_access",
    "skills.read",
  ],
  "linear-bot": [
    "repositories.read",
    "repositories.use",
    "environments.read",
    "environments.use",
    "integrations.read",
    "sessions.create",
    "sessions.read",
    "sessions.collaborate",
    "sessions.lifecycle",
    "skills.read",
  ],
};

/** Checks the hard permission ceiling for a trusted service, independent of user grants. */
export function serviceAllowsPermission(service: ServiceName, permission: PermissionId): boolean {
  return SERVICE_PERMISSION_CEILINGS[service].includes(permission);
}

import type { PermissionId } from "@open-inspect/shared/rbac";
import type { ServiceName } from "@open-inspect/shared/service-auth";

const SERVICE_PERMISSION_CEILINGS: Record<ServiceName, readonly PermissionId[]> = {
  web: [],
  "github-bot": [
    "repositories.read",
    "repositories.use",
    "environments.read",
    "environments.use",
    "sessions.create",
    "sessions.read.own",
    "sessions.collaborate.own",
    "sessions.lifecycle.own",
    "skills.read",
  ],
  "slack-bot": [
    "repositories.read",
    "repositories.use",
    "environments.read",
    "environments.use",
    "sessions.create",
    "sessions.read.own",
    "sessions.collaborate.own",
    "sessions.lifecycle.own",
    "sessions.sandbox_access.own",
    "skills.read",
  ],
  "linear-bot": [
    "repositories.read",
    "repositories.use",
    "environments.read",
    "environments.use",
    "sessions.create",
    "sessions.read.own",
    "sessions.collaborate.own",
    "sessions.lifecycle.own",
    "skills.read",
  ],
};

export function serviceAllowsPermission(service: ServiceName, permission: PermissionId): boolean {
  return SERVICE_PERMISSION_CEILINGS[service].includes(permission);
}

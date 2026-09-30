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
  // Agent World dispatches single-repository quests and observes their runs.
  // Environments, integrations, and sandbox access stay outside its ceiling.
  "agent-world": [
    "repositories.read",
    "repositories.use",
    "sessions.create",
    "sessions.read",
    "sessions.collaborate",
    "sessions.lifecycle",
    "skills.read",
  ],
};

/**
 * Exact routes (`METHOD /pattern`) a service may call, checked in addition to
 * its permission ceiling. Permissions are bundles: `sessions.collaborate` also
 * admits pull-request creation and Slack notifications. A service that must
 * stay narrower than any bundle gets an explicit list, so routes added to a
 * bundle later stay closed to it. Services without a list are unaffected.
 */
const SERVICE_ROUTE_ALLOWLISTS: Partial<Record<ServiceName, ReadonlySet<string>>> = {
  "agent-world": new Set([
    "GET /repos",
    "POST /sessions",
    "GET /sessions/:id/events",
    "GET /sessions/:id/artifacts",
    "GET /sessions/:id/messages",
    "POST /sessions/:id/prompt",
    "POST /sessions/:id/stop",
  ]),
};

/** The explicit route allowlist for a service, or null when it has none. */
export function serviceRouteAllowlist(service: ServiceName): ReadonlySet<string> | null {
  return SERVICE_ROUTE_ALLOWLISTS[service] ?? null;
}

/** Whether a service may call the route identified by `METHOD /pattern`. */
export function serviceAllowsRoute(service: ServiceName, routeKey: string): boolean {
  const allowlist = SERVICE_ROUTE_ALLOWLISTS[service];
  return allowlist === undefined || allowlist.has(routeKey);
}

/** Checks the hard permission ceiling for a trusted service, independent of user grants. */
export function serviceAllowsPermission(service: ServiceName, permission: PermissionId): boolean {
  return SERVICE_PERMISSION_CEILINGS[service].includes(permission);
}

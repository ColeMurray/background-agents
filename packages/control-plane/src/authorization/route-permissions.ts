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

export type SessionUserOperation =
  | "read"
  | "collaborate"
  | "lifecycle"
  | "participants.manage"
  | "sandbox_access"
  | "delete";

export function sessionUserOperation(
  method: string,
  path: string
): { sessionId: string; operation: SessionUserOperation } | null {
  const match = path.match(/^\/sessions\/([^/]+)(?:\/(.*))?$/);
  if (!match || match[1] === "inbox") return null;
  let sessionId = decodeURIComponent(match[1]);
  const suffix = match[2] ?? "";
  const childMatch = suffix.match(/^children\/([^/]+)(?:\/|$)/);
  if (childMatch) sessionId = decodeURIComponent(childMatch[1]);

  if (method === "DELETE" && suffix === "") return { sessionId, operation: "delete" };
  if (method === "GET") {
    return {
      sessionId,
      operation:
        suffix === "sandbox-access" || suffix === "tunnel-urls" ? "sandbox_access" : "read",
    };
  }
  if (method === "PATCH" && suffix === "read-state") return { sessionId, operation: "read" };
  if (method === "POST" && suffix === "participants") {
    return { sessionId, operation: "participants.manage" };
  }
  if (
    (method === "PATCH" && suffix === "title") ||
    (method === "POST" &&
      (suffix === "stop" ||
        suffix === "archive" ||
        suffix === "unarchive" ||
        suffix === "diff/retry" ||
        suffix === "pull-requests/refresh" ||
        suffix.endsWith("/cancel")))
  ) {
    return { sessionId, operation: "lifecycle" };
  }
  if (method === "POST" || (method === "PUT" && suffix === "diff")) {
    return { sessionId, operation: "collaborate" };
  }
  return null;
}

export function staticUserPermission(method: string, path: string): PermissionId | null {
  if (/^\/repos\/[^/]+\/[^/]+\/secrets(?:\/|$)/.test(path)) {
    return "repositories.secrets.manage";
  }
  if (path === "/secrets" || path.startsWith("/secrets/")) return "global_secrets.manage";

  if (/^\/repos(?:\/|$)/.test(path)) {
    return method === "PUT" ? "repositories.settings.manage" : "repositories.read";
  }
  if (/^\/environments\/[^/]+\/secrets(?:\/|$)/.test(path)) {
    return "environments.secrets.manage";
  }
  if (/^\/environments(?:\/|$)/.test(path)) {
    return method === "GET" ? "environments.read" : "environments.manage";
  }

  if (path.startsWith("/image-builds/trigger/environment/")) {
    return "environments.images.manage";
  }
  if (
    path.startsWith("/image-builds/trigger/repo/") ||
    path.startsWith("/image-builds/toggle/repo/")
  ) {
    return "repositories.images.manage";
  }
  if (
    path === "/image-builds/status" ||
    path === "/image-builds/enabled" ||
    path === "/image-builds/enabled-repos"
  ) {
    return "image_builds.read";
  }

  if (path === "/model-preferences" && method !== "GET") {
    return "models.preferences.manage";
  }
  if (
    path.startsWith("/model-provider-accounts") ||
    path.startsWith("/model-provider-account-defaults")
  ) {
    return method === "GET" ? "provider_accounts.read" : "provider_accounts.manage";
  }

  if (
    method === "GET" &&
    (path === "/integration-settings/slack/channels" ||
      path === "/integration-settings/slack/watched-channels")
  ) {
    return "automations.read";
  }
  if (path.startsWith("/integration-settings/")) {
    if (method === "GET") return "integrations.read";
    if (/\/repos\/[^/]+\/[^/]+$/.test(path)) return "repositories.settings.manage";
    if (/\/environments\/[^/]+$/.test(path)) return "environments.settings.manage";
    return "integrations.manage";
  }
  if (path.startsWith("/scm-settings")) {
    return method === "GET" ? "integrations.read" : "scm_settings.manage";
  }
  if (path === "/commit-signing") {
    return method === "GET" ? "integrations.read" : "commit_signing.manage";
  }

  if (path === "/mcp-servers" || path.startsWith("/mcp-servers/")) {
    return method === "GET" ? "mcp_servers.read" : "mcp_servers.manage";
  }
  if (path.startsWith("/analytics/")) return "analytics.read";

  if (path === "/skills" || path.startsWith("/skills/")) {
    if (method === "GET" || path === "/skills/preview" || path === "/skills/resolve-preview") {
      return "skills.read";
    }
    return "skills.manage";
  }
  if (path === "/skill-profiles" || path.startsWith("/skill-profiles/")) {
    return "skill_profiles.manage_own";
  }

  if (path === "/automations" && method === "POST") return "automations.create";
  if (path.startsWith("/automations") && method === "GET") return "automations.read";
  if (path === "/sessions" && method === "POST") return "sessions.create";
  if (method === "POST" && /^\/sessions\/[^/]+\/children$/.test(path)) {
    return "sessions.create";
  }

  return null;
}

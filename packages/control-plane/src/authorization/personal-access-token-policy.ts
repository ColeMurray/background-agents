/**
 * Where personal access tokens may act, and with what authority.
 *
 * Two independent conditions bound a token, and both must hold:
 *
 * - The route accepts tokens. Reach is opt-in per route (`personalAccessTokens: "accept"`), so a
 *   route added later is closed to tokens until someone decides otherwise, and a token's reach
 *   never follows from which other principals a route happens to accept.
 * - The token holds the permission the route requires. Admission replaces the owner's permissions
 *   with their intersection with the token's grant, so every permission check downstream narrows
 *   without knowing tokens exist.
 *
 * For the second condition to mean anything, a route that accepts tokens must be gated by at least
 * one permission a token can be granted. `personalAccessTokenRouteViolation` holds every opted-in
 * route to that when the app is built.
 *
 * Workspace-role visibility is not narrowed: an administrator's token holding `sessions.read` sees
 * the sessions its owner sees. The grant decides which kinds of resource a token reaches; the
 * owner's role still decides how many of them.
 */

import type { EffectiveAuthorization, PermissionId } from "@open-inspect/shared/rbac";
import { isPersonalAccessTokenGrantable } from "@open-inspect/shared/types/personal-access-tokens";
import type { SessionAction } from "@open-inspect/shared";
import type { RouteAdmissionPolicy, RouteAuthorizationRequirement } from "../routes/shared";

/** Route authentication kinds that verify the credentials a token is presented with. */
const TOKEN_AUTHENTICATIONS: ReadonlySet<RouteAdmissionPolicy["authentication"]["kind"]> = new Set([
  "user",
  "user-or-service",
  "user-or-service-with-sandbox-fallback",
]);

/**
 * The permission each session action requires beyond read visibility. Collaborator and
 * visibility management are decided by ownership alone, so no grant can narrow them.
 */
const SESSION_ACTION_PERMISSIONS: Record<SessionAction, PermissionId | null> = {
  read: "sessions.read",
  collaborate: "sessions.collaborate",
  lifecycle: "sessions.lifecycle",
  sandbox: "sessions.sandbox_access",
  delete: "sessions.delete",
  manageCollaborators: null,
  changeVisibility: null,
};

/**
 * The permissions a requirement can be satisfied by, any one of which suffices. Empty when the
 * requirement is decided by membership or ownership rather than by a permission.
 */
export function requirementPermissions(
  requirement: RouteAuthorizationRequirement
): readonly PermissionId[] {
  switch (requirement.kind) {
    case "permission":
      return [requirement.permission];
    case "session": {
      const permission = SESSION_ACTION_PERMISSIONS[requirement.action];
      return permission ? [permission] : [];
    }
    case "automation":
      if (requirement.operation === "read") return ["automations.read"];
      return requirement.operation === "manage"
        ? ["automations.manage.any", "automations.manage.own"]
        : ["automations.trigger.any", "automations.trigger.own"];
    case "environment":
      return [`environments.${requirement.need}` as const];
    case "team":
      return [];
  }
}

/**
 * Why a route policy may not accept personal access tokens, or null when it may. A route that
 * declares `personalAccessTokens: "accept"` must authenticate the bearer, authorize an active
 * user, and require at least one permission, every one of which a token can be granted.
 */
export function personalAccessTokenRouteViolation(policy: RouteAdmissionPolicy): string | null {
  if (!TOKEN_AUTHENTICATIONS.has(policy.authentication.kind)) {
    return `authentication "${policy.authentication.kind}" never verifies a personal access token`;
  }
  if (policy.authorization.kind !== "active-user") {
    return `authorization "${policy.authorization.kind}" requires no permission a grant could narrow`;
  }
  const permissions = policy.authorization.allOf.flatMap(requirementPermissions);
  if (permissions.length === 0) {
    return "no requirement is decided by a permission, so a grant could not narrow it";
  }
  const withheld = permissions.find((permission) => !isPersonalAccessTokenGrantable(permission));
  if (withheld) {
    return `it requires "${withheld}", which is withheld from personal access tokens`;
  }
  return null;
}

/**
 * The authority a token acts with: its owner's authorization, with permissions narrowed to those
 * the token was granted and that remain grantable. Suspension and role are the owner's.
 */
export function restrictAuthorizationToGrant(
  authorization: EffectiveAuthorization,
  grant: readonly PermissionId[]
): EffectiveAuthorization {
  const granted = new Set(grant);
  return {
    ...authorization,
    permissions: authorization.permissions.filter(
      (permission) => granted.has(permission) && isPersonalAccessTokenGrantable(permission)
    ),
  };
}

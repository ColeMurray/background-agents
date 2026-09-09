import { z } from "zod";
import { isCanonicalUserId } from "./user-id";

/** Stable identities for system-defined roles that cannot be replaced by custom roles. */
export const BUILT_IN_ROLE_REGISTRY = {
  owner: {
    id: "role_builtin_owner",
    key: "owner",
  },
  administrator: {
    id: "role_builtin_administrator",
    key: "administrator",
  },
  member: {
    id: "role_builtin_member",
    key: "member",
  },
  viewer: {
    id: "role_builtin_viewer",
    key: "viewer",
  },
} as const;

/** A key identifying one of the workspace's system-defined roles. */
export type BuiltInRoleKey = keyof typeof BUILT_IN_ROLE_REGISTRY;
/** Built-in role keys in canonical registry order. */
export const BUILT_IN_ROLE_KEYS = Object.keys(BUILT_IN_ROLE_REGISTRY) as BuiltInRoleKey[];
/** Stable IDs reserved for system-defined roles. */
export const BUILT_IN_ROLE_IDS = Object.values(BUILT_IN_ROLE_REGISTRY).map((role) => role.id);

/** Canonical permission identifiers accepted by the RBAC policy and persistence layers. */
export const PERMISSION_IDS = [
  "analytics.read",
  "automations.create",
  "automations.manage.any",
  "automations.manage.own",
  "automations.read",
  "automations.trigger.any",
  "automations.trigger.own",
  "commit_signing.manage",
  "environments.images.manage",
  "environments.manage",
  "environments.read",
  "environments.secrets.manage",
  "environments.settings.manage",
  "environments.use",
  "global_secrets.manage",
  "image_builds.read",
  "integrations.manage",
  "integrations.read",
  "mcp_servers.manage",
  "mcp_servers.read",
  "models.preferences.manage",
  "provider_accounts.manage",
  "provider_accounts.read",
  "repositories.images.manage",
  "repositories.read",
  "repositories.secrets.manage",
  "repositories.settings.manage",
  "repositories.use",
  "scm_settings.manage",
  "sessions.collaborate",
  "sessions.create",
  "sessions.delete",
  "sessions.lifecycle",
  "sessions.read",
  "sessions.sandbox_access",
  "skill_profiles.manage_own",
  "skills.manage",
  "skills.read",
  "workspace.audit.read",
  "workspace.members.manage",
  "workspace.members.read",
  "workspace.roles.read",
  "workspace.transfer_ownership",
] as const;

/** A permission identifier recognized by the RBAC policy. */
export type PermissionId = (typeof PERMISSION_IDS)[number];

/** Permission required to admit a browser WebSocket to the read synchronization protocol. */
export const SESSION_WEBSOCKET_CONNECT_PERMISSION = "sessions.read" as const satisfies PermissionId;

/** Maps ownership-sensitive capabilities to their workspace-wide and owner-only grants. */
export const SCOPED_PERMISSION_PAIRS = {
  "automations.manage": {
    any: "automations.manage.any",
    own: "automations.manage.own",
  },
  "automations.trigger": {
    any: "automations.trigger.any",
    own: "automations.trigger.own",
  },
} as const satisfies Record<string, { any: PermissionId; own: PermissionId }>;

/** A capability whose effective grant depends on resource ownership. */
export type ScopedPermissionStem = keyof typeof SCOPED_PERMISSION_PAIRS;
/** The resource ownership boundary granted for a scoped capability. */
export type PermissionScope = "any" | "own";

/** Resolves the strongest granted scope for a capability, preferring workspace-wide access. */
export function resolveScopedPermission(
  stem: ScopedPermissionStem,
  permissions: readonly PermissionId[]
): PermissionScope | null {
  const pair = SCOPED_PERMISSION_PAIRS[stem];
  if (permissions.includes(pair.any)) return "any";
  if (permissions.includes(pair.own)) return "own";
  return null;
}

/** Decides a scoped resource capability from grants plus the caller's ownership result. */
export function hasScopedPermission(
  stem: ScopedPermissionStem,
  permissions: readonly PermissionId[],
  isOwner: boolean
): boolean {
  const scope = resolveScopedPermission(stem, permissions);
  return scope === "any" || (scope === "own" && isOwner);
}

const VIEWER_PERMISSIONS = new Set<PermissionId>([
  "analytics.read",
  "automations.read",
  "environments.read",
  "image_builds.read",
  "mcp_servers.read",
  "repositories.read",
  "sessions.read",
  "skills.read",
]);

const MEMBER_PERMISSIONS = new Set<PermissionId>([
  ...VIEWER_PERMISSIONS,
  "automations.create",
  "automations.manage.own",
  "automations.trigger.own",
  "environments.use",
  "provider_accounts.read",
  "repositories.use",
  "sessions.collaborate",
  "sessions.create",
  "sessions.delete",
  "sessions.lifecycle",
  "sessions.sandbox_access",
  "skill_profiles.manage_own",
]);

/** Validates permission identifiers at API and storage boundaries. */
export const permissionIdSchema = z.enum(PERMISSION_IDS);
/** Validates keys for system-defined roles. */
export const builtInRoleKeySchema = z.enum(BUILT_IN_ROLE_KEYS);

/** Returns the canonical effective grants for a system-defined role. */
export function permissionsForBuiltInRole(role: BuiltInRoleKey): PermissionId[] {
  if (role === "owner") return [...PERMISSION_IDS];
  if (role === "administrator") {
    return PERMISSION_IDS.filter((permission) => permission !== "workspace.transfer_ownership");
  }
  const permissions = role === "member" ? MEMBER_PERMISSIONS : VIEWER_PERMISSIONS;
  return PERMISSION_IDS.filter((permission) => permissions.has(permission));
}

/** Narrows untrusted permission text to the canonical permission registry. */
export function isRegisteredPermission(value: string): value is PermissionId {
  return (PERMISSION_IDS as readonly string[]).includes(value);
}

/** Reports whether a permission may be delegated through a custom role. */
export function isCustomRolePermission(permission: PermissionId): boolean {
  return permission !== "workspace.transfer_ownership";
}

const roleNameSchema = z.string().min(1);
const roleReferenceShape = {
  id: z.string().min(1),
  key: builtInRoleKeySchema.nullable(),
  name: roleNameSchema,
};

function validateRoleIdentity(
  role: { id: string; key: BuiltInRoleKey | null },
  context: z.RefinementCtx
): void {
  if (role.key === null) {
    if ((BUILT_IN_ROLE_IDS as readonly string[]).includes(role.id)) {
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "Built-in role IDs require their canonical key",
      });
    }
    return;
  }
  if (role.id !== BUILT_IN_ROLE_REGISTRY[role.key].id) {
    context.addIssue({
      code: "custom",
      path: ["id"],
      message: "Built-in role keys require their canonical ID",
    });
  }
}

/** Validates the role identity embedded in authorization responses. */
export const roleReferenceSchema = z
  .object(roleReferenceShape)
  .strict()
  .superRefine(validateRoleIdentity);

/** Validates an administrative role view with effective grants and assignment count. */
export const roleSummarySchema = z
  .object({
    ...roleReferenceShape,
    description: z.string().nullable(),
    permissions: z.array(permissionIdSchema),
    assignmentCount: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine(validateRoleIdentity);

/** Validates a user's role, suspension state, and currently effective permissions. */
export const effectiveAuthorizationSchema = z
  .object({
    userId: z.string().refine(isCanonicalUserId, "Invalid canonical user ID"),
    suspendedAt: z.number().int().nonnegative().nullable(),
    role: roleReferenceSchema,
    permissions: z.array(permissionIdSchema),
  })
  .strict();

/** Validates the member record exposed by workspace administration APIs. */
export const workspaceMemberSchema = z
  .object({
    userId: z.string().refine(isCanonicalUserId, "Invalid canonical user ID"),
    displayName: z.string().nullable(),
    email: z.string().nullable(),
    suspendedAt: z.number().int().nonnegative().nullable(),
    role: roleReferenceSchema,
  })
  .strict();

/** Validates the complete role-list response. */
export const roleListResponseSchema = z.array(roleSummarySchema);
/** Validates the complete workspace-member-list response. */
export const workspaceMemberListResponseSchema = z.array(workspaceMemberSchema);

/** Validates a request to atomically replace a member's assigned role. */
export const replaceMemberRoleInputSchema = z
  .object({
    roleId: z.string().min(1),
  })
  .strict();

/** Validates a request to suspend or reactivate a workspace member. */
export const replaceMemberStatusInputSchema = z
  .object({
    suspended: z.boolean(),
  })
  .strict();

/** Administrative role data with effective grants and current assignment count. */
export type RoleSummary = z.infer<typeof roleSummarySchema>;
/** A built-in or custom role identity with canonical ID/key pairing. */
export type RoleReference = z.infer<typeof roleReferenceSchema>;
/** The authorization state used to make permission decisions for a user. */
export type EffectiveAuthorization = z.infer<typeof effectiveAuthorizationSchema>;
/** A workspace member and their current RBAC assignment state. */
export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;

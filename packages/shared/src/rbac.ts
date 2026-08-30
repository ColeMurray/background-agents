import { z } from "zod";
import { isCanonicalUserId } from "./user-id";

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

export type BuiltInRoleKey = keyof typeof BUILT_IN_ROLE_REGISTRY;
export const BUILT_IN_ROLE_KEYS = Object.keys(BUILT_IN_ROLE_REGISTRY) as BuiltInRoleKey[];

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
  "sessions.collaborate.any",
  "sessions.collaborate.own",
  "sessions.create",
  "sessions.delete.any",
  "sessions.delete.own",
  "sessions.lifecycle.any",
  "sessions.lifecycle.own",
  "sessions.participants.manage.any",
  "sessions.participants.manage.own",
  "sessions.read.any",
  "sessions.read.own",
  "sessions.sandbox_access.any",
  "sessions.sandbox_access.own",
  "skill_profiles.manage_own",
  "skills.manage",
  "skills.read",
  "workspace.members.manage",
  "workspace.members.read",
  "workspace.roles.manage",
  "workspace.roles.read",
  "workspace.transfer_ownership",
] as const;

export type PermissionId = (typeof PERMISSION_IDS)[number];
const MEMBER_PERMISSIONS = new Set<PermissionId>([
  "automations.create",
  "automations.manage.own",
  "automations.read",
  "automations.trigger.own",
  "environments.read",
  "environments.use",
  "mcp_servers.read",
  "provider_accounts.read",
  "repositories.read",
  "repositories.use",
  "sessions.collaborate.any",
  "sessions.create",
  "sessions.delete.own",
  "sessions.lifecycle.own",
  "sessions.participants.manage.own",
  "sessions.read.any",
  "sessions.sandbox_access.own",
  "skill_profiles.manage_own",
  "skills.read",
]);

const VIEWER_PERMISSIONS = new Set<PermissionId>([
  "automations.read",
  "environments.read",
  "image_builds.read",
  "mcp_servers.read",
  "repositories.read",
  "sessions.read.any",
  "skill_profiles.manage_own",
  "skills.read",
]);

export const permissionIdSchema = z.enum(PERMISSION_IDS);
export const builtInRoleKeySchema = z.enum(BUILT_IN_ROLE_KEYS);

export function permissionsForBuiltInRole(role: BuiltInRoleKey): PermissionId[] {
  if (role === "owner") return [...PERMISSION_IDS];
  if (role === "administrator") {
    return PERMISSION_IDS.filter((permission) => permission !== "workspace.transfer_ownership");
  }
  const permissions = role === "member" ? MEMBER_PERMISSIONS : VIEWER_PERMISSIONS;
  return PERMISSION_IDS.filter((permission) => permissions.has(permission));
}

export function isRegisteredPermission(value: string): value is PermissionId {
  return (PERMISSION_IDS as readonly string[]).includes(value);
}

export function normalizeRoleName(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

const customPermissionsSchema = z
  .array(permissionIdSchema)
  .max(PERMISSION_IDS.length)
  .refine((values) => new Set(values).size === values.length, "Permissions must be unique")
  .refine(
    (values) => !values.includes("workspace.transfer_ownership"),
    "Ownership transfer is reserved for the Owner role"
  );

export const roleReferenceSchema = z
  .object({
    id: z.string().min(1),
    key: builtInRoleKeySchema.nullable(),
    name: z.string().min(1),
  })
  .strict();

export const roleSummarySchema = roleReferenceSchema.extend({
  description: z.string().nullable(),
  isSystem: z.boolean(),
  revision: z.number().int().positive(),
  permissions: z.array(permissionIdSchema),
  assignmentCount: z.number().int().nonnegative(),
});

export const effectiveAuthorizationSchema = z
  .object({
    userId: z.string().refine(isCanonicalUserId, "Invalid canonical user ID"),
    suspendedAt: z.number().int().nonnegative().nullable(),
    role: roleReferenceSchema,
    permissions: z.array(permissionIdSchema),
  })
  .strict();

export const workspaceMemberSchema = z
  .object({
    userId: z.string().refine(isCanonicalUserId, "Invalid canonical user ID"),
    displayName: z.string().nullable(),
    email: z.string().nullable(),
    suspendedAt: z.number().int().nonnegative().nullable(),
    role: roleReferenceSchema,
  })
  .strict();

export const roleListResponseSchema = z.array(roleSummarySchema);
export const workspaceMemberListResponseSchema = z.array(workspaceMemberSchema);

const roleMutationFields = {
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 _-]*$/, "Role names use letters, numbers, spaces, _ or -"),
  description: z.string().trim().max(500).nullable().optional(),
  permissions: customPermissionsSchema,
} as const;

export const createRoleInputSchema = z.object(roleMutationFields).strict();
export const replaceRoleInputSchema = z.object(roleMutationFields).strict();

export const replaceMemberRoleInputSchema = z
  .object({
    roleId: z.string().min(1),
  })
  .strict();

export const replaceMemberStatusInputSchema = z
  .object({
    suspended: z.boolean(),
  })
  .strict();

export type RoleSummary = z.infer<typeof roleSummarySchema>;
export type EffectiveAuthorization = z.infer<typeof effectiveAuthorizationSchema>;
export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;

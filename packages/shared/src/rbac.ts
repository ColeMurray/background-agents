import { z } from "zod";
import { isCanonicalUserId } from "./user-id";

export const BUILT_IN_ROLE_REGISTRY = {
  owner: {
    id: "role_builtin_owner",
    key: "owner",
    name: "Owner",
    description: "Full workspace control",
  },
  administrator: {
    id: "role_builtin_administrator",
    key: "administrator",
    name: "Administrator",
    description: "Operational administration without ownership transfer",
  },
  member: {
    id: "role_builtin_member",
    key: "member",
    name: "Member",
    description: "Session and automation collaboration",
  },
  viewer: {
    id: "role_builtin_viewer",
    key: "viewer",
    name: "Viewer",
    description: "Read-only workspace visibility",
  },
} as const;

export type BuiltInRoleKey = keyof typeof BUILT_IN_ROLE_REGISTRY;
export const BUILT_IN_ROLE_KEYS = Object.keys(BUILT_IN_ROLE_REGISTRY) as BuiltInRoleKey[];

export const PERMISSION_IDS = [
  "analytics.read",
  "audit.read",
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
  "workspace.read",
  "workspace.roles.manage",
  "workspace.roles.read",
  "workspace.transfer_ownership",
] as const;

export type PermissionId = (typeof PERMISSION_IDS)[number];
export type PermissionCategory =
  | "workspace"
  | "repositories"
  | "sessions"
  | "automations"
  | "configuration"
  | "extensibility";
export type PermissionSensitivity = "standard" | "sensitive" | "critical";

export interface PermissionDefinition {
  id: PermissionId;
  label: string;
  description: string;
  category: PermissionCategory;
  sensitivity: PermissionSensitivity;
  builtInRoles: readonly BuiltInRoleKey[];
}

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
  "workspace.read",
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
  "workspace.read",
]);

const SENSITIVE_PERMISSIONS = new Set<PermissionId>([
  "commit_signing.manage",
  "environments.secrets.manage",
  "global_secrets.manage",
  "integrations.manage",
  "mcp_servers.manage",
  "provider_accounts.manage",
  "repositories.secrets.manage",
  "scm_settings.manage",
  "skills.manage",
  "workspace.members.manage",
  "workspace.roles.manage",
]);

function categoryFor(permission: PermissionId): PermissionCategory {
  if (permission.startsWith("workspace.") || permission === "audit.read") return "workspace";
  if (permission.startsWith("repositories.") || permission.startsWith("environments.")) {
    return "repositories";
  }
  if (permission.startsWith("sessions.")) return "sessions";
  if (permission.startsWith("automations.") || permission === "analytics.read") {
    return "automations";
  }
  if (
    permission.startsWith("skills.") ||
    permission.startsWith("skill_profiles.") ||
    permission.startsWith("mcp_servers.")
  ) {
    return "extensibility";
  }
  return "configuration";
}

function builtInRolesFor(permission: PermissionId): readonly BuiltInRoleKey[] {
  const roles: BuiltInRoleKey[] = ["owner"];
  if (permission !== "workspace.transfer_ownership") roles.push("administrator");
  if (MEMBER_PERMISSIONS.has(permission)) roles.push("member");
  if (VIEWER_PERMISSIONS.has(permission)) roles.push("viewer");
  return roles;
}

function displayPermission(permission: PermissionId): string {
  return permission
    .split(/[._]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export const PERMISSION_REGISTRY = Object.fromEntries(
  PERMISSION_IDS.map((permission) => [
    permission,
    {
      id: permission,
      label: displayPermission(permission),
      description: `Allows ${permission.replaceAll("_", " ").replaceAll(".", " ")}.`,
      category: categoryFor(permission),
      sensitivity:
        permission === "workspace.transfer_ownership"
          ? "critical"
          : SENSITIVE_PERMISSIONS.has(permission)
            ? "sensitive"
            : "standard",
      builtInRoles: builtInRolesFor(permission),
    },
  ])
) as Readonly<Record<PermissionId, PermissionDefinition>>;

export const permissionIdSchema = z.enum(PERMISSION_IDS);
export const builtInRoleKeySchema = z.enum(BUILT_IN_ROLE_KEYS);
export const workspaceAccessStatusSchema = z.enum(["active", "suspended"]);

export function permissionsForBuiltInRole(role: BuiltInRoleKey): PermissionId[] {
  return PERMISSION_IDS.filter((permission) =>
    PERMISSION_REGISTRY[permission].builtInRoles.includes(role)
  );
}

export function isRegisteredPermission(value: string): value is PermissionId {
  return Object.hasOwn(PERMISSION_REGISTRY, value);
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
    accessStatus: workspaceAccessStatusSchema,
    role: roleReferenceSchema.nullable(),
    permissions: z.array(permissionIdSchema),
    authorizationVersion: z.number().int().positive(),
  })
  .strict();

export const workspaceMemberSchema = z
  .object({
    userId: z.string().refine(isCanonicalUserId, "Invalid canonical user ID"),
    displayName: z.string().nullable(),
    email: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    accessStatus: workspaceAccessStatusSchema,
    authorizationVersion: z.number().int().positive(),
    role: roleReferenceSchema,
    createdAt: z.number().int().nonnegative(),
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
    authorizationVersion: z.number().int().positive(),
  })
  .strict();

export const replaceMemberStatusInputSchema = z
  .object({
    accessStatus: workspaceAccessStatusSchema,
    authorizationVersion: z.number().int().positive(),
  })
  .strict();

export type WorkspaceAccessStatus = z.infer<typeof workspaceAccessStatusSchema>;
export type RoleReference = z.infer<typeof roleReferenceSchema>;
export type RoleSummary = z.infer<typeof roleSummarySchema>;
export type EffectiveAuthorization = z.infer<typeof effectiveAuthorizationSchema>;
export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;
export type CreateRoleInput = z.infer<typeof createRoleInputSchema>;
export type ReplaceRoleInput = z.infer<typeof replaceRoleInputSchema>;

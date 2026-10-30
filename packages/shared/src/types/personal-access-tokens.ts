/**
 * Personal access tokens: credentials a user issues to themselves so a local tool (the MCP server,
 * a script) can call the control plane as them.
 *
 * A token carries an explicit grant of RBAC permissions chosen when it is issued. On every request
 * the token acts with the intersection of that grant and its owner's current permissions, so it
 * can never exceed what its owner may do, and it loses a permission the moment its owner does.
 *
 * The plaintext token exists only in the response to the call that created it and wherever the
 * user pastes it. The control plane stores a SHA-256 hash, so a database read cannot recover a
 * working credential.
 */

import { z } from "zod";
import { PERMISSION_IDS, permissionIdSchema, type PermissionId } from "../rbac";

/**
 * Marks a string as one of ours on sight, so a leaked token is recognizable in a log or a paste
 * and can be revoked without guesswork.
 */
export const PERSONAL_ACCESS_TOKEN_PREFIX = "oi_pat_";

/** Random bytes behind the prefix: 256 bits, hex-encoded. */
export const PERSONAL_ACCESS_TOKEN_RANDOM_BYTES = 32;

/**
 * Leading characters of the secret kept in cleartext for display. Enough to tell two tokens apart
 * in a list, far too few to narrow a brute force.
 */
export const PERSONAL_ACCESS_TOKEN_DISPLAY_CHARS = 6;

const PERSONAL_ACCESS_TOKEN_PATTERN = new RegExp(
  `^${PERSONAL_ACCESS_TOKEN_PREFIX}[0-9a-f]{${PERSONAL_ACCESS_TOKEN_RANDOM_BYTES * 2}}$`
);

/** Whether a string is shaped like a personal access token, before any lookup. */
export function isPersonalAccessTokenFormat(value: string): boolean {
  return PERSONAL_ACCESS_TOKEN_PATTERN.test(value);
}

/**
 * Whether each permission may appear in a token's grant.
 *
 * Exhaustive over `PermissionId`, so adding a permission does not compile until someone decides
 * whether a credential that lives outside the browser may hold it. Tokens are for working with
 * sessions, automations, skills, repositories, and environments. Workspace administration —
 * membership, roles, secrets, integrations, provider accounts, and deployment configuration — is
 * withheld: a long-lived bearer credential is the wrong place for those, and none of them is
 * needed to read or drive work. Withholding a permission later also disables it in every grant
 * that already names it.
 */
export const PERSONAL_ACCESS_TOKEN_GRANTABILITY = {
  "analytics.read": "grantable",
  "automations.create": "grantable",
  "automations.manage.any": "grantable",
  "automations.manage.own": "grantable",
  "automations.read": "grantable",
  "automations.trigger.any": "grantable",
  "automations.trigger.own": "grantable",
  "commit_signing.manage": "withheld",
  "environments.images.manage": "withheld",
  "environments.manage": "withheld",
  "environments.read": "grantable",
  "environments.secrets.manage": "withheld",
  "environments.settings.manage": "withheld",
  "environments.use": "grantable",
  "global_secrets.manage": "withheld",
  "image_builds.read": "grantable",
  "integrations.manage": "withheld",
  "integrations.read": "grantable",
  "mcp_servers.manage": "withheld",
  "mcp_servers.read": "grantable",
  "memories.manage_own": "grantable",
  "models.preferences.manage": "withheld",
  "provider_accounts.manage": "withheld",
  "provider_accounts.read": "grantable",
  "repositories.images.manage": "withheld",
  "repositories.read": "grantable",
  "repositories.secrets.manage": "withheld",
  "repositories.settings.manage": "withheld",
  "repositories.use": "grantable",
  "scm_settings.manage": "withheld",
  "sessions.bulk_archive": "grantable",
  "sessions.collaborate": "grantable",
  "sessions.create": "grantable",
  "sessions.delete": "grantable",
  "sessions.export": "grantable",
  "sessions.lifecycle": "grantable",
  "sessions.read": "grantable",
  "sessions.sandbox_access": "grantable",
  "skill_profiles.manage_own": "grantable",
  "skills.manage": "grantable",
  "skills.read": "grantable",
  "workspace.audit.read": "grantable",
  "workspace.members.manage": "withheld",
  "workspace.members.merge": "withheld",
  "workspace.members.read": "grantable",
  "workspace.personal_access_tokens.manage": "withheld",
  "workspace.roles.read": "grantable",
  "workspace.transfer_ownership": "withheld",
} as const satisfies Record<PermissionId, "grantable" | "withheld">;

/** A permission a personal access token may be granted. */
export type PersonalAccessTokenGrantablePermission = {
  [
    Permission in PermissionId
  ]: (typeof PERSONAL_ACCESS_TOKEN_GRANTABILITY)[Permission] extends "grantable"
    ? Permission
    : never;
}[PermissionId];

/** Whether a permission may appear in a personal access token's grant. */
export function isPersonalAccessTokenGrantable(
  permission: PermissionId
): permission is PersonalAccessTokenGrantablePermission {
  return PERSONAL_ACCESS_TOKEN_GRANTABILITY[permission] === "grantable";
}

/** Every permission a token may be granted, in registry order. */
export const PERSONAL_ACCESS_TOKEN_GRANTABLE_PERMISSIONS: readonly PersonalAccessTokenGrantablePermission[] =
  PERMISSION_IDS.filter(isPersonalAccessTokenGrantable);

/**
 * Permissions a token's grant must also include for a permission to take effect.
 *
 * Every route a token can manage skills through answers with skill or repository content, which
 * `skills.read` governs. A role may separate the two, but a token may not: one granted only
 * `skills.manage` would read what its grant deliberately left out.
 */
export const PERSONAL_ACCESS_TOKEN_GRANT_PREREQUISITES: Partial<
  Record<PersonalAccessTokenGrantablePermission, readonly PersonalAccessTokenGrantablePermission[]>
> = {
  "skills.manage": ["skills.read"],
};

function prerequisitesOf(permission: PermissionId): readonly PermissionId[] {
  return isPersonalAccessTokenGrantable(permission)
    ? (PERSONAL_ACCESS_TOKEN_GRANT_PREREQUISITES[permission] ?? [])
    : [];
}

/** The first permission in `permissions` whose prerequisites it lacks, or null when none does. */
export function unmetGrantPrerequisite(
  permissions: readonly PermissionId[]
): { permission: PermissionId; requires: PermissionId } | null {
  const present = new Set(permissions);
  for (const permission of permissions) {
    const requires = prerequisitesOf(permission).find((prerequisite) => !present.has(prerequisite));
    if (requires) return { permission, requires };
  }
  return null;
}

/** `permissions` less every permission whose prerequisites are not also present. */
export function withGrantPrerequisitesMet<Permission extends PermissionId>(
  permissions: readonly Permission[]
): Permission[] {
  let remaining = [...permissions];
  // Dropping one permission can strand another that required it, so repeat until stable.
  for (;;) {
    const present = new Set<PermissionId>(remaining);
    const kept = remaining.filter((permission) =>
      prerequisitesOf(permission).every((prerequisite) => present.has(prerequisite))
    );
    if (kept.length === remaining.length) return kept;
    remaining = kept;
  }
}

export const PERSONAL_ACCESS_TOKEN_NAME_MAX_LENGTH = 100;

/** Bounds on how long a token stays valid, chosen when it is issued. Every token expires. */
export const PERSONAL_ACCESS_TOKEN_MIN_LIFETIME_DAYS = 1;
export const PERSONAL_ACCESS_TOKEN_MAX_LIFETIME_DAYS = 365;

/** How many unrevoked tokens one user may hold, expired ones included until revoked. */
export const PERSONAL_ACCESS_TOKEN_MAX_PER_USER = 50;

/** The non-secret description of a token, safe to list and to log. */
export const personalAccessTokenSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  /** The prefix plus PERSONAL_ACCESS_TOKEN_DISPLAY_CHARS characters, for disambiguation. */
  displayPrefix: z.string(),
  /** The grant chosen at issue time; the token acts with its intersection with the owner's. */
  permissions: z.array(permissionIdSchema),
  createdAt: z.number(),
  lastUsedAt: z.number().nullable(),
  expiresAt: z.number(),
});
export type PersonalAccessToken = z.infer<typeof personalAccessTokenSchema>;

/** A creation response. `token` is present here and nowhere else; no later read returns it. */
export const createdPersonalAccessTokenSchema = personalAccessTokenSchema.extend({
  token: z.string(),
});
export type CreatedPersonalAccessToken = z.infer<typeof createdPersonalAccessTokenSchema>;

export const createPersonalAccessTokenRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(PERSONAL_ACCESS_TOKEN_NAME_MAX_LENGTH),
  permissions: z.array(permissionIdSchema).min(1).max(PERMISSION_IDS.length),
  expiresInDays: z
    .number()
    .int()
    .min(PERSONAL_ACCESS_TOKEN_MIN_LIFETIME_DAYS)
    .max(PERSONAL_ACCESS_TOKEN_MAX_LIFETIME_DAYS),
});
export type CreatePersonalAccessTokenRequest = z.infer<
  typeof createPersonalAccessTokenRequestSchema
>;

export const listPersonalAccessTokensResponseSchema = z.strictObject({
  tokens: z.array(personalAccessTokenSchema),
});
export type ListPersonalAccessTokensResponse = z.infer<
  typeof listPersonalAccessTokensResponseSchema
>;

/**
 * The workspace's rules for personal access tokens, set by holders of
 * `workspace.personal_access_tokens.manage`. They apply to existing tokens at once, not only to new
 * ones: disabling refuses every token, a lower lifetime cap expires older tokens early, and a
 * narrower permission ceiling narrows every grant.
 */
export const personalAccessTokenPolicySchema = z.strictObject({
  enabled: z.boolean(),
  /** Days a token may live, counted from issue. Null: PERSONAL_ACCESS_TOKEN_MAX_LIFETIME_DAYS. */
  maxLifetimeDays: z
    .number()
    .int()
    .min(PERSONAL_ACCESS_TOKEN_MIN_LIFETIME_DAYS)
    .max(PERSONAL_ACCESS_TOKEN_MAX_LIFETIME_DAYS)
    .nullable(),
  /** Permissions a token may hold at all. Null: every grantable permission. */
  allowedPermissions: z.array(permissionIdSchema).nullable(),
});
export type PersonalAccessTokenPolicy = z.infer<typeof personalAccessTokenPolicySchema>;

/** The policy as administrators edit it: the rules plus the revision an update must name. */
export const personalAccessTokenPolicySnapshotSchema = personalAccessTokenPolicySchema.extend({
  revision: z.number().int().nonnegative(),
  updatedAt: z.number().nullable(),
  updatedByUserId: z.string().nullable(),
});
export type PersonalAccessTokenPolicySnapshot = z.infer<
  typeof personalAccessTokenPolicySnapshotSchema
>;

/** The longest lifetime, in days, the policy allows a token. */
export function personalAccessTokenMaxLifetimeDays(policy: PersonalAccessTokenPolicy): number {
  return policy.maxLifetimeDays ?? PERSONAL_ACCESS_TOKEN_MAX_LIFETIME_DAYS;
}

/** Whether the policy lets a token hold a permission. Withheld permissions are never allowed. */
export function personalAccessTokenPolicyAllows(
  policy: PersonalAccessTokenPolicy,
  permission: PermissionId
): boolean {
  return (
    isPersonalAccessTokenGrantable(permission) &&
    (policy.allowedPermissions === null || policy.allowedPermissions.includes(permission))
  );
}

/** A token as administrators see it: who owns it, and nothing secret. */
export const workspacePersonalAccessTokenSchema = personalAccessTokenSchema.extend({
  owner: z.strictObject({
    userId: z.string(),
    displayName: z.string().nullable(),
    email: z.string().nullable(),
  }),
});
export type WorkspacePersonalAccessToken = z.infer<typeof workspacePersonalAccessTokenSchema>;

export const listWorkspacePersonalAccessTokensResponseSchema = z.strictObject({
  tokens: z.array(workspacePersonalAccessTokenSchema),
  nextCursor: z.string().nullable(),
});
export type ListWorkspacePersonalAccessTokensResponse = z.infer<
  typeof listWorkspacePersonalAccessTokensResponseSchema
>;

/** Stable codes for refusals of a creation request, beyond schema validation. */
export const PERSONAL_ACCESS_TOKEN_ERROR_CODES = {
  /** A requested permission is withheld from tokens. */
  permissionNotGrantable: "permission_not_grantable",
  /** A requested permission is not one the issuing user currently holds. */
  permissionNotHeld: "permission_not_held",
  /** A requested permission's PERSONAL_ACCESS_TOKEN_GRANT_PREREQUISITES are not also requested. */
  prerequisiteMissing: "permission_prerequisite_missing",
  /** The user already holds PERSONAL_ACCESS_TOKEN_MAX_PER_USER tokens. */
  limitReached: "personal_access_token_limit_reached",
  /** The workspace policy has turned personal access tokens off. */
  disabled: "personal_access_tokens_disabled",
  /** A requested permission is outside the workspace policy's ceiling. */
  permissionNotAllowed: "permission_not_allowed_by_policy",
  /** The requested lifetime exceeds the workspace policy's maximum. */
  lifetimeExceedsPolicy: "lifetime_exceeds_policy",
} as const;

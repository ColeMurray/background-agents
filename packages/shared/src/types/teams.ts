import { z } from "zod";
import { isEnvironmentId } from "./environments";

export const teamRoleSchema = z.enum(["lead", "member"]);
export type TeamRole = z.infer<typeof teamRoleSchema>;

export const teamJoinPolicySchema = z.enum(["open", "invite_only"]);
export type TeamJoinPolicy = z.infer<typeof teamJoinPolicySchema>;

export const sessionVisibilitySchema = z.enum(["team", "workspace", "private"]);
export type SessionVisibility = z.infer<typeof sessionVisibilitySchema>;

export const teamRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  join_policy: teamJoinPolicySchema,
  default_visibility: sessionVisibilitySchema,
  default_environment_id: z.string().nullable(),
  grants_version: z.number().int(),
  archived_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});

export interface Team {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  joinPolicy: TeamJoinPolicy;
  defaultVisibility: SessionVisibility;
  defaultEnvironmentId: string | null;
  grantsVersion: number;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export const teamMembershipSchema = z.object({
  teamId: z.string(),
  userId: z.string(),
  role: teamRoleSchema,
  source: z.enum(["manual", "github_team"]),
  createdAt: z.number(),
});
export type TeamMembership = z.infer<typeof teamMembershipSchema>;

export const createTeamRequestSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  name: z.string().min(1).max(80),
  description: z.string().nullable().optional(),
  joinPolicy: teamJoinPolicySchema.default("invite_only"),
});

export const updateTeamRequestSchema = z.object({
  slug: createTeamRequestSchema.shape.slug.optional(),
  name: createTeamRequestSchema.shape.name.optional(),
  description: z.string().nullable().optional(),
  joinPolicy: teamJoinPolicySchema.optional(),
  defaultVisibility: sessionVisibilitySchema.optional(),
  defaultEnvironmentId: z
    .string()
    .refine(isEnvironmentId, "Invalid environment ID")
    .nullable()
    .optional(),
});

export const teamCapabilitiesSchema = z.object({
  canJoin: z.boolean(),
  canLeave: z.boolean(),
  canEditMetadata: z.boolean(),
  canManageMembers: z.boolean(),
  canManageRepositories: z.boolean(),
  canManageBindings: z.boolean(),
  canManageAutomations: z.boolean(),
  canManageSecrets: z.boolean(),
  canArchive: z.boolean(),
});

export const teamResponseSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  joinPolicy: teamJoinPolicySchema,
  defaultVisibility: sessionVisibilitySchema,
  defaultEnvironmentId: z.string().nullable(),
  grantsVersion: z.number().int(),
  archivedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  memberCount: z.number().int().nonnegative(),
  capabilities: teamCapabilitiesSchema,
});

export const teamMemberSchema = teamMembershipSchema.extend({
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});

export const meTeamsResponseSchema = z.object({
  teams: z.array(teamResponseSchema.extend({ role: teamRoleSchema })),
});

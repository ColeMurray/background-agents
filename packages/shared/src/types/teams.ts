import { z } from "zod";

export const DEFAULT_TEAM_ID = "team_default";

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
  is_default: z.number().int(),
  join_policy: teamJoinPolicySchema,
  auto_join: z.number().int(),
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
  isDefault: boolean;
  joinPolicy: TeamJoinPolicy;
  autoJoin: boolean;
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
  source: z.enum(["manual", "auto_join", "github_team"]),
  createdAt: z.number(),
});
export type TeamMembership = z.infer<typeof teamMembershipSchema>;

import { z } from "zod";
import { sessionRepositoriesInputSchema } from "./repositories";

/** Maximum characters in an environment's display name. */
export const MAX_ENVIRONMENT_NAME_LENGTH = 200;
/** Maximum characters in an environment's description. */
export const MAX_ENVIRONMENT_DESCRIPTION_LENGTH = 2000;
/** Maximum Slack channel associations per environment. */
export const MAX_ENVIRONMENT_CHANNEL_ASSOCIATIONS = 50;

/**
 * Shape check for stable environment ids (`env_` + generated suffix). Loose on
 * the suffix alphabet — ids are opaque and the generator may change — while
 * rejecting obviously-wrong values like display names or "owner/name" pairs.
 * The single stance on id shape: everything that gates on "is this an
 * environment id" (e.g. routing-rule validation) goes through this.
 */
export function isEnvironmentId(value: string): boolean {
  return /^env_[A-Za-z0-9_-]+$/.test(value);
}

/**
 * An environment's repositories share the session list contract: non-empty,
 * deduplicated by owner/name AND by repoName (checkout paths are
 * /workspace/{repoName}, so a name collision is rejected), and capped at
 * MAX_TARGET_REPOSITORIES. An environment is a prebuildable repository set, so
 * it inherits exactly the session's list rules.
 */
export const environmentRepositoriesInputSchema = sessionRepositoriesInputSchema;

/**
 * Slack channel ids associated with an environment (mirrors
 * RepoMetadata.channelAssociations). Ids are opaque Slack identifiers, so the
 * schema checks only basic hygiene; `undefined` on update leaves the set
 * untouched, an array replaces it wholesale (empty clears).
 */
const environmentChannelAssociationsSchema = z
  .array(z.string().trim().min(1).max(64))
  .max(MAX_ENVIRONMENT_CHANNEL_ASSOCIATIONS);

export const createEnvironmentInputSchema = z.object({
  name: z.string().trim().min(1).max(MAX_ENVIRONMENT_NAME_LENGTH),
  description: z.string().trim().max(MAX_ENVIRONMENT_DESCRIPTION_LENGTH).nullish(),
  prebuildEnabled: z.boolean().optional(),
  channelAssociations: environmentChannelAssociationsSchema.optional(),
  repositories: environmentRepositoriesInputSchema,
});

export const updateEnvironmentInputSchema = z.object({
  name: z.string().trim().min(1).max(MAX_ENVIRONMENT_NAME_LENGTH).optional(),
  description: z.string().trim().max(MAX_ENVIRONMENT_DESCRIPTION_LENGTH).nullish(),
  prebuildEnabled: z.boolean().optional(),
  channelAssociations: environmentChannelAssociationsSchema.optional(),
  repositories: environmentRepositoriesInputSchema.optional(),
});

export type CreateEnvironmentInput = z.input<typeof createEnvironmentInputSchema>;
export type UpdateEnvironmentInput = z.input<typeof updateEnvironmentInputSchema>;

/**
 * A resolved environment repository. baseBranch is non-null (the DDL column is
 * NOT NULL — resolution fills the repo's default branch when the request omits
 * it); repoId is nullable to tolerate rows written before a repo resolved.
 */
export interface EnvironmentRepository {
  repoOwner: string;
  repoName: string;
  repoId: number | null;
  baseBranch: string;
}

/** An environment: a named, prebuildable repository set (design §7.1). */
export interface Environment {
  id: string;
  name: string;
  description: string | null;
  prebuildEnabled: boolean;
  createdAt: number;
  updatedAt: number;
  /**
   * Slack channel ids associated with this environment (classifier
   * channel-association stage). Absent when the environment has none.
   */
  channelAssociations?: string[];
  /** Ordered repositories; [0] is the primary (sandbox/code-server settings source). */
  repositories: EnvironmentRepository[];
}

export interface ListEnvironmentsResponse {
  environments: Environment[];
  total: number;
}

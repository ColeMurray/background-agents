import type { ConfidenceLevel } from "./statuses";
import { z } from "zod";

export const installationRepositorySchema = z.object({
  id: z.number(),
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
  description: z.string().nullable(),
  private: z.boolean(),
  defaultBranch: z.string(),
  archived: z.boolean(),
  language: z.string().nullable().optional(),
  topics: z.array(z.string()).optional(),
});

export type InstallationRepository = z.infer<typeof installationRepositorySchema>;

export const repoMetadataSchema = z.object({
  description: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  channelAssociations: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  /**
   * Environment opened by GitHub-bot sessions triggered from this repo
   * (design §13.2). The bot falls back to a repo-bound session when the
   * environment no longer exists or no longer contains this repository.
   */
  defaultEnvironmentId: z.string().optional(),
});

export type RepoMetadata = z.infer<typeof repoMetadataSchema>;

export const enrichedRepositorySchema = installationRepositorySchema.extend({
  metadata: repoMetadataSchema.optional(),
});

export type EnrichedRepository = z.infer<typeof enrichedRepositorySchema>;

export const repoConfigSchema = z.object({
  id: z.string(),
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
  displayName: z.string(),
  description: z.string(),
  defaultBranch: z.string(),
  private: z.boolean(),
  language: z.string().nullable().optional(),
  topics: z.array(z.string()).optional(),
  aliases: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  channelAssociations: z.array(z.string()).optional(),
});

export type RepoConfig = z.infer<typeof repoConfigSchema>;

export type ControlPlaneRepo = EnrichedRepository;

export const controlPlaneReposResponseSchema = z.object({
  repos: z.array(enrichedRepositorySchema),
  cached: z.boolean(),
  cachedAt: z.string(),
});

export type ControlPlaneReposResponse = z.infer<typeof controlPlaneReposResponseSchema>;

export interface ClassificationResult {
  repo: RepoConfig | null;
  confidence: ConfidenceLevel;
  reasoning: string;
  alternatives?: RepoConfig[];
  needsClarification: boolean;
}

import type { ConfidenceLevel } from "./statuses";
import { z } from "zod";

// Repository types for GitHub App installation
export interface InstallationRepository {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  archived: boolean;
  language?: string | null;
  topics?: string[];
}

export interface RepoMetadata {
  description?: string;
  aliases?: string[];
  channelAssociations?: string[];
  keywords?: string[];
  /**
   * Environment opened by GitHub-bot sessions triggered from this repo
   * (design §13.2). The bot falls back to a repo-bound session when the
   * environment no longer exists or no longer contains this repository.
   */
  defaultEnvironmentId?: string;
}

export interface EnrichedRepository extends InstallationRepository {
  metadata?: RepoMetadata;
}

// Bot package shared types
export interface RepoConfig {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  displayName: string;
  description: string;
  defaultBranch: string;
  private: boolean;
  language?: string | null;
  topics?: string[];
  aliases?: string[];
  keywords?: string[];
  channelAssociations?: string[];
}

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

export const enrichedRepositorySchema = installationRepositorySchema.extend({
  metadata: repoMetadataSchema.optional(),
});

const consumedControlPlaneRepoSchema = z.object({
  owner: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  private: z.boolean(),
  defaultBranch: z.string(),
  language: z.string().nullable().optional(),
  topics: z.array(z.string()).optional(),
  metadata: repoMetadataSchema.optional(),
});

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

export type ControlPlaneRepo = EnrichedRepository;

export const controlPlaneReposResponseSchema = z.object({
  repos: z.array(consumedControlPlaneRepoSchema),
  cached: z.boolean().optional(),
  cachedAt: z.string().optional(),
});

export interface ControlPlaneReposResponse {
  repos: ControlPlaneRepo[];
  cached: boolean;
  cachedAt: string;
}

export interface ClassificationResult {
  repo: RepoConfig | null;
  confidence: ConfidenceLevel;
  reasoning: string;
  alternatives?: RepoConfig[];
  needsClarification: boolean;
}

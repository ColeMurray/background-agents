import { z } from "zod";
import type { ConfidenceLevel } from "./statuses";

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

export type ControlPlaneRepo = EnrichedRepository;

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

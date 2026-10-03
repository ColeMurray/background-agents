/**
 * Team-scoped repository fetching from the control plane.
 */

import {
  controlPlaneReposResponseSchema,
  type ControlPlaneRepo,
  type RepoConfig,
} from "@open-inspect/shared/types/repository-catalog";
import type { Env, LinearChannelScope } from "../types";
import { fetchControlPlaneJson } from "../control-plane";

function toRepoConfig(repo: ControlPlaneRepo): RepoConfig {
  const owner = repo.owner.toLowerCase();
  const name = repo.name.toLowerCase();
  return {
    id: `${owner}/${name}`,
    owner,
    name,
    fullName: `${owner}/${name}`,
    displayName: repo.name,
    description: repo.metadata?.description || repo.description || repo.name,
    defaultBranch: repo.defaultBranch,
    private: repo.private,
    language: repo.language,
    topics: repo.topics,
    aliases: repo.metadata?.aliases,
    keywords: repo.metadata?.keywords,
  };
}

/**
 * Read the repositories visible to one Linear team. Reads are live and fail closed:
 * a denied, unavailable, or malformed response throws rather than widening to a
 * cached or empty catalog.
 */
export async function getAvailableRepos(
  env: Env,
  scope: LinearChannelScope,
  traceId?: string
): Promise<RepoConfig[]> {
  const body = await fetchControlPlaneJson(env, "/repos", scope, traceId);
  return controlPlaneReposResponseSchema.parse(body).repos.map(toRepoConfig);
}

export function buildRepoDescriptions(repos: RepoConfig[]): string {
  if (repos.length === 0) return "No repositories are currently available.";

  return repos
    .map(
      (repo) => `- **${repo.id}** (${repo.fullName})
  - Description: ${repo.description}
  - Language: ${repo.language || "N/A"}
  - Topics: ${repo.topics?.join(", ") || "N/A"}
  - Also known as: ${repo.aliases?.join(", ") || "N/A"}
  - Keywords: ${repo.keywords?.join(", ") || "N/A"}
  - Default branch: ${repo.defaultBranch}
  - Private: ${repo.private ? "Yes" : "No"}`
    )
    .join("\n");
}

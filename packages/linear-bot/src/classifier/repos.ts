/**
 * Dynamic repository fetching from the control plane. A cached resource
 * (in-memory → control plane → KV, fail open to an empty list); an empty
 * repo list surfaces to the user as a clarification asking for the
 * repository name.
 */

import { z } from "zod";
import {
  controlPlaneReposResponseSchema,
  repoConfigSchema,
  type ControlPlaneRepo,
  type RepoConfig,
} from "@open-inspect/shared/types/repository-catalog";
import type { Env } from "../types";
import { createCachedResource } from "../cached-resource";
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

const repoConfigsSchema = z.array(repoConfigSchema);

const reposResource = createCachedResource<RepoConfig[]>({
  name: "repos",
  kvKey: "repos:cache",
  load: async (env, traceId) => {
    const body = await fetchControlPlaneJson(env, "/repos", traceId);
    // Throws on a malformed body so the resource falls back to the KV
    // last-known-good copy. Returning [] here would instead publish "no
    // repositories" as a successful load and overwrite that copy.
    return controlPlaneReposResponseSchema.parse(body).repos.map(toRepoConfig);
  },
  deserialize: (cached) => {
    const result = repoConfigsSchema.safeParse(cached);
    return result.success ? result.data : null;
  },
  fallback: [],
});

export async function getAvailableRepos(env: Env, traceId?: string): Promise<RepoConfig[]> {
  return reposResource.get(env, traceId);
}

/**
 * Clear the in-memory cache (for testing).
 */
export function clearReposLocalCache(): void {
  reposResource.invalidate();
}

export async function buildRepoDescriptions(env: Env, traceId?: string): Promise<string> {
  const repos = await getAvailableRepos(env, traceId);
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

import { sha256Hex } from "@open-inspect/shared/service-auth";
import {
  enrichedRepositorySchema,
  type InstallationRepository,
} from "@open-inspect/shared/types/repository-catalog";
import { z } from "zod";
import { resolveScmProviderFromEnv } from "../source-control/config";
import { SourceControlProviderError } from "../source-control/errors";
import type { Env } from "../types";

export const REPOS_CACHE_KEY = "repos:list:v3";

export async function reposCacheIdentity(
  env: Pick<
    Env,
    "SCM_PROVIDER" | "GITHUB_APP_INSTALLATION_ID" | "GITLAB_NAMESPACE" | "GITLAB_ACCESS_TOKEN"
  >
): Promise<string> {
  const provider = resolveScmProviderFromEnv(env.SCM_PROVIDER);
  let identity: string[] = [provider];
  if (provider === "github") identity = [provider, env.GITHUB_APP_INSTALLATION_ID ?? ""];
  if (provider === "gitlab") {
    identity = [provider, env.GITLAB_NAMESPACE ?? "", env.GITLAB_ACCESS_TOKEN ?? ""];
  }
  return await sha256Hex(JSON.stringify(identity));
}

export const cachedReposListSchema = z.object({
  repos: z.array(enrichedRepositorySchema),
  cachedAt: z.string(),
  scmIdentity: z.string(),
  // Missing in entries cached before this field was added.
  freshUntil: z.number().optional(),
});

export type CachedReposList = z.infer<typeof cachedReposListSchema>;

/**
 * Read the installation catalog without fetching, minting credentials, or writing to cache.
 * Stale entries are usable while present in KV because repository IDs are stable.
 */
export async function readCachedInstallationRepositories(
  env: Pick<
    Env,
    | "REPOS_CACHE"
    | "SCM_PROVIDER"
    | "GITHUB_APP_INSTALLATION_ID"
    | "GITLAB_NAMESPACE"
    | "GITLAB_ACCESS_TOKEN"
  >
): Promise<InstallationRepository[]> {
  const scmIdentity = await reposCacheIdentity(env);
  let raw: unknown;
  try {
    raw = await env.REPOS_CACHE.get(REPOS_CACHE_KEY, "json");
  } catch (e) {
    throw new SourceControlProviderError(
      "Failed to read installation repository catalog cache",
      "permanent",
      undefined,
      e instanceof Error ? e : undefined
    );
  }

  const cached = cachedReposListSchema.safeParse(raw);
  if (!cached.success) {
    throw new SourceControlProviderError(
      "Installation repository catalog cache is missing or malformed",
      "permanent"
    );
  }
  if (cached.data.scmIdentity !== scmIdentity) {
    throw new SourceControlProviderError(
      "Installation repository catalog cache does not match SCM configuration",
      "permanent"
    );
  }

  return cached.data.repos;
}

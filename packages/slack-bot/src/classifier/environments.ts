/**
 * Environment fetching from the control plane, for routing rules and channel
 * associations that target a saved environment.
 *
 * A cached resource (in-memory → control plane → KV, **fail open to an empty
 * list**) so an environments-fetch problem never blocks classification —
 * rules and channel associations targeting an environment are simply skipped,
 * like rules targeting an inaccessible repository.
 */

import { environmentSchema, listEnvironmentsResponseSchema } from "@open-inspect/shared";
import type { Environment } from "@open-inspect/shared/types/environments";
import type { Env } from "../types";
import { createCachedResource } from "./cached-resource";
import { fetchControlPlaneJson } from "./control-plane";

const environments = createCachedResource<Environment[]>({
  name: "environments",
  kvKey: "slack:environments",
  load: async (env, traceId) => {
    const body = await fetchControlPlaneJson(env, "/environments", traceId);
    // Throw on malformed fresh data so the cache can fall back to the KV
    // last-known-good copy instead of overwriting it with an empty list.
    return listEnvironmentsResponseSchema.parse(body).environments;
  },
  // Validate the cached copy entry by entry: one malformed environment costs
  // itself, not every other environment stored alongside it.
  deserialize: (cached) => {
    if (!Array.isArray(cached)) return null;
    return cached.flatMap((entry) => {
      const result = environmentSchema.safeParse(entry);
      return result.success ? [result.data] : [];
    });
  },
  fallback: [],
});

/**
 * Fetch the workspace's environments from the control plane.
 */
export async function getAvailableEnvironments(env: Env, traceId?: string): Promise<Environment[]> {
  return environments.get(env, traceId);
}

/**
 * Find an environment by its stable id.
 */
export async function getEnvironmentById(
  env: Env,
  environmentId: string,
  traceId?: string
): Promise<Environment | undefined> {
  const all = await getAvailableEnvironments(env, traceId);
  return all.find((environment) => environment.id === environmentId);
}

/**
 * Build a description string for the given environments, mirroring
 * {@link buildRepoDescriptions} for the classification prompt.
 */
export function buildEnvironmentDescriptions(environments: Environment[]): string {
  return environments
    .map(
      (environment) => `
- **${environment.id}** ("${environment.name}")
  - Description: ${environment.description || "N/A"}
  - Repositories: ${environment.repositories
    .map((repository) => `${repository.repoOwner}/${repository.repoName}`)
    .join(", ")}`
    )
    .join("\n");
}

/**
 * Clear the in-memory cache (for testing or forced refresh).
 */
export function clearEnvironmentsLocalCache(): void {
  environments.invalidate();
}

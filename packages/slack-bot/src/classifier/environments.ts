/**
 * Environment fetching from the control plane, for routing rules that target a
 * saved environment.
 *
 * A declaration over the shared cached read pipeline (in-memory → control
 * plane → KV, **fail open to an empty list**) so an environments-fetch problem
 * never blocks classification — rules targeting an environment are simply
 * skipped, like rules targeting an inaccessible repository.
 */

import type { Environment, ListEnvironmentsResponse } from "@open-inspect/shared";
import type { Env } from "../types";
import { createCachedControlPlaneRead } from "./cached-read";

const environmentsRead = createCachedControlPlaneRead<Environment[]>({
  loggerName: "environments",
  path: "/environments",
  kvCacheKey: "slack:environments",
  fetchLogEvent: "control_plane.fetch_environments",
  kvLogKeyPrefix: "environments_cache",
  parseResponse: (body) => {
    const environments = (body as ListEnvironmentsResponse).environments;
    return Array.isArray(environments) ? environments : [];
  },
  parseCached: (cached) => (Array.isArray(cached) ? (cached as Environment[]) : null),
  empty: [],
});

/**
 * Fetch the workspace's environments from the control plane.
 */
export async function getAvailableEnvironments(env: Env, traceId?: string): Promise<Environment[]> {
  return environmentsRead.read(env, traceId);
}

/**
 * Find an environment by its stable id.
 */
export async function getEnvironmentById(
  env: Env,
  environmentId: string,
  traceId?: string
): Promise<Environment | undefined> {
  const environments = await getAvailableEnvironments(env, traceId);
  return environments.find((environment) => environment.id === environmentId);
}

/**
 * Clear the local cache (for testing or forced refresh).
 */
export function clearEnvironmentsLocalCache(): void {
  environmentsRead.clearLocalCache();
}

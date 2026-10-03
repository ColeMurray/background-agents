/**
 * Environment fetching from the control plane, for team/project mappings that
 * target a saved environment. Scoped reads are live and fail closed. Legacy
 * unscoped reads use an in-memory/control-plane/KV cache and fail open to an
 * empty list so resolution can fall through to the next stage.
 */

import { z } from "zod";
import {
  environmentSchema,
  listEnvironmentsResponseSchema,
  type Environment,
} from "@open-inspect/shared/types/environments";
import type { Env, LinearChannelScope } from "./types";
import { createCachedResource } from "./cached-resource";
import { fetchControlPlaneJson } from "./control-plane";

const environmentsSchema = z.array(environmentSchema);

const environments = createCachedResource<Environment[]>({
  name: "environments",
  kvKey: "environments:cache",
  load: async (env, traceId) => {
    const body = await fetchControlPlaneJson(env, "/environments", traceId);
    // Throws on a malformed body so the resource falls back to the KV
    // last-known-good copy. Returning [] here would instead publish "no
    // environments" as a successful load and overwrite that copy.
    return listEnvironmentsResponseSchema.parse(body).environments;
  },
  deserialize: (cached) => {
    const result = environmentsSchema.safeParse(cached);
    return result.success ? result.data : null;
  },
  fallback: [],
});

/**
 * Fetch the workspace's environments from the control plane.
 */
export async function getAvailableEnvironments(
  env: Env,
  traceId?: string,
  scope?: LinearChannelScope
): Promise<Environment[]> {
  if (scope) {
    const body = await fetchControlPlaneJson(env, "/environments", traceId, scope);
    return listEnvironmentsResponseSchema.parse(body).environments;
  }
  return environments.get(env, traceId);
}

/**
 * Find an environment by its stable id.
 */
export async function getEnvironmentById(
  env: Env,
  environmentId: string,
  traceId?: string,
  scope?: LinearChannelScope
): Promise<Environment | undefined> {
  const all = await getAvailableEnvironments(env, traceId, scope);
  return all.find((environment) => environment.id === environmentId);
}

/**
 * Clear the in-memory cache (for testing).
 */
export function clearEnvironmentsLocalCache(): void {
  environments.invalidate();
}

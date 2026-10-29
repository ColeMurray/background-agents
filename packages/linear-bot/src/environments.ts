/**
 * Team-scoped environment fetching from the control plane, for team/project
 * mappings that target a saved environment. Reads are live and fail closed.
 */

import {
  listEnvironmentsResponseSchema,
  type Environment,
} from "@open-inspect/shared/types/environments";
import type { Env, LinearChannelScope } from "./types";
import { fetchControlPlaneJson } from "./control-plane";

/**
 * Fetch the environments visible to one Linear team.
 */
export async function getAvailableEnvironments(
  env: Env,
  scope: LinearChannelScope,
  traceId?: string
): Promise<Environment[]> {
  const body = await fetchControlPlaneJson(env, "/environments", scope, traceId);
  return listEnvironmentsResponseSchema.parse(body).environments;
}

/**
 * Find an environment visible to one Linear team by its stable id.
 */
export async function getEnvironmentById(
  env: Env,
  environmentId: string,
  scope: LinearChannelScope,
  traceId?: string
): Promise<Environment | undefined> {
  const all = await getAvailableEnvironments(env, scope, traceId);
  return all.find((environment) => environment.id === environmentId);
}

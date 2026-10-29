/**
 * The classification target catalog: every launchable target — accessible
 * repositories and saved environments — fetched once and passed through the
 * classifier stages and the clarification UI, so "what targets are available?"
 * is a single explicit value rather than a fetch threaded through each stage.
 */

import type { Environment } from "@open-inspect/shared/types/environments";
import type { RepoConfig } from "@open-inspect/shared/types/repository-catalog";
import type { Env } from "../types";
import { getAvailableRepos } from "./repos";
import { getAvailableEnvironments } from "./environments";

export interface TargetCatalog {
  repos: RepoConfig[];
  environments: Environment[];
}

/**
 * Fetch both target lists concurrently. Channel reads are authorized afresh
 * from the live binding and user; unscoped workspace reads use caches.
 */
export async function loadTargetCatalog(
  env: Env,
  traceId?: string,
  channelId?: string | null,
  userId?: string
): Promise<TargetCatalog> {
  const [repos, environments] = await Promise.all([
    getAvailableRepos(env, traceId, channelId, userId),
    getAvailableEnvironments(env, traceId, channelId, userId),
  ]);
  return { repos, environments };
}

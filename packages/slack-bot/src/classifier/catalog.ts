/**
 * The classification target catalog: every launchable target — accessible
 * repositories and saved environments — fetched once and passed through the
 * classifier stages and the clarification UI, so "what targets are available?"
 * is a single explicit value rather than a fetch threaded through each stage.
 */

import type { Env, Environment, RepoConfig } from "../types";
import { getAvailableRepos } from "./repos";
import { getAvailableEnvironments } from "./environments";

export interface TargetCatalog {
  repos: RepoConfig[];
  environments: Environment[];
}

/**
 * Fetch both target lists concurrently. Each side is served from its own
 * cache; environments fail open to an empty list, so an environments outage
 * degrades the whole catalog to repository-only.
 */
export async function loadTargetCatalog(env: Env, traceId?: string): Promise<TargetCatalog> {
  const [repos, environments] = await Promise.all([
    getAvailableRepos(env, traceId),
    getAvailableEnvironments(env, traceId),
  ]);
  return { repos, environments };
}

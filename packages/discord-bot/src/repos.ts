/**
 * The repositories a task can target: whatever the GitHub App is installed on.
 *
 * Autocomplete must answer within Discord's 3-second window, so the list is
 * cached in KV and refreshed from the control plane when it expires.
 */

import {
  controlPlaneReposResponseSchema,
  type ControlPlaneRepo,
} from "@open-inspect/shared/types/repository-catalog";
import { signedControlPlaneFetch } from "./internal-auth";
import type { Env } from "./types";

const REPOS_CACHE_KEY = "cache:repos";
const REPOS_CACHE_TTL_SECONDS = 300;

/** Discord shows at most this many autocomplete choices. */
const MAX_CHOICES = 25;

export async function listRepos(env: Env, traceId?: string): Promise<string[]> {
  const cached = await env.DISCORD_KV.get<string[]>(REPOS_CACHE_KEY, "json");
  if (cached) return cached;

  const response = await signedControlPlaneFetch(
    env,
    { method: "GET", url: "https://internal/repos", traceId },
    { headers: { Accept: "application/json" } }
  );
  if (!response.ok) {
    throw new Error(`Control plane GET /repos failed with ${response.status}`);
  }
  const parsed = controlPlaneReposResponseSchema.parse(await response.json());
  const names = parsed.repos
    .filter((repo: ControlPlaneRepo) => !repo.archived)
    .map((repo: ControlPlaneRepo) => repo.fullName)
    .sort((a: string, b: string) => a.localeCompare(b));

  await env.DISCORD_KV.put(REPOS_CACHE_KEY, JSON.stringify(names), {
    expirationTtl: REPOS_CACHE_TTL_SECONDS,
  });
  return names;
}

/** Case-insensitive match on any part of `owner/name`. */
export function repoChoices(repos: string[], query: string): { name: string; value: string }[] {
  const needle = query.trim().toLowerCase();
  return repos
    .filter((repo) => repo.toLowerCase().includes(needle))
    .slice(0, MAX_CHOICES)
    .map((repo) => ({ name: repo, value: repo }));
}

/** Resolve user input to a known repository, ignoring case. */
export function findRepo(repos: string[], input: string): string | undefined {
  const wanted = input.trim().toLowerCase();
  return repos.find((repo) => repo.toLowerCase() === wanted);
}

/**
 * The repositories a task can target: whatever the GitHub App is installed on.
 *
 * Autocomplete must answer within Discord's 3-second window, so the list is
 * cached in KV and refreshed from the control plane when it expires.
 */

import { controlPlaneReposResponseSchema } from "@open-inspect/shared/types/repository-catalog";
import { z } from "zod";
import { signedControlPlaneFetch } from "./internal-auth";
import type { Env } from "./types";

const REPOS_CACHE_KEY = "cache:repos";
const REPOS_CACHE_TTL_SECONDS = 300;

/** Discord shows at most this many autocomplete choices. */
const MAX_CHOICES = 25;

/** Discord rejects the whole response if any choice name or value is longer. */
const MAX_CHOICE_LENGTH = 100;

/**
 * A repository as cached for `/task`. Owner and name stay separate because an
 * owner may be a nested namespace; `fullName` is only what the user types.
 */
const taskRepoSchema = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
  fullName: z.string().min(1),
});

const cachedReposSchema = z.array(taskRepoSchema);

export type TaskRepo = z.infer<typeof taskRepoSchema>;

export async function listRepos(env: Env, traceId?: string): Promise<TaskRepo[]> {
  const cached = cachedReposSchema.safeParse(await env.DISCORD_KV.get(REPOS_CACHE_KEY, "json"));
  if (cached.success) return cached.data;

  const response = await signedControlPlaneFetch(
    env,
    { method: "GET", url: "https://internal/repos", traceId },
    { headers: { Accept: "application/json" } }
  );
  if (!response.ok) {
    throw new Error(`Control plane GET /repos failed with ${response.status}`);
  }
  const parsed = controlPlaneReposResponseSchema.parse(await response.json());
  const repos: TaskRepo[] = parsed.repos
    .filter((repo) => !repo.archived)
    .map((repo) => ({ owner: repo.owner, name: repo.name, fullName: repo.fullName }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));

  await env.DISCORD_KV.put(REPOS_CACHE_KEY, JSON.stringify(repos), {
    expirationTtl: REPOS_CACHE_TTL_SECONDS,
  });
  return repos;
}

/**
 * Case-insensitive match on any part of `owner/name`. Names too long for a
 * choice are left out rather than breaking the list; they can still be typed.
 */
export function repoChoices(repos: TaskRepo[], query: string): { name: string; value: string }[] {
  const needle = query.trim().toLowerCase();
  return repos
    .filter((repo) => repo.fullName.length <= MAX_CHOICE_LENGTH)
    .filter((repo) => repo.fullName.toLowerCase().includes(needle))
    .slice(0, MAX_CHOICES)
    .map((repo) => ({ name: repo.fullName, value: repo.fullName }));
}

/** Resolve user input to a known repository, ignoring case. */
export function findRepo(repos: TaskRepo[], input: string): TaskRepo | undefined {
  const wanted = input.trim().toLowerCase();
  return repos.find((repo) => repo.fullName.toLowerCase() === wanted);
}

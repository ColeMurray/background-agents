/**
 * Session launch targets for the Slack bot.
 *
 * Every surface that picks "what to work on" — routing rules, clarification
 * quick-picks, the repository picker — resolves to a {@link SlackSessionTarget}:
 * a repository or a saved environment. Targets unify instead of migrate —
 * repositories never stop working; environments join them.
 *
 * This module owns the target-kind policy (value encoding, labels, launch
 * request fields, branch-preference applicability) so the message handler
 * stays orchestration-only.
 */

import { escapeMrkdwnText, type Environment, type RepoConfig } from "@open-inspect/shared";
import type { Env } from "./types";
import { getAvailableRepos } from "./classifier/repos";
import { getEnvironmentById } from "./classifier/environments";

export type SlackSessionTarget =
  | { kind: "repository"; repo: RepoConfig }
  | { kind: "environment"; environment: Environment };

/**
 * Prefix for environment values in Slack select options and quick-pick buttons.
 * Repository values are bare repo ids ("owner/name"), which always contain a
 * slash and never a colon-prefixed form, so the two namespaces cannot collide.
 * Mirrors the web picker's `env:<id>` select-value convention.
 */
const ENVIRONMENT_VALUE_PREFIX = "env:";

/** Reference decoded from a Slack option/button value — resolved against the live lists. */
export type SlackTargetRef =
  | { kind: "repository"; repoId: string }
  | { kind: "environment"; environmentId: string };

/** Stable option/button value for a target: the repo id or `env:<id>`. */
export function targetValue(target: SlackSessionTarget): string {
  return target.kind === "environment"
    ? `${ENVIRONMENT_VALUE_PREFIX}${target.environment.id}`
    : target.repo.id;
}

/**
 * Decode a Slack option/button value back into a target reference. Bare values
 * are repository ids — including every value in clarification messages posted
 * before environments existed.
 */
export function parseTargetValue(value: string): SlackTargetRef {
  if (value.startsWith(ENVIRONMENT_VALUE_PREFIX)) {
    return { kind: "environment", environmentId: value.slice(ENVIRONMENT_VALUE_PREFIX.length) };
  }
  return { kind: "repository", repoId: value };
}

/**
 * Resolve a Slack option/button value to a launchable target against the live
 * lists, or null when it no longer exists (deleted environment, repo access
 * revoked, stale message).
 */
export async function resolveTargetValue(
  env: Env,
  value: string,
  traceId?: string
): Promise<SlackSessionTarget | null> {
  const ref = parseTargetValue(value);
  if (ref.kind === "environment") {
    const environment = await getEnvironmentById(env, ref.environmentId, traceId);
    return environment ? { kind: "environment", environment } : null;
  }
  const repos = await getAvailableRepos(env, traceId);
  const repo = repos.find((r) => r.id === ref.repoId);
  return repo ? { kind: "repository", repo } : null;
}

/**
 * Canonical label for Slack `mrkdwn` text and callback contexts: the repo
 * fullName, or the environment name escaped for literal display. Environment
 * names are arbitrary user text (a name like `<!channel>` must never become a
 * live broadcast mention); repo fullNames are charset-constrained by GitHub.
 */
export function targetLabel(target: SlackSessionTarget): string {
  return target.kind === "environment"
    ? escapeMrkdwnText(target.environment.name)
    : target.repo.fullName;
}

/** Stable id for storage: the repo id ("owner/name") or environment id ("env_…"). */
export function targetId(target: SlackSessionTarget): string {
  return target.kind === "environment" ? target.environment.id : target.repo.id;
}

/**
 * Create-session request fields for a target: scalar repoOwner/repoName
 * (+ optional branch) or environmentId only — the create schema makes the two
 * mutually exclusive, and the environment defines its own branches.
 */
export function buildSessionTargetRequestFields(
  target: SlackSessionTarget,
  branch: string | undefined
): { repoOwner: string; repoName: string; branch?: string } | { environmentId: string } {
  return target.kind === "environment"
    ? { environmentId: target.environment.id }
    : { repoOwner: target.repo.owner, repoName: target.repo.name, branch };
}

/**
 * The repository whose per-user branch preference applies to this launch, or
 * null when none does — an environment defines its own branches.
 */
export function branchPreferenceRepo(target: SlackSessionTarget): RepoConfig | null {
  return target.kind === "repository" ? target.repo : null;
}

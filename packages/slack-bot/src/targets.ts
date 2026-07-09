/**
 * Session launch targets for the Slack bot.
 *
 * Every surface that picks "what to work on" — routing rules, clarification
 * quick-picks, the repository picker — resolves to a {@link SlackSessionTarget}:
 * a repository or a saved environment. Targets unify instead of migrate —
 * repositories never stop working; environments join them.
 */

import type { Environment, RepoConfig } from "@open-inspect/shared";

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

/** Canonical label for messages and callback contexts: repo fullName or environment name. */
export function targetLabel(target: SlackSessionTarget): string {
  return target.kind === "environment" ? target.environment.name : target.repo.fullName;
}

/** Stable id for storage: the repo id ("owner/name") or environment id ("env_…"). */
export function targetId(target: SlackSessionTarget): string {
  return target.kind === "environment" ? target.environment.id : target.repo.id;
}

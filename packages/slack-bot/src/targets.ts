/**
 * Session targets for the Slack bot.
 *
 * Every surface that picks "what to work on" — routing rules, clarification
 * quick-picks, the repository picker — resolves to a {@link SlackSessionTarget}:
 * a repository, a saved environment, or no repository. Targets unify instead
 * of migrate — repositories never stop working; other target kinds join them.
 *
 * This module owns the target-kind policy (value encoding, labels, launch
 * request fields, branch-preference applicability) so the message handler
 * stays orchestration-only. It is a pure leaf — no I/O — so anything,
 * including the types barrel, can import it.
 */

import type { RepoConfig } from "@open-inspect/shared/types/repository-catalog";
import type { Environment } from "@open-inspect/shared/types/environments";

export type SlackSessionTarget =
  | { kind: "repository"; repo: RepoConfig }
  | { kind: "environment"; environment: Environment }
  | { kind: "none" };

/**
 * Prefix for environment values in Slack select options and quick-pick buttons.
 * Repository values are bare repo ids ("owner/name"), which always contain a
 * slash and never a colon-prefixed form, so the two namespaces cannot collide.
 * Mirrors the web picker's `env:<id>` select-value convention.
 */
const ENVIRONMENT_VALUE_PREFIX = "env:";
export const NO_REPOSITORY_TARGET_VALUE = "__no_repository__";
export const NO_REPOSITORY_TARGET_LABEL = "No repository";

/** Reference decoded from a Slack option/button value — resolved against the live lists. */
export type SlackTargetRef =
  | { kind: "repository"; repoId: string }
  | { kind: "environment"; environmentId: string }
  | { kind: "none" };

/** Stable option/button value for a target: the repo id or `env:<id>`. */
export function targetValue(target: SlackSessionTarget): string {
  switch (target.kind) {
    case "repository":
      return target.repo.id;
    case "environment":
      return `${ENVIRONMENT_VALUE_PREFIX}${target.environment.id}`;
    case "none":
      return NO_REPOSITORY_TARGET_VALUE;
  }
}

/**
 * Decode a Slack option/button value back into a target reference. Bare values
 * are repository ids — including every value in clarification messages posted
 * before environments existed.
 */
export function parseTargetValue(value: string): SlackTargetRef {
  if (value === NO_REPOSITORY_TARGET_VALUE) {
    return { kind: "none" };
  }
  if (value.startsWith(ENVIRONMENT_VALUE_PREFIX)) {
    return { kind: "environment", environmentId: value.slice(ENVIRONMENT_VALUE_PREFIX.length) };
  }
  return { kind: "repository", repoId: value };
}

/**
 * Canonical display label: the repo fullName or the environment name, **raw**.
 * Environment names are arbitrary user text — every `mrkdwn` render site must
 * escape this with `escapeMrkdwnText` (a name like `<!channel>` must never
 * become a live broadcast mention). Stored records (thread sessions, callback
 * contexts) carry the raw label so the encoding stays a render concern.
 */
export function targetLabel(target: SlackSessionTarget): string {
  switch (target.kind) {
    case "repository":
      return target.repo.fullName;
    case "environment":
      return target.environment.name;
    case "none":
      return NO_REPOSITORY_TARGET_LABEL;
  }
}

/** Stable id for storage: the repo id ("owner/name") or environment id ("env_…"). */
export function targetId(target: SlackSessionTarget): string {
  switch (target.kind) {
    case "repository":
      return target.repo.id;
    case "environment":
      return target.environment.id;
    case "none":
      return NO_REPOSITORY_TARGET_VALUE;
  }
}

/**
 * Create-session request fields for a target: scalar repoOwner/repoName
 * (+ optional branch), environmentId only, or explicit null repository fields.
 * The create schema makes the target modes mutually exclusive.
 */
export function buildSessionTargetRequestFields(
  target: SlackSessionTarget,
  branch: string | undefined
):
  | { repoOwner: string; repoName: string; branch?: string }
  | { environmentId: string }
  | { repoOwner: null; repoName: null } {
  switch (target.kind) {
    case "repository":
      return { repoOwner: target.repo.owner, repoName: target.repo.name, branch };
    case "environment":
      return { environmentId: target.environment.id };
    case "none":
      return { repoOwner: null, repoName: null };
  }
}

/**
 * The repository whose per-user branch preference applies to this launch, or
 * null when none does — environments define their own branches and a
 * repository-less session has no branch.
 */
export function branchPreferenceRepo(target: SlackSessionTarget): RepoConfig | null {
  return target.kind === "repository" ? target.repo : null;
}

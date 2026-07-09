/**
 * Target resolution for the classifier's stages: matched keyword rules,
 * channel associations, and LLM-returned target ids → launchable
 * {@link SlackSessionTarget}s. Owns the environment fetch and target-kind
 * dispatch so the classifier only chooses between deterministic routing,
 * channel association, and LLM classification.
 */

import { isEnvironmentId, matchRoutingRules } from "@open-inspect/shared";
import type { Environment } from "../types";
import type { Env, RepoConfig } from "../types";
import { targetValue, type SlackSessionTarget } from "../targets";
import { getRoutingRules } from "./repos";
import { getAvailableEnvironments } from "./environments";

export interface ResolvedRoutingRuleTarget {
  target: SlackSessionTarget;
  keyword: string;
}

/**
 * Match the message against the workspace's routing rules and resolve each
 * matched rule to a launchable target, de-duplicated in rule order.
 *
 * Rules whose target is not in the accessible repo list (or, for
 * environment-targeted rules, not an existing environment) are skipped, so a
 * stale rule never routes to something the bot can't launch. Environments are
 * fetched only when a matched rule needs them.
 */
export async function resolveRoutingRuleTargets(
  env: Env,
  message: string,
  repos: RepoConfig[],
  traceId?: string
): Promise<ResolvedRoutingRuleTarget[]> {
  const matched = matchRoutingRules(message, await getRoutingRules(env, traceId));
  if (matched.length === 0) return [];

  const environments = matched.some((rule) => rule.targetType === "environment")
    ? await getAvailableEnvironments(env, traceId)
    : [];

  const targets = new Map<string, ResolvedRoutingRuleTarget>();
  for (const rule of matched) {
    let target: SlackSessionTarget | null = null;
    if (rule.targetType === "environment") {
      const environment = environments.find((e) => e.id === rule.target);
      if (environment) target = { kind: "environment", environment };
    } else {
      const repo = repos.find(
        (r) => r.fullName.toLowerCase() === rule.target || r.id.toLowerCase() === rule.target
      );
      if (repo) target = { kind: "repository", repo };
    }
    if (target && !targets.has(targetValue(target))) {
      targets.set(targetValue(target), { target, keyword: rule.keyword });
    }
  }

  return [...targets.values()];
}

/**
 * Resolve the targets associated with a Slack channel: environments and
 * repositories whose channel-association lists name the channel (environments
 * first, matching the web picker's grouping). The environments fetch fails
 * open to an empty list, so an outage degrades to repository-only matching.
 */
export async function resolveChannelTargets(
  env: Env,
  channelId: string,
  repos: RepoConfig[],
  traceId?: string
): Promise<SlackSessionTarget[]> {
  const environments = await getAvailableEnvironments(env, traceId);
  return [
    ...environments
      .filter((environment) => environment.channelAssociations?.includes(channelId))
      .map((environment): SlackSessionTarget => ({ kind: "environment", environment })),
    ...repos
      .filter((repo) => repo.channelAssociations?.includes(channelId))
      .map((repo): SlackSessionTarget => ({ kind: "repository", repo })),
  ];
}

/**
 * Resolve a target id returned by the LLM to a launchable target, or null when
 * it names nothing that exists. The ladder is deterministic: an `env_…` id can
 * only be an environment; otherwise repositories match first on id/fullName
 * (the pre-environment behavior), then environments by their unique
 * case-insensitive name — so a model that echoes the environment's name
 * instead of its id still resolves.
 */
export function matchTargetId(
  targetId: string,
  repos: RepoConfig[],
  environments: Environment[]
): SlackSessionTarget | null {
  if (isEnvironmentId(targetId)) {
    const environment = environments.find((e) => e.id === targetId);
    return environment ? { kind: "environment", environment } : null;
  }

  const lowered = targetId.toLowerCase();
  const repo = repos.find(
    (r) => r.id.toLowerCase() === lowered || r.fullName.toLowerCase() === lowered
  );
  if (repo) return { kind: "repository", repo };

  const environment = environments.find((e) => e.name.toLowerCase() === lowered);
  return environment ? { kind: "environment", environment } : null;
}

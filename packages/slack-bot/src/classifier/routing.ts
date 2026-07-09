/**
 * Deterministic routing-rule target resolution: matched keyword rules →
 * launchable {@link SlackSessionTarget}s. Owns the environment fetch and
 * target-kind dispatch so the classifier only chooses between deterministic
 * routing, channel association, and LLM classification.
 */

import { matchRoutingRules } from "@open-inspect/shared";
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

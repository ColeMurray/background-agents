/**
 * Target resolution for the classifier's stages: matched keyword rules,
 * channel associations, and LLM-returned target ids → launchable
 * {@link SlackSessionTarget}s. Every resolver works over the
 * {@link TargetCatalog} the classifier loads up front, so this module owns
 * target-kind dispatch and no fetching (routing rules aside).
 */

import { isEnvironmentId, matchRoutingRules } from "@open-inspect/shared";
import type { Env } from "../types";
import { targetValue, type SlackSessionTarget } from "../targets";
import { getRoutingRules } from "./repos";
import type { TargetCatalog } from "./catalog";

export interface ResolvedRoutingRuleTarget {
  target: SlackSessionTarget;
  keyword: string;
}

/**
 * Match the message against the workspace's routing rules and resolve each
 * matched rule to a launchable target, de-duplicated in rule order.
 *
 * Rules whose target is not in the catalog (repo access revoked, environment
 * deleted, stale rule) are skipped, so a rule never routes to something the
 * bot can't launch.
 */
export async function resolveRoutingRuleTargets(
  env: Env,
  message: string,
  catalog: TargetCatalog,
  traceId?: string
): Promise<ResolvedRoutingRuleTarget[]> {
  const matched = matchRoutingRules(message, await getRoutingRules(env, traceId));

  const targets = new Map<string, ResolvedRoutingRuleTarget>();
  for (const rule of matched) {
    let target: SlackSessionTarget | null = null;
    if (rule.targetType === "environment") {
      const environment = catalog.environments.find((e) => e.id === rule.target);
      if (environment) target = { kind: "environment", environment };
    } else {
      const repo = catalog.repos.find(
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
 * The catalog targets associated with a Slack channel: environments and
 * repositories whose channel-association lists name the channel (environments
 * first, matching the web picker's grouping).
 */
export function resolveChannelTargets(
  catalog: TargetCatalog,
  channelId: string
): SlackSessionTarget[] {
  return [
    ...catalog.environments
      .filter((environment) => environment.channelAssociations?.includes(channelId))
      .map((environment): SlackSessionTarget => ({ kind: "environment", environment })),
    ...catalog.repos
      .filter((repo) => repo.channelAssociations?.includes(channelId))
      .map((repo): SlackSessionTarget => ({ kind: "repository", repo })),
  ];
}

/**
 * Resolve a target id returned by the LLM to a launchable target, or null when
 * it names nothing in the catalog. The ladder is deterministic: an `env_…` id
 * can only be an environment; otherwise repositories match first on
 * id/fullName (the pre-environment behavior), then environments by their
 * unique case-insensitive name — so a model that echoes the environment's
 * name instead of its id still resolves.
 */
export function matchTargetId(targetId: string, catalog: TargetCatalog): SlackSessionTarget | null {
  if (isEnvironmentId(targetId)) {
    const environment = catalog.environments.find((e) => e.id === targetId);
    return environment ? { kind: "environment", environment } : null;
  }

  const lowered = targetId.toLowerCase();
  const repo = catalog.repos.find(
    (r) => r.id.toLowerCase() === lowered || r.fullName.toLowerCase() === lowered
  );
  if (repo) return { kind: "repository", repo };

  const environment = catalog.environments.find((e) => e.name.toLowerCase() === lowered);
  return environment ? { kind: "environment", environment } : null;
}

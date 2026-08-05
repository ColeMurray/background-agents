/**
 * Session target resolution for Linear issues.
 *
 * Owns the four-stage ladder — project mapping → team mapping → Linear's
 * repo-suggestions API → LLM classification — and the target-kind policy.
 * Team and project mappings may name a repository or a saved environment
 * (design §7.5); the suggestion and classification stages remain
 * repository-only. Targets unify instead of migrate — repository entries
 * never stop working; environments join them.
 */

import type {
  Env,
  Environment,
  AgentSessionWebhookIssue,
  IssueSession,
  StaticTargetConfig,
} from "./types";
import type { LinearApiClient } from "./utils/linear-client";
import { emitAgentActivity, getRepoSuggestions } from "./utils/linear-client";
import { splitRepoFullName } from "./utils/repo";
import { classifyRepo } from "./classifier";
import { getAvailableRepos } from "./classifier/repos";
import { getEnvironmentById } from "./environments";
import { getLinearConfig, type ResolvedLinearConfig } from "./utils/integration-config";
import { resolveStaticTarget } from "./model-resolution";
import { getProjectRepoMapping, getTeamRepoMapping } from "./kv-store";
import { createLogger } from "./logger";

const log = createLogger("target-resolution");

/** A resolved session target: a repository or a saved environment. */
export type SessionTarget =
  | { kind: "repository"; owner: string; name: string; fullName: string }
  | { kind: "environment"; environment: Environment };

/** Display label: the repo fullName or the environment name. */
export function targetLabel(target: SessionTarget): string {
  return target.kind === "environment" ? target.environment.name : target.fullName;
}

/** Stable id for logs: the repo fullName or the environment id ("env_…"). */
export function targetId(target: SessionTarget): string {
  return target.kind === "environment" ? target.environment.id : target.fullName;
}

/**
 * The repository whose integration settings govern this launch: the repo
 * itself, or the environment's primary repository — environment-level
 * integration settings are deferred (design §13.5). Private: every consumer
 * of the primary-repo rule goes through {@link resolveTargetIntegration}, so
 * environment-level settings later change exactly one function.
 */
function targetSettingsRepoFullName(target: SessionTarget): string {
  if (target.kind === "repository") return target.fullName;
  const primary = target.environment.repositories[0];
  return `${primary.repoOwner}/${primary.repoName}`;
}

/**
 * Everything the handler derives from a target's integration settings, so the
 * primary-repo rule for environments stays inside this module.
 */
export interface TargetIntegration {
  config: ResolvedLinearConfig;
  /** Whether the integration's enabled-repos allowlist admits this target. */
  enabled: boolean;
  /** Lowercased fullName of the repo whose settings governed the lookup. */
  settingsRepo: string;
  /** Display subject for the "integration is not enabled" error. */
  notEnabledSubject: string;
  /** Value for `LinearCallbackContext.repoFullName` — the context is echoed
   * back by the control plane and nothing reads this field today. */
  callbackRepoFullName: string;
}

/**
 * Resolve the integration settings governing a target launch.
 */
export async function resolveTargetIntegration(
  env: Env,
  target: SessionTarget
): Promise<TargetIntegration> {
  const callbackRepoFullName = targetSettingsRepoFullName(target);
  const settingsRepo = callbackRepoFullName.toLowerCase();
  const config = await getLinearConfig(env, settingsRepo);
  return {
    config,
    enabled: config.enabledRepos === null || config.enabledRepos.includes(settingsRepo),
    settingsRepo,
    notEnabledSubject:
      target.kind === "environment"
        ? `environment \`${targetLabel(target)}\` (primary repository \`${settingsRepo}\`)`
        : `\`${targetLabel(target)}\``,
    callbackRepoFullName,
  };
}

/**
 * Create-session request fields for a target: scalar repoOwner/repoName or
 * environmentId only — the create schema makes the two mutually exclusive.
 */
export function targetRequestFields(
  target: SessionTarget
): { repoOwner: string; repoName: string } | { environmentId: string } {
  return target.kind === "environment"
    ? { environmentId: target.environment.id }
    : { repoOwner: target.owner, repoName: target.name };
}

function repositoryTarget(owner: string, name: string, fullName?: string): SessionTarget {
  return { kind: "repository", owner, name, fullName: fullName ?? `${owner}/${name}` };
}

/** Rehydrate the stable target identity stored for an existing issue session. */
export async function resolveStoredSessionTarget(
  env: Env,
  session: IssueSession,
  traceId: string
): Promise<SessionTarget | null> {
  if (session.repoOwner && session.repoName) {
    return repositoryTarget(session.repoOwner, session.repoName);
  }
  if (session.environmentId) {
    const environment = await getEnvironmentById(env, session.environmentId, traceId);
    if (environment) return { kind: "environment", environment };
    log.warn("target.stored_environment_not_found", {
      trace_id: traceId,
      environment_id: session.environmentId,
    });
  }
  return null;
}

/**
 * Resolve a mapping entry to a target. Environment entries are validated
 * against the live environment list; an unknown (deleted or unfetchable)
 * environment returns null so resolution falls through to the next stage,
 * like a rule targeting an inaccessible repository.
 */
async function resolveMappedTarget(
  env: Env,
  config: StaticTargetConfig,
  traceId: string
): Promise<SessionTarget | null> {
  if ("environmentId" in config) {
    const environment = await getEnvironmentById(env, config.environmentId, traceId);
    if (!environment) {
      log.warn("target.environment_not_found", {
        trace_id: traceId,
        environment_id: config.environmentId,
      });
      return null;
    }
    return { kind: "environment", environment };
  }
  return repositoryTarget(config.owner, config.name);
}

export interface ResolveSessionTargetParams {
  env: Env;
  client: LinearApiClient;
  agentSessionId: string;
  issue: AgentSessionWebhookIssue;
  labelNames: string[];
  projectInfo: { id: string; name: string } | null | undefined;
  comment: { body: string } | null | undefined;
  traceId: string;
}

export interface ResolvedSessionTarget {
  target: SessionTarget;
  reasoning: string | null;
}

/**
 * Resolve the session target for an issue, or null after eliciting
 * clarification from the user (classification too uncertain to act on).
 */
export async function resolveSessionTarget(
  params: ResolveSessionTargetParams
): Promise<ResolvedSessionTarget | null> {
  const { env, client, agentSessionId, issue, labelNames, projectInfo, comment, traceId } = params;

  // 1. Check project→target mapping FIRST
  if (projectInfo?.id) {
    const projectMapping = await getProjectRepoMapping(env);
    const mapped = projectMapping[projectInfo.id];
    if (mapped) {
      const target = await resolveMappedTarget(env, mapped, traceId);
      if (target) {
        return {
          target,
          reasoning: `Project "${projectInfo.name}" is mapped to ${targetLabel(target)}`,
        };
      }
    }
  }

  // 2. Check static team→target mapping (override)
  const teamId = issue.team?.id ?? "";
  if (teamId) {
    const teamMapping = await getTeamRepoMapping(env);
    const staticConfig = resolveStaticTarget(teamMapping, teamId, labelNames);
    if (staticConfig) {
      const target = await resolveMappedTarget(env, staticConfig, traceId);
      if (target) return { target, reasoning: "Team static mapping" };
    }
  }

  // 3. Try Linear's built-in issueRepositorySuggestions API
  const repos = await getAvailableRepos(env, traceId);
  if (repos.length > 0) {
    const candidates = repos.map((r) => ({
      hostname: "github.com",
      repositoryFullName: `${r.owner}/${r.name}`,
    }));

    const suggestions = await getRepoSuggestions(client, issue.id, agentSessionId, candidates);
    const topSuggestion = suggestions.find((s) => s.confidence >= 0.7);
    if (topSuggestion) {
      // Split on the last slash — GitLab nested-group paths
      // ("group/subgroup/project") carry slashes in the owner.
      const { owner, name } = splitRepoFullName(topSuggestion.repositoryFullName);
      return {
        target: repositoryTarget(owner, name, topSuggestion.repositoryFullName),
        reasoning: `Linear suggested ${topSuggestion.repositoryFullName} (confidence: ${Math.round(topSuggestion.confidence * 100)}%)`,
      };
    }
  }

  // 4. Fall back to our LLM classification
  await emitAgentActivity(
    client,
    agentSessionId,
    {
      type: "thought",
      body: "Classifying repository using AI...",
    },
    true
  );

  const classification = await classifyRepo(
    env,
    issue.title,
    issue.description,
    labelNames,
    projectInfo?.name,
    issue.team?.name ?? null,
    issue.team?.key ?? null,
    comment?.body,
    traceId
  );

  if (classification.needsClarification || !classification.repo) {
    const altList = (classification.alternatives || [])
      .map((r) => `- **${r.fullName}**: ${r.description}`)
      .join("\n");

    await emitAgentActivity(client, agentSessionId, {
      type: "elicitation",
      body: `I couldn't determine which repository to work on.\n\n${classification.reasoning}\n\n**Available repositories:**\n${altList || "None available"}\n\nPlease reply with the repository name (e.g., \`owner/repo\`).`,
    });

    log.warn("agent_session.classification_uncertain", {
      trace_id: traceId,
      issue_identifier: issue.identifier,
      confidence: classification.confidence,
      reasoning: classification.reasoning,
    });
    return null;
  }

  return {
    target: repositoryTarget(
      classification.repo.owner,
      classification.repo.name,
      classification.repo.fullName
    ),
    reasoning: classification.reasoning,
  };
}

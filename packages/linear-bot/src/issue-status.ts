/**
 * Issue workflow state transitions.
 *
 * Resolves configured state names to Linear state IDs (with KV caching)
 * and performs issue updates at key session lifecycle points.
 */

import type { Env } from "./types";
import type { LinearApiClient, WorkflowState } from "./utils/linear-client";
import { fetchTeamWorkflowStates, updateIssueState } from "./utils/linear-client";
import type { ResolvedLinearConfig } from "./utils/integration-config";
import { createLogger } from "./logger";

const log = createLogger("issue-status");

const STATES_CACHE_TTL_SECONDS = 900; // 15 minutes

export type IssueTransition = "inProgress" | "completed" | "cancelled";

/** Default mapping from transition type to Linear WorkflowStateType for fallback. */
const TRANSITION_TYPE_FALLBACK: Record<IssueTransition, string> = {
  inProgress: "started",
  completed: "completed",
  cancelled: "canceled", // Linear uses American spelling
};

/**
 * Resolve a configured state name to a Linear state ID.
 * First tries exact name match (case-insensitive), then falls back
 * to matching by Linear's WorkflowStateType.
 */
export function resolveStateId(
  states: WorkflowState[],
  stateName: string,
  transitionType: IssueTransition
): string | null {
  const byName = states.find((s) => s.name.toLowerCase() === stateName.toLowerCase());
  if (byName) return byName.id;

  const fallbackType = TRANSITION_TYPE_FALLBACK[transitionType];
  const byType = states.find((s) => s.type === fallbackType);
  if (byType) return byType.id;

  return null;
}

/** Fetch team workflow states, using KV cache to avoid repeated API calls. */
async function getTeamStates(
  env: Env,
  client: LinearApiClient,
  teamId: string
): Promise<WorkflowState[]> {
  const cacheKey = `states:${teamId}`;

  try {
    const cached = await env.LINEAR_KV.get(cacheKey, "json");
    if (cached && Array.isArray(cached)) {
      return cached as WorkflowState[];
    }
  } catch {
    /* cache miss */
  }

  const states = await fetchTeamWorkflowStates(client, teamId);
  if (states.length > 0) {
    await env.LINEAR_KV.put(cacheKey, JSON.stringify(states), {
      expirationTtl: STATES_CACHE_TTL_SECONDS,
    });
  }
  return states;
}

function getStateNameForTransition(
  transition: IssueTransition,
  config: ResolvedLinearConfig
): string | null {
  switch (transition) {
    case "inProgress":
      return config.statusMapping.inProgressStateName;
    case "completed":
      return config.statusMapping.completedStateName;
    case "cancelled":
      return config.statusMapping.cancelledStateName;
  }
}

/**
 * Transition a Linear issue's workflow state.
 * No-op if the feature is disabled or the state cannot be resolved.
 */
export async function transitionIssueStatus(
  env: Env,
  client: LinearApiClient,
  issueId: string,
  teamId: string,
  transition: IssueTransition,
  config: ResolvedLinearConfig,
  traceId?: string
): Promise<void> {
  if (!config.updateIssueStatus) return;

  const stateName = getStateNameForTransition(transition, config);
  if (!stateName) {
    log.debug("issue_status.skipped", {
      trace_id: traceId,
      issue_id: issueId,
      transition,
      reason: "no_state_name_configured",
    });
    return;
  }

  const states = await getTeamStates(env, client, teamId);
  if (states.length === 0) {
    log.warn("issue_status.no_states", {
      trace_id: traceId,
      issue_id: issueId,
      team_id: teamId,
    });
    return;
  }

  const stateId = resolveStateId(states, stateName, transition);
  if (!stateId) {
    log.warn("issue_status.state_not_found", {
      trace_id: traceId,
      issue_id: issueId,
      team_id: teamId,
      transition,
      configured_state_name: stateName,
    });
    return;
  }

  const success = await updateIssueState(client, issueId, stateId);
  log.info("issue_status.transition", {
    trace_id: traceId,
    issue_id: issueId,
    team_id: teamId,
    transition,
    state_name: stateName,
    state_id: stateId,
    success,
  });
}

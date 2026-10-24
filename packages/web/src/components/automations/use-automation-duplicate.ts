"use client";

import { useState } from "react";
import { useAutomation } from "@/hooks/use-automations";
import { useEnvironments } from "@/hooks/use-environments";
import { useRepos } from "@/hooks/use-repos";
import { useResourceTeams } from "@/hooks/use-resource-teams";
import { createAutomationDuplicate, type AutomationDuplicate } from "./automation-form-policy";

export type AutomationDuplicateState =
  | { status: "loading" }
  /** The source loaded, but the viewer's team or target choices didn't; SWR retries them. */
  | { status: "unavailable" }
  | { status: "failed" }
  | { status: "ready"; duplicate: AutomationDuplicate };

/**
 * The create-form seed for a copy of automation `sourceId`, or null when there is no source.
 * The form reads its initial values once on mount, so the seed is fixed the first time the
 * source settles: later revalidations (window focus, error retries, cache invalidation) must not
 * remount or reseed the form and discard the user's edits.
 */
export function useAutomationDuplicate(
  sourceId: string | undefined,
  { fallbackTeamId, requireTeam }: { fallbackTeamId: string | null; requireTeam: boolean }
): AutomationDuplicateState | null {
  const { automation: source, loading: sourceLoading } = useAutomation(sourceId);
  const scope = useResourceTeams("automation");
  const sourceTeamId = source?.ownerTeamId ?? null;
  const repos = useRepos(Boolean(source), sourceTeamId);
  const environments = useEnvironments({ ownerTeamId: sourceTeamId }, Boolean(source));
  const [settled, setSettled] = useState<{
    sourceId: string;
    state: AutomationDuplicateState;
  } | null>(null);

  if (!sourceId) return null;
  if (settled?.sourceId === sourceId) return settled.state;
  if (sourceLoading || (source && (scope.loading || repos.loading || environments.loading))) {
    return { status: "loading" };
  }
  // Settling on a failed lookup would wrongly reset the team or drop usable targets for good.
  if (source && (scope.error || repos.error || environments.error)) {
    return { status: "unavailable" };
  }

  const teamSelectable = sourceTeamId
    ? scope.teams.some((team) => team.id === sourceTeamId)
    : scope.allowWorkspace && !requireTeam;
  const state: AutomationDuplicateState = source
    ? {
        status: "ready",
        duplicate: createAutomationDuplicate(source, {
          teamSelectable,
          fallbackTeamId,
          usableRepositoryKeys: repos.repos.map((repo) => repo.fullName.toLowerCase()),
          usableEnvironmentIds: environments.environments
            .filter((environment) => environment.capabilities?.canUse === true)
            .map((environment) => environment.id),
        }),
      }
    : { status: "failed" };
  setSettled({ sourceId, state });
  return state;
}

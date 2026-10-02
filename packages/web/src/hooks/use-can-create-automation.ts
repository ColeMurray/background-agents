"use client";

import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { useMeTeams } from "@/hooks/use-teams";

/**
 * Whether the viewer may create automations from this scope: the `automations.create`
 * permission and, for a team scope, membership of that team (executors must be members).
 */
export function useCanCreateAutomation(teamId?: string) {
  const { hasPermission, loading: authorizationLoading } = useCurrentUserAuthorization();
  const membership = useMeTeams(Boolean(teamId));
  const membershipLoading = Boolean(teamId) && membership.loading;
  const canCreate =
    hasPermission("automations.create") &&
    (!teamId ||
      (!membershipLoading &&
        !membership.error &&
        membership.teams.some((team) => team.id === teamId)));
  return { canCreate, loading: authorizationLoading || membershipLoading };
}

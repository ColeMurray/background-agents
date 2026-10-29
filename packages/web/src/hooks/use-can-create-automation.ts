"use client";

import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { useMeTeams } from "@/hooks/use-teams";

/**
 * Whether the viewer may create automations from this scope, mirroring `POST /automations`:
 * `automations.create`, `sessions.create` (the creator becomes the executor, whose runs create
 * sessions), and, for a team scope, membership of that team (executors must be members).
 */
export function useCanCreateAutomation(teamId?: string) {
  const { hasPermission, loading: authorizationLoading } = useCurrentUserAuthorization();
  const membership = useMeTeams(Boolean(teamId));
  const membershipLoading = Boolean(teamId) && membership.loading;
  const canCreate =
    hasPermission("automations.create") &&
    hasPermission("sessions.create") &&
    (!teamId ||
      (!membershipLoading &&
        !membership.error &&
        membership.teams.some((team) => team.id === teamId)));
  return { canCreate, loading: authorizationLoading || membershipLoading };
}

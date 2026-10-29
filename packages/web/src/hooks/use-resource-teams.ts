"use client";

import { useMeTeams, useTeams } from "./use-teams";

/** Creation choices use executor memberships or server team capabilities. */
export function useResourceTeams(resource: "automation" | "environment") {
  const directory = useTeams();
  const membership = useMeTeams();
  const loading = directory.loading || membership.loading;
  const error = directory.error || membership.error;
  const allTeams = directory.teams;
  const teams =
    loading || error
      ? []
      : allTeams.filter(
          (team) =>
            team.archivedAt === null &&
            (resource === "automation"
              ? membership.teams.some((member) => member.id === team.id)
              : team.capabilities?.canManageEnvironments === true)
        );
  return {
    teams,
    allTeams,
    loading,
    error,
    allowWorkspace: !membership.requireTeamOnCreate,
  };
}

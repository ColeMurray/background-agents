"use client";

import { useTeam } from "@/hooks/use-teams";
import { useTeamCapabilities } from "@/hooks/use-team-capabilities";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { EnvironmentsSettings } from "@/components/settings/environments-settings";

export function TeamEnvironments({ teamId }: { teamId: string }) {
  const { team } = useTeam(teamId);
  const capabilities = useTeamCapabilities(team);
  const { hasPermission } = useCurrentUserAuthorization();
  return (
    <EnvironmentsSettings
      teamId={teamId}
      canCreate={capabilities.canEditMetadata && hasPermission("environments.manage")}
    />
  );
}

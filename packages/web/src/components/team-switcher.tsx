"use client";

import { useActiveTeam } from "@/hooks/use-active-team";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export function TeamSwitcher() {
  const { activeTeamId, setActiveTeam, teams, scope } = useActiveTeam();
  const { authorization } = useCurrentUserAuthorization();
  const canListAllTeams =
    authorization?.role.key === "owner" || authorization?.role.key === "administrator";
  if (teams.length < 2) return null;

  return (
    <Select
      value={
        activeTeamId ??
        (scope === "workspace" ? "workspace" : scope === "all" ? "all-teams" : "all-my-teams")
      }
      onValueChange={(value) => setActiveTeam(value === "workspace" ? null : value)}
    >
      <SelectTrigger
        aria-label="Active team"
        density="compact"
        className="h-8 min-w-0 flex-1 border-transparent bg-transparent"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="workspace">Workspace</SelectItem>
        {teams.map((team) => (
          <SelectItem key={team.id} value={team.id}>
            {team.name}
          </SelectItem>
        ))}
        <SelectItem value="all-my-teams">All my teams</SelectItem>
        {canListAllTeams && <SelectItem value="all-teams">All teams</SelectItem>}
      </SelectContent>
    </Select>
  );
}

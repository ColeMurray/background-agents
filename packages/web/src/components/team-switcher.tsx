"use client";

import { isWorkspaceAdmin } from "@open-inspect/shared/rbac";
import Link from "next/link";
import { useActiveTeam } from "@/hooks/use-active-team";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export function TeamSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const { activeTeamId, setActiveTeam, teams, scope } = useActiveTeam();
  const { authorization } = useCurrentUserAuthorization();
  const canListAllTeams = isWorkspaceAdmin(authorization?.role.key);
  const activeTeam = teams.find((team) => team.id === activeTeamId);
  if (teams.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
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
      {activeTeam && (
        <Link
          href={`/teams/${encodeURIComponent(activeTeam.slug)}`}
          onClick={onNavigate}
          aria-label={`${activeTeam.name} team page`}
          className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
        >
          Team page
        </Link>
      )}
    </div>
  );
}

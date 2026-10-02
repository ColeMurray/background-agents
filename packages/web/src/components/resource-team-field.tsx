"use client";

import { useId } from "react";
import type { TeamResponse } from "@/hooks/use-teams";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Radix reserves the empty string for "no selection", so workspace ownership needs a sentinel.
const WORKSPACE_VALUE = "workspace";

export function ResourceTeamField({
  teamId,
  teams,
  allTeams,
  disabled,
  loading,
  error,
  onChange,
  allowWorkspace = true,
}: {
  teamId: string | null;
  teams: Pick<TeamResponse, "id" | "name">[];
  allTeams: Pick<TeamResponse, "id" | "name">[];
  disabled: boolean;
  loading: boolean;
  error: unknown;
  onChange: (teamId: string | null) => void;
  allowWorkspace?: boolean;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-foreground mb-1.5">
        Team
      </label>
      <Select
        value={teamId ?? (allowWorkspace ? WORKSPACE_VALUE : "")}
        disabled={disabled || loading || !!error}
        onValueChange={(value) => onChange(value === WORKSPACE_VALUE ? null : value)}
      >
        <SelectTrigger id={id}>
          <SelectValue placeholder="Select a team" />
        </SelectTrigger>
        <SelectContent>
          {allowWorkspace && <SelectItem value={WORKSPACE_VALUE}>Workspace (no team)</SelectItem>}
          {teamId && !teams.some((team) => team.id === teamId) && (
            <SelectItem value={teamId} disabled>
              {allTeams.find((team) => team.id === teamId)?.name ?? "Current team unavailable"}
            </SelectItem>
          )}
          {teams.map((team) => (
            <SelectItem key={team.id} value={team.id}>
              {team.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          Unable to load teams.
        </p>
      ) : null}
      {!allowWorkspace && !teamId && !error && (
        <p className="mt-1 text-xs text-muted-foreground">A team is required.</p>
      )}
    </div>
  );
}

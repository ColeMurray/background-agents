"use client";

import { useId } from "react";
import type { TeamResponse } from "@/hooks/use-teams";

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
      <select
        id={id}
        value={teamId ?? ""}
        disabled={disabled || loading || !!error}
        onChange={(event) => onChange(event.target.value || null)}
        className="w-full rounded-sm border border-border bg-input px-3 py-2 text-sm text-foreground disabled:opacity-50"
      >
        <option value="" disabled={!allowWorkspace}>
          {allowWorkspace ? "Workspace (no team)" : "Select a team"}
        </option>
        {teamId && !teams.some((team) => team.id === teamId) && (
          <option value={teamId} disabled>
            {allTeams.find((team) => team.id === teamId)?.name ?? "Current team unavailable"}
          </option>
        )}
        {teams.map((team) => (
          <option key={team.id} value={team.id}>
            {team.name}
          </option>
        ))}
      </select>
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

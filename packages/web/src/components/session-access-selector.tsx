"use client";

import { useId, useState } from "react";
import type { SessionVisibility } from "@open-inspect/shared/types/teams";
import { BuildingIcon, CheckIcon, ChevronDownIcon, LockIcon, UsersIcon } from "./ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

export function SessionAccessSelector({
  teamId,
  teams,
  visibility,
  onTeamChange,
  onVisibilityChange,
  requireTeamOnCreate = false,
  disabled = false,
  visibilityDisabled = false,
}: {
  teamId: string | null;
  teams: { id: string; name: string }[];
  visibility: SessionVisibility;
  onTeamChange: (teamId: string | null) => void;
  onVisibilityChange: (visibility: SessionVisibility) => void;
  requireTeamOnCreate?: boolean;
  disabled?: boolean;
  visibilityDisabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [teamSelectOpen, setTeamSelectOpen] = useState(false);
  const descriptionId = useId();
  const team = teams.find((item) => item.id === teamId);
  const teamLabel = team ? `${team.name} team` : "Team";
  const label =
    visibility === "private" ? "Private" : visibility === "team" ? teamLabel : "Workspace";
  const Icon =
    visibility === "private" ? LockIcon : visibility === "team" ? UsersIcon : BuildingIcon;
  const options = [
    {
      value: "private",
      label: "Private",
      Icon: LockIcon,
      description: "Session owner and added collaborators; workspace owners have audited access",
    },
    {
      value: "team",
      label: teamLabel,
      Icon: UsersIcon,
      description: team ? "Team members and workspace admins" : "Choose a team context first",
    },
    {
      value: "workspace",
      label: "Workspace",
      Icon: BuildingIcon,
      description: "Anyone in your workspace with session access",
    },
  ];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Session access: ${label}; team context: ${team?.name ?? "No team"}`}
          title={`Session access: ${label}. Team context: ${team?.name ?? "No team"}.`}
          className="mt-2 flex max-w-full items-center gap-1.5 rounded-sm py-1 text-xs text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{label}</span>
          <ChevronDownIcon className="h-3.5 w-3.5 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={16}
        aria-label="Session access"
        onEscapeKeyDown={(event) => {
          if (teamSelectOpen) event.preventDefault();
        }}
        className="w-64 max-w-[calc(100vw-2rem)] rounded-sm p-1.5"
      >
        <ToggleGroup
          type="single"
          orientation="vertical"
          role="radiogroup"
          aria-label="Session audience"
          value={visibility}
          disabled={disabled || visibilityDisabled}
          onValueChange={(value) => {
            if (value === "private" || value === "team" || value === "workspace") {
              onVisibilityChange(value);
            }
          }}
          className="flex-col items-stretch gap-0"
        >
          {options.map((option) => (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              disabled={option.value === "team" && !team}
              aria-label={option.label}
              aria-describedby={`${descriptionId}-${option.value}`}
              title={option.description}
              onClick={() => setOpen(false)}
              className="h-auto min-h-[34px] w-full justify-start gap-2 rounded-sm px-2 py-1.5 text-xs font-normal hover:text-foreground data-[state=on]:bg-accent-muted data-[state=on]:text-foreground [&_svg]:size-3.5"
            >
              <option.Icon aria-hidden="true" />
              <span className="min-w-0 truncate">{option.label}</span>
              <span id={`${descriptionId}-${option.value}`} className="sr-only">
                {option.description}
              </span>
              {visibility === option.value && <CheckIcon className="ml-auto text-accent" />}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-border px-2 pt-2 pb-0.5">
          <span className="shrink-0 text-[11px] text-muted-foreground">Team context</span>
          <Select
            open={teamSelectOpen}
            onOpenChange={setTeamSelectOpen}
            value={teamId ?? "workspace"}
            onValueChange={(value) => onTeamChange(value === "workspace" ? null : value)}
            disabled={disabled || teams.length === 0}
          >
            <SelectTrigger
              aria-label="Team context"
              aria-describedby={`${descriptionId}-context`}
              title="Groups the session; does not grant viewing access."
              density="compact"
              className="w-auto min-w-0 max-w-[9.25rem] justify-start gap-1.5 border-0 bg-transparent px-0 text-xs"
            >
              <UsersIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <SelectValue placeholder="Choose a team" />
            </SelectTrigger>
            <SelectContent
              align="end"
              collisionPadding={16}
              onEscapeKeyDown={(event) => {
                event.preventDefault();
                setTeamSelectOpen(false);
              }}
            >
              {!requireTeamOnCreate && (
                <SelectItem
                  value="workspace"
                  disabled={visibility === "team"}
                  title={visibility === "team" ? "Choose Private or Workspace first" : undefined}
                >
                  No team
                </SelectItem>
              )}
              {teams.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span id={`${descriptionId}-context`} className="sr-only">
            Groups the session; does not grant viewing access.
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

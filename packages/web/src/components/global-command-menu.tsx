"use client";

import { useEffect, useMemo, useState } from "react";
import { formatRelativeTime } from "@/lib/time";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { formatRepoLabel } from "@/lib/repo-label";
import { buildSessionSearchValue, type SessionListItem } from "@/lib/session-list";
import { AutomationsIcon, BranchIcon, PlusIcon, SettingsIcon } from "@/components/ui/icons";
import { AppIcon } from "@/components/ui/app-icon";
import { DEFAULT_SETTINGS_QUERY, getSettingsGroups } from "@/components/settings/settings-registry";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";

interface GlobalCommandMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (href: string) => void;
  onNewSession: () => void;
  sessions: SessionListItem[];
}

function buildSessionUrl(session: SessionListItem): string {
  const searchParams = new URLSearchParams();
  if (session.repoOwner && session.repoName) {
    searchParams.set("repoOwner", session.repoOwner);
    searchParams.set("repoName", session.repoName);
  }

  if (session.title) {
    searchParams.set("title", session.title);
  }

  const query = searchParams.toString();
  return query ? `/session/${session.id}?${query}` : `/session/${session.id}`;
}

export function GlobalCommandMenu({
  open,
  onOpenChange,
  onNavigate,
  onNewSession,
  sessions,
}: GlobalCommandMenuProps) {
  const { labels } = useKeyboardShortcuts();
  const [query, setQuery] = useState(DEFAULT_SETTINGS_QUERY);
  const searchableSessions = useMemo(
    () => sessions.filter((session) => session.status !== "archived"),
    [sessions]
  );
  const settingsGroups = getSettingsGroups({ query, includeGlobalAliases: true });

  useEffect(() => {
    if (!open) setQuery(DEFAULT_SETTINGS_QUERY);
  }, [open]);

  const handleSelect = (callback: () => void) => {
    onOpenChange(false);
    callback();
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <DialogTitle className="sr-only">Command menu</DialogTitle>
      <DialogDescription className="sr-only">
        Search and jump to sessions, settings, automations, and other destinations.
      </DialogDescription>
      <Command>
        <CommandInput
          placeholder="Search sessions, settings, and commands..."
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>

          <CommandGroup heading="Navigation">
            <CommandItem onSelect={() => handleSelect(onNewSession)}>
              <PlusIcon className="h-4 w-4" />
              <span>New session</span>
              <CommandShortcut>{labels["new-session"]}</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={() => handleSelect(() => onNavigate("/"))}>
              <AppIcon className="h-4 w-4" />
              <span>Home</span>
            </CommandItem>
            <CommandItem onSelect={() => handleSelect(() => onNavigate("/settings"))}>
              <SettingsIcon className="h-4 w-4" />
              <span>Settings</span>
            </CommandItem>
            <CommandItem onSelect={() => handleSelect(() => onNavigate("/automations"))}>
              <AutomationsIcon className="h-4 w-4" />
              <span>Automations</span>
            </CommandItem>
          </CommandGroup>

          <CommandSeparator />
          <CommandGroup heading="Settings">
            {settingsGroups.flatMap((group) =>
              group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <CommandItem
                    key={item.id}
                    forceMount
                    value={`settings ${group.label} ${item.label} ${item.description} ${item.keywords}`}
                    onSelect={() => handleSelect(() => onNavigate(`/settings?tab=${item.id}`))}
                    className="items-start"
                  >
                    <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{item.label}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {item.description}
                      </div>
                    </div>
                    <CommandShortcut>{group.label}</CommandShortcut>
                  </CommandItem>
                );
              })
            )}
          </CommandGroup>

          {searchableSessions.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Sessions">
                {searchableSessions.map((session) => {
                  const repoLabel = formatRepoLabel(session.repoOwner, session.repoName);
                  const sessionTitle = session.title || repoLabel;
                  const timestamp = session.updatedAt || session.createdAt;

                  return (
                    <CommandItem
                      key={session.id}
                      value={buildSessionSearchValue(session)}
                      onSelect={() => handleSelect(() => onNavigate(buildSessionUrl(session)))}
                      className="items-start"
                    >
                      <BranchIcon className="mt-0.5 h-4 w-4 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{sessionTitle}</div>
                        <div className="text-xs text-muted-foreground truncate">{repoLabel}</div>
                      </div>
                      <CommandShortcut>{formatRelativeTime(timestamp)}</CommandShortcut>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

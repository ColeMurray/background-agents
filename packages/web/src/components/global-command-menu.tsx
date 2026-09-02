"use client";

import { useMemo } from "react";
import { useCommandState } from "cmdk";
import { formatRelativeTime } from "@/lib/time";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { formatRepoLabel } from "@/lib/repo-label";
import { buildSessionSearchValue, type SessionListItem } from "@/lib/session-list";
import { matchesSearchTerms } from "@/lib/search";
import { BranchIcon, PlusIcon } from "@/components/ui/icons";
import { AppIcon } from "@/components/ui/app-icon";
import { APP_DESTINATIONS } from "@/components/app-destinations";
import { getSettingsGroups } from "@/components/settings/settings-registry";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
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

function filterCommandItem(value: string, search: string, keywords?: string[]): number {
  return matchesSearchTerms(`${value} ${keywords?.join(" ") ?? ""}`, search) ? 1 : 0;
}

function CommandMenuFooter() {
  const count = useCommandState((state) => state.filtered.count);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-2 text-[11px] text-muted-foreground">
      <span role="status" aria-live="polite" className="mr-auto">
        {count} {count === 1 ? "result" : "results"}
      </span>
      <span>
        <kbd className="font-sans text-foreground">↑↓</kbd> Navigate
      </span>
      <span>
        <kbd className="font-sans text-foreground">Enter</kbd> Select
      </span>
      <span>
        <kbd className="font-sans text-foreground">Esc</kbd> Close
      </span>
    </div>
  );
}

/**
 * Provides global navigation and search while exposing only settings destinations the user may access.
 */
export function GlobalCommandMenu({
  open,
  onOpenChange,
  onNavigate,
  onNewSession,
  sessions,
}: GlobalCommandMenuProps) {
  const { labels } = useKeyboardShortcuts();
  const { hasPermission } = useCurrentUserAuthorization();
  const searchableSessions = useMemo(
    () => sessions.filter((session) => session.status !== "archived"),
    [sessions]
  );
  const settingsGroups = getSettingsGroups({ hasPermission });
  const canCreateSession = hasPermission("sessions.create");

  const handleSelect = (callback: () => void) => {
    onOpenChange(false);
    callback();
  };

  const navigationItems = [
    ...(canCreateSession
      ? [
          {
            label: "New session",
            description: "Start a coding session",
            Icon: PlusIcon,
            onSelect: onNewSession,
            shortcut: labels["new-session"],
          },
          {
            label: "Home",
            description: "Ask a question or describe what you want to build",
            Icon: AppIcon,
            onSelect: () => onNavigate("/"),
            shortcut: undefined,
          },
        ]
      : []),
    ...APP_DESTINATIONS.filter(
      (destination) =>
        !("requiredPermission" in destination) || hasPermission(destination.requiredPermission)
    ).map(({ label, description, href, icon: Icon }) => ({
      label,
      description,
      Icon,
      onSelect: () => onNavigate(href),
      shortcut: undefined,
    })),
  ];

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <DialogTitle className="sr-only">Command menu</DialogTitle>
      <DialogDescription className="sr-only">
        Search and jump to sessions, settings, automations, and other destinations.
      </DialogDescription>
      <Command filter={filterCommandItem} label="Search commands, settings, and sessions">
        <CommandInput placeholder="Search sessions, settings, and commands..." />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>

          <CommandGroup heading="Navigation">
            {navigationItems.map(({ label, description, Icon, onSelect, shortcut }) => (
              <CommandItem
                key={label}
                value={`${label} ${description}`}
                onSelect={() => handleSelect(onSelect)}
                className="items-start"
              >
                <span aria-hidden="true" className="mt-0.5 shrink-0">
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate">{label}</div>
                  <div className="truncate text-xs text-muted-foreground">{description}</div>
                </div>
                {shortcut && <CommandShortcut>{shortcut}</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>

          <CommandSeparator />
          <CommandGroup heading="Settings">
            {settingsGroups.flatMap((group) =>
              group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <CommandItem
                    key={item.id}
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
        <CommandMenuFooter />
      </Command>
    </CommandDialog>
  );
}

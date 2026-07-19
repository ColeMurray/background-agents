"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useCallback } from "react";
import { useSession } from "next-auth/react";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import { useIsMobile } from "@/hooks/use-media-query";
import { useSidebarSessions } from "@/hooks/use-sidebar-sessions";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  SidebarIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  AutomationsIcon,
  DataControlsIcon,
} from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { useEnvironments } from "@/hooks/use-environments";
import { SessionWithChildren } from "@/components/session-with-children";
import { UserMenu } from "@/components/sidebar-user-menu";

export type { SessionItem } from "@/hooks/use-sidebar-sessions";

export { buildSessionHref, MOBILE_LONG_PRESS_MS } from "@/components/session-list-item";

interface SidebarActionButtonProps {
  onClick?: () => void;
}

export function SearchSessionsButton({ onClick }: SidebarActionButtonProps) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      title={`Search sessions (${SHORTCUT_LABELS.COMMAND_MENU})`}
      aria-label={`Search sessions (${SHORTCUT_LABELS.COMMAND_MENU})`}
    >
      <SearchIcon className="w-4 h-4" />
    </Button>
  );
}

export function NewSessionButton({ onClick }: SidebarActionButtonProps) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      title={`New session (${SHORTCUT_LABELS.NEW_SESSION})`}
      aria-label={`New session (${SHORTCUT_LABELS.NEW_SESSION})`}
    >
      <PlusIcon className="w-4 h-4" />
    </Button>
  );
}

interface SessionSidebarProps {
  onNewSession?: () => void;
  onSearchSessions?: () => void;
  onToggle?: () => void;
  onSessionSelect?: () => void;
}

export function SessionSidebar({
  onNewSession,
  onSearchSessions,
  onToggle,
  onSessionSelect,
}: SessionSidebarProps) {
  const { data: authSession } = useSession();
  const pathname = usePathname();
  const isMobile = useIsMobile();

  const currentSessionId = pathname?.startsWith("/session/") ? pathname.split("/")[2] : null;

  const {
    sessions,
    activeSessions,
    inactiveSessions,
    childrenMap,
    loading,
    loadingMore,
    sessionsError,
    sessionCreatorFilter,
    setSessionCreatorFilter,
    scrollContainerRef,
    maybeLoadMoreSessions,
    handleSessionArchived,
    handleSessionRenamed,
  } = useSidebarSessions(currentSessionId);

  // Environment provenance for the cards, resolved once for the whole list.
  // Names are looked up so a deleted environment (or one still loading)
  // simply drops the chip instead of showing a raw id.
  const { environments } = useEnvironments();
  const environmentNamesById = useMemo(
    () => new Map(environments.map((environment) => [environment.id, environment.name])),
    [environments]
  );

  const hasSessionListError = sessionsError;
  const emptyMessage = hasSessionListError
    ? "Unable to load sessions"
    : sessionCreatorFilter === "mine"
      ? "No sessions started by you"
      : "No sessions yet";

  const handleNavigationSelect = useCallback(() => {
    if (isMobile) {
      onSessionSelect?.();
    }
  }, [isMobile, onSessionSelect]);

  return (
    <aside className="w-72 h-dvh flex flex-col border-r border-border-muted bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-muted">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggle}
            title={`Toggle sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
            aria-label={`Toggle sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
          >
            <SidebarIcon className="w-4 h-4" />
          </Button>
          <SearchSessionsButton onClick={onSearchSessions} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <NewSessionButton onClick={onNewSession} />
          <Link
            href="/settings"
            onClick={handleNavigationSelect}
            className={`p-1.5 transition ${
              pathname === "/settings"
                ? "text-foreground bg-muted"
                : "text-muted-foreground hover:text-foreground hover:bg-muted"
            }`}
            title="Settings"
          >
            <SettingsIcon className="w-4 h-4" />
          </Link>
        </div>
      </div>

      {/* Nav links */}
      <div className="px-3 pt-2 pb-1 flex flex-col gap-0.5">
        <Link
          href="/automations"
          onClick={handleNavigationSelect}
          className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition ${
            pathname?.startsWith("/automations")
              ? "text-foreground bg-muted"
              : "text-muted-foreground hover:text-foreground hover:bg-muted"
          }`}
        >
          <AutomationsIcon className="w-4 h-4" />
          Automations
        </Link>
        <Link
          href="/analytics"
          onClick={handleNavigationSelect}
          className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition ${
            pathname?.startsWith("/analytics")
              ? "text-foreground bg-muted"
              : "text-muted-foreground hover:text-foreground hover:bg-muted"
          }`}
        >
          <DataControlsIcon className="w-4 h-4" />
          Analytics
        </Link>
      </div>

      <div className="px-3 py-2">
        <ToggleGroup
          type="single"
          value={sessionCreatorFilter}
          onValueChange={(value) => {
            if (value === "all" || value === "mine") {
              setSessionCreatorFilter(value);
            }
          }}
          className="grid grid-cols-2 rounded-md border border-border-muted bg-muted p-0.5"
          aria-label="Session owner filter"
        >
          <ToggleGroupItem
            value="all"
            className="h-7 rounded-sm text-xs data-[state=on]:bg-background data-[state=on]:text-foreground"
          >
            All
          </ToggleGroupItem>
          <ToggleGroupItem
            value="mine"
            className="h-7 rounded-sm text-xs data-[state=on]:bg-background data-[state=on]:text-foreground"
          >
            Mine
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {/* Session List */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto"
        onScroll={maybeLoadMoreSessions}
      >
        {loading ? (
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-6 w-6 border-2 border-current border-t-transparent text-muted-foreground" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">{emptyMessage}</div>
        ) : (
          <>
            {/* Active Sessions */}
            {activeSessions.map((session) => (
              <SessionWithChildren
                key={session.id}
                session={session}
                environmentName={
                  session.environmentId
                    ? environmentNamesById.get(session.environmentId)
                    : undefined
                }
                childrenMap={childrenMap}
                currentSessionId={currentSessionId}
                isMobile={isMobile}
                onArchive={handleSessionArchived}
                onSessionSelect={onSessionSelect}
                onSessionRenamed={handleSessionRenamed}
              />
            ))}

            {/* Inactive Divider */}
            {inactiveSessions.length > 0 && (
              <>
                <div className="px-4 py-2 mt-2">
                  <span className="text-xs font-medium text-secondary-foreground uppercase tracking-wider">
                    Inactive
                  </span>
                </div>
                {inactiveSessions.map((session) => (
                  <SessionWithChildren
                    key={session.id}
                    session={session}
                    environmentName={
                      session.environmentId
                        ? environmentNamesById.get(session.environmentId)
                        : undefined
                    }
                    childrenMap={childrenMap}
                    currentSessionId={currentSessionId}
                    isMobile={isMobile}
                    onArchive={handleSessionArchived}
                    onSessionSelect={onSessionSelect}
                    onSessionRenamed={handleSessionRenamed}
                  />
                ))}
              </>
            )}

            {loadingMore && (
              <div className="flex justify-center py-3">
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-current border-t-transparent text-muted-foreground" />
              </div>
            )}
          </>
        )}
      </div>

      <div className="border-t border-border-muted p-2">
        <UserMenu user={authSession?.user} />
      </div>
    </aside>
  );
}

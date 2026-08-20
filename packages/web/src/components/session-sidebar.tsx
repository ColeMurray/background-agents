"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useCallback } from "react";
import { useAuthSession } from "@/lib/auth-session";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import { useIsMobile } from "@/hooks/use-media-query";
import { useSidebarSessions } from "@/hooks/use-sidebar-sessions";
import type { SessionItem } from "@/hooks/use-sidebar-sessions";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  SidebarIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  AutomationsIcon,
  DataControlsIcon,
  ChevronRightIcon,
} from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { useEnvironments } from "@/hooks/use-environments";
import { SessionWithChildren } from "@/components/session-with-children";
import { UserMenu } from "@/components/sidebar-user-menu";

export type { SessionItem } from "@/hooks/use-sidebar-sessions";

export { MOBILE_LONG_PRESS_MS } from "@/components/session-list-item";

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
  const { data: authSession } = useAuthSession();
  const pathname = usePathname();
  const router = useRouter();
  const isMobile = useIsMobile();

  const currentSessionId = pathname?.startsWith("/session/") ? pathname.split("/")[2] : null;

  const {
    needsAttention,
    running,
    recent,
    childrenMap,
    loading,
    sessionsError,
    refreshSnapshot,
    sectionPagination,
    sessionCreatorFilter,
    setSessionCreatorFilter,
    handleSessionArchived,
    handleMarkLatestMessageRead,
  } = useSidebarSessions();

  // Archiving the session on screen leaves nothing to show, so fall back to the home page.
  const handleArchivedSession = useCallback(
    async (sessionId: string) => {
      await handleSessionArchived(sessionId);
      if (currentSessionId === sessionId) {
        router.push("/");
      }
    },
    [currentSessionId, handleSessionArchived, router]
  );

  // Environment provenance for the cards, resolved once for the whole list.
  // Names are looked up so a deleted environment (or one still loading)
  // simply drops the chip instead of showing a raw id.
  const { environments } = useEnvironments();
  const environmentNamesById = useMemo(
    () => new Map(environments.map((environment) => [environment.id, environment.name])),
    [environments]
  );

  const hasSessionListError = sessionsError;
  const emptyMessage =
    sessionCreatorFilter === "mine" ? "No sessions started by you" : "No sessions yet";

  const handleNavigationSelect = useCallback(() => {
    if (isMobile) {
      onSessionSelect?.();
    }
  }, [isMobile, onSessionSelect]);

  const renderSessionGroup = (
    title: string,
    groupSessions: SessionItem[],
    pagination: {
      hasMore: boolean;
      loadingMore: boolean;
      loadMore: () => void;
      error?: unknown;
      retry: () => Promise<unknown>;
    },
    emphasize = false
  ) => {
    if (groupSessions.length === 0 && !pagination.error) return null;

    return (
      <section aria-labelledby={`session-group-${title.toLowerCase().replaceAll(" ", "-")}`}>
        <div className="px-4 pb-1 pt-3">
          <h2
            id={`session-group-${title.toLowerCase().replaceAll(" ", "-")}`}
            className={`text-xs font-medium uppercase tracking-wider ${
              emphasize ? "text-foreground" : "text-secondary-foreground"
            }`}
          >
            {title}
          </h2>
        </div>
        {groupSessions.map((session) => (
          <SessionWithChildren
            key={session.id}
            session={session}
            environmentName={
              session.environmentId ? environmentNamesById.get(session.environmentId) : undefined
            }
            childrenMap={childrenMap}
            currentSessionId={currentSessionId}
            isMobile={isMobile}
            onArchive={handleArchivedSession}
            onSessionSelect={onSessionSelect}
            onMarkLatestMessageRead={handleMarkLatestMessageRead}
          />
        ))}
        {Boolean(pagination.error) && (
          <div className="mx-3 my-1 flex items-center justify-between gap-2 px-1 py-2 text-xs text-destructive">
            <span>Unable to load {title.toLowerCase()}</span>
            <Button variant="ghost" size="sm" onClick={() => void pagination.retry()}>
              Retry
            </Button>
          </div>
        )}
        {pagination.hasMore && (
          <Button
            variant="ghost"
            size="sm"
            className="mx-3 my-1 w-[calc(100%-1.5rem)] text-xs text-muted-foreground"
            disabled={pagination.loadingMore}
            onClick={pagination.loadMore}
          >
            {pagination.loadingMore ? "Loading..." : `Load more ${title.toLowerCase()}`}
          </Button>
        )}
      </section>
    );
  };

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
          value={sessionCreatorFilter ?? ""}
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
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-6 w-6 border-2 border-current border-t-transparent text-muted-foreground" />
          </div>
        ) : (
          <>
            {needsAttention.length === 0 && running.length === 0 && recent.length === 0 ? (
              hasSessionListError ? (
                <div className="flex items-center justify-between gap-2 px-4 py-8 text-sm text-destructive">
                  <span>Unable to load sessions</span>
                  <Button variant="ghost" size="sm" onClick={() => void refreshSnapshot()}>
                    Retry
                  </Button>
                </div>
              ) : (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {emptyMessage}
                </div>
              )
            ) : (
              <>
                {renderSessionGroup(
                  "Needs attention",
                  needsAttention,
                  sectionPagination.needsAttention,
                  true
                )}
                {renderSessionGroup("Running", running, sectionPagination.running)}
                {renderSessionGroup("Recent", recent, sectionPagination.recent)}
              </>
            )}

            <Link
              href="/settings?tab=data-controls"
              onClick={handleNavigationSelect}
              className="mt-2 flex items-center gap-1 px-4 py-2 text-xs font-medium uppercase tracking-wider text-secondary-foreground transition hover:bg-muted hover:text-foreground"
            >
              <ChevronRightIcon className="h-3.5 w-3.5" />
              Archived
            </Link>
          </>
        )}
      </div>

      <div className="border-t border-border-muted p-2">
        <UserMenu user={authSession?.user} />
      </div>
    </aside>
  );
}

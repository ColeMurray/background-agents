"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { NewSessionButton, SearchSessionsButton, SessionSidebar } from "./session-sidebar";
import { GlobalCommandMenu } from "./global-command-menu";
import { useSidebar } from "@/hooks/use-sidebar";
import { useIsMobile } from "@/hooks/use-media-query";
import { useGlobalShortcuts } from "@/hooks/use-global-shortcuts";
import { COMMAND_MENU_SESSIONS_KEY, type SessionListResponse } from "@/lib/session-list";
import { Button } from "@/components/ui/button";
import { SidebarIcon } from "@/components/ui/icons";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useMobileSidebarPull } from "@/hooks/use-mobile-sidebar-pull";

interface SidebarContextValue {
  isOpen: boolean;
  toggle: () => void;
  open: () => void;
  close: () => void;
}

interface AppShellActionsContextValue {
  searchSessions: () => void;
  newSession: () => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);
const AppShellActionsContext = createContext<AppShellActionsContextValue | null>(null);

export function useSidebarContext() {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebarContext must be used within a SidebarLayout");
  }
  return context;
}

interface SidebarLayoutProps {
  children: React.ReactNode;
}

export function SidebarToggleButton({ label = "Open sidebar" }: { label?: string }) {
  const { toggle } = useSidebarContext();
  const { labels } = useKeyboardShortcuts();

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      title={`${label} (${labels["toggle-sidebar"]})`}
      aria-label={`${label} (${labels["toggle-sidebar"]})`}
    >
      <SidebarIcon className="w-4 h-4" />
    </Button>
  );
}

export function CollapsedSidebarControls() {
  const actions = useContext(AppShellActionsContext);
  if (!actions) {
    throw new Error("CollapsedSidebarControls must be used within a SidebarLayout");
  }

  return (
    <div className="flex items-center gap-2">
      <SidebarToggleButton />
      <SearchSessionsButton onClick={actions.searchSessions} />
      <NewSessionButton onClick={actions.newSession} />
    </div>
  );
}

export function SidebarLayout({ children }: SidebarLayoutProps) {
  const router = useRouter();
  const sidebar = useSidebar();
  const isMobile = useIsMobile();
  const [isCommandMenuOpen, setIsCommandMenuOpen] = useState(false);
  const mobileSidebarRef = useRef<HTMLDivElement>(null);
  const getMobileSidebarWidth = useCallback(
    () => mobileSidebarRef.current?.getBoundingClientRect().width ?? 0,
    []
  );
  const sidebarPull = useMobileSidebarPull({
    isMobile,
    isSidebarOpen: sidebar.isOpen,
    getSidebarWidth: getMobileSidebarWidth,
    onOpen: sidebar.open,
  });

  const { data: sessionsResponse } = useSWR<SessionListResponse>(
    isCommandMenuOpen ? COMMAND_MENU_SESSIONS_KEY : null
  );

  const handleNewSession = useCallback(() => {
    setIsCommandMenuOpen(false);
    if (isMobile) {
      sidebar.close();
    }
    router.push("/");
  }, [isMobile, router, sidebar]);

  const handleNavigate = useCallback(
    (href: string) => {
      if (isMobile) {
        sidebar.close();
      }
      router.push(href);
    },
    [isMobile, router, sidebar]
  );

  const handleOpenCommandMenu = useCallback(() => {
    setIsCommandMenuOpen((prev) => !prev);
  }, []);

  const handleSearchSessions = useCallback(() => {
    setIsCommandMenuOpen(true);
  }, []);
  const appShellActions = useMemo(
    () => ({ searchSessions: handleSearchSessions, newSession: handleNewSession }),
    [handleSearchSessions, handleNewSession]
  );

  useGlobalShortcuts({
    enabled: true,
    onOpenCommandMenu: handleOpenCommandMenu,
    onNewSession: handleNewSession,
    onToggleSidebar: sidebar.toggle,
  });

  return (
    <SidebarContext.Provider value={sidebar}>
      <AppShellActionsContext.Provider value={appShellActions}>
        <div
          data-testid="mobile-sidebar-gesture-boundary"
          className={`flex h-dvh overflow-hidden ${
            isMobile && !sidebar.isOpen ? "touch-pan-y" : ""
          }`}
          onPointerDownCapture={sidebarPull.handlePointerDown}
          onPointerMoveCapture={sidebarPull.handlePointerMove}
          onPointerUpCapture={sidebarPull.handlePointerUp}
          onPointerCancelCapture={sidebarPull.handlePointerCancel}
        >
          {/* Mobile: overlay backdrop */}
          {isMobile && (
            <div
              className={`fixed inset-0 z-30 bg-overlay ${
                sidebarPull.isDragging ? "" : "transition-opacity duration-200"
              } ${sidebar.isOpen ? "opacity-100" : "pointer-events-none"}`}
              style={
                !sidebar.isOpen && sidebarPull.dragProgress > 0
                  ? { opacity: sidebarPull.dragProgress }
                  : !sidebar.isOpen
                    ? { opacity: 0 }
                    : undefined
              }
              role="presentation"
              aria-hidden="true"
              onClick={sidebar.close}
            />
          )}
          {/* Sidebar: overlay on mobile, push on desktop */}
          <div
            ref={mobileSidebarRef}
            data-testid="mobile-sidebar-drawer"
            className={
              isMobile
                ? `fixed inset-y-0 left-0 z-40 w-72 ease-in-out ${
                    sidebarPull.isDragging ? "" : "transition-transform duration-200"
                  } ${sidebar.isOpen ? "translate-x-0" : "-translate-x-full"}`
                : `transition-all duration-200 ease-in-out ${
                    sidebar.isOpen ? "w-72" : "w-0"
                  } flex-shrink-0 overflow-hidden`
            }
            style={
              isMobile && !sidebar.isOpen && sidebarPull.dragDistance > 0
                ? { transform: `translateX(calc(-100% + ${sidebarPull.dragDistance}px))` }
                : undefined
            }
          >
            <SessionSidebar
              onNewSession={handleNewSession}
              onSearchSessions={handleSearchSessions}
              onToggle={sidebar.toggle}
              onSessionSelect={sidebar.close}
            />
          </div>
          <main className="min-w-0 flex-1 overflow-hidden">{children}</main>
        </div>
        <GlobalCommandMenu
          open={isCommandMenuOpen}
          onOpenChange={setIsCommandMenuOpen}
          onNavigate={handleNavigate}
          onNewSession={handleNewSession}
          sessions={sessionsResponse?.sessions ?? []}
        />
      </AppShellActionsContext.Provider>
    </SidebarContext.Provider>
  );
}

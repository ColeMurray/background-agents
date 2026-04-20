"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { useSession, signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { SessionSidebar } from "./session-sidebar";
import { GlobalCommandMenu } from "./global-command-menu";
import { useSidebar } from "@/hooks/use-sidebar";
import { useIsMobile } from "@/hooks/use-media-query";
import { useGlobalShortcuts } from "@/hooks/use-global-shortcuts";
import { SIDEBAR_SESSIONS_KEY, type SessionListResponse } from "@/lib/session-list";
import { Button } from "@/components/ui/button";
import { GitHubIcon } from "@/components/ui/icons";

interface SidebarContextValue {
  isOpen: boolean;
  toggle: () => void;
  open: () => void;
  close: () => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

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

export function SidebarLayout({ children }: SidebarLayoutProps) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const sidebar = useSidebar();
  const isMobile = useIsMobile();
  const [isCommandMenuOpen, setIsCommandMenuOpen] = useState(false);

  const { data: sessionsResponse } = useSWR<SessionListResponse>(
    status === "authenticated" && Boolean(session) && isCommandMenuOpen
      ? SIDEBAR_SESSIONS_KEY
      : null
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

  useGlobalShortcuts({
    enabled: status === "authenticated" && Boolean(session),
    onOpenCommandMenu: handleOpenCommandMenu,
    onNewSession: handleNewSession,
    onToggleSidebar: sidebar.toggle,
  });

  // Show loading state
  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-current border-t-transparent text-foreground" />
      </div>
    );
  }

  // Show sign-in page if not authenticated
  if (!session) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-8">
        <h1 className="text-4xl font-bold text-foreground">Open-Inspect</h1>
        <p className="text-muted-foreground max-w-md text-center">
          Background coding agent for your team. Ship faster with AI-powered code changes.
        </p>
        <Button onClick={() => signIn("github")} className="gap-2 px-6 py-3">
          <GitHubIcon className="w-5 h-5" />
          Sign in with GitHub
        </Button>
      </div>
    );
  }

  return (
    <SidebarContext.Provider value={sidebar}>
      <div className="flex h-dvh overflow-hidden">
        {/* Mobile: overlay backdrop */}
        {isMobile && (
          <div
            className={`fixed inset-0 z-30 bg-overlay transition-opacity duration-200 ${
              sidebar.isOpen ? "opacity-100" : "opacity-0 pointer-events-none"
            }`}
            role="presentation"
            aria-hidden="true"
            onClick={sidebar.close}
          />
        )}
        {/* Sidebar: overlay on mobile, push on desktop */}
        <div
          className={
            isMobile
              ? `fixed inset-y-0 left-0 z-40 w-72 transition-transform duration-200 ease-in-out ${
                  sidebar.isOpen ? "translate-x-0" : "-translate-x-full"
                }`
              : `transition-all duration-200 ease-in-out ${
                  sidebar.isOpen ? "w-72" : "w-0"
                } flex-shrink-0 overflow-hidden`
          }
        >
          <SessionSidebar
            onNewSession={handleNewSession}
            onToggle={sidebar.toggle}
            onSessionSelect={sidebar.close}
          />
        </div>
        <main className="flex-1 overflow-hidden">{children}</main>
      </div>
      <GlobalCommandMenu
        open={isCommandMenuOpen}
        onOpenChange={setIsCommandMenuOpen}
        onNavigate={handleNavigate}
        onNewSession={handleNewSession}
        sessions={sessionsResponse?.sessions ?? []}
      />
    </SidebarContext.Provider>
  );
}

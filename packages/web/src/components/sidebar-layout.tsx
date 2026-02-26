"use client";

import { createContext, useCallback, useContext } from "react";
import { useRouter } from "next/navigation";
import { SessionSidebar } from "./session-sidebar";
import { useSidebar } from "@/hooks/use-sidebar";
import { useIsMobile } from "@/hooks/use-media-query";
import { useGlobalShortcuts } from "@/hooks/use-global-shortcuts";

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
  const router = useRouter();
  const sidebar = useSidebar();
  const isMobile = useIsMobile();
  const handleNewSession = useCallback(() => {
    if (isMobile) {
      sidebar.close();
    }
    router.push("/");
  }, [isMobile, router, sidebar]);

  useGlobalShortcuts({
    enabled: true,
    onNewSession: handleNewSession,
    onToggleSidebar: sidebar.toggle,
  });

  return (
    <SidebarContext.Provider value={sidebar}>
      <div className="flex h-dvh overflow-hidden">
        {/* Mobile: overlay backdrop */}
        {isMobile && (
          <div
            className={`fixed inset-0 z-30 bg-black/50 transition-opacity duration-200 ${
              sidebar.isOpen ? "opacity-100" : "opacity-0 pointer-events-none"
            }`}
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
    </SidebarContext.Provider>
  );
}

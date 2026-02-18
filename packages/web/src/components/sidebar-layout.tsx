"use client";

import { createContext, useCallback, useContext } from "react";
import { useSession, signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { SessionSidebar } from "./session-sidebar";
import { useSidebar } from "@/hooks/use-sidebar";
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
  const { data: session, status } = useSession();
  const router = useRouter();
  const sidebar = useSidebar();
  const handleNewSession = useCallback(() => {
    router.push("/");
  }, [router]);

  useGlobalShortcuts({
    enabled: status === "authenticated" && Boolean(session),
    onNewSession: handleNewSession,
    onToggleSidebar: sidebar.toggle,
  });

  // Show loading state
  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-foreground" />
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
        <button
          onClick={() => signIn("github")}
          className="flex items-center gap-2 bg-primary text-primary-foreground px-6 py-3 font-medium hover:opacity-90 transition"
        >
          <GitHubIcon />
          Sign in with GitHub
        </button>
      </div>
    );
  }

  return (
    <SidebarContext.Provider value={sidebar}>
      <div className="flex h-screen overflow-hidden">
        {/* Sidebar with transition */}
        <div
          className={`transition-all duration-200 ease-in-out ${
            sidebar.isOpen ? "w-72" : "w-0"
          } flex-shrink-0 overflow-hidden`}
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

function GitHubIcon() {
  return (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
      <path
        fillRule="evenodd"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
        clipRule="evenodd"
      />
    </svg>
  );
}

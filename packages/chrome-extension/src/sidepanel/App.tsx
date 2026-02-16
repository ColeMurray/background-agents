import { useState, useEffect, useCallback, useRef } from "react";
import { checkAuth } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { AuthGate } from "@/sidepanel/components/AuthGate";
import { SessionList } from "@/sidepanel/components/SessionList";
import { SessionChat } from "@/sidepanel/components/SessionChat";
import { NewSession } from "@/sidepanel/components/NewSession";
import type { SidebarView } from "@/shared/types";

interface AuthUser {
  name: string;
  email: string;
  image: string;
  id: string;
  login: string;
}

export function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [view, setView] = useState<SidebarView>("sessions");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const initialCheckDone = useRef(false);

  const refreshAuth = useCallback(async () => {
    // only show the full-screen spinner on first load, not on subsequent refreshes.
    // remounting children (SessionList) on every refresh causes an infinite fetch loop.
    if (!initialCheckDone.current) {
      setIsLoading(true);
    }
    const session = await checkAuth();
    if (session) {
      setIsAuthenticated(true);
      setUser(session.user);
    } else {
      setIsAuthenticated(false);
      setUser(null);
    }
    setIsLoading(false);
    initialCheckDone.current = true;
  }, []);

  useEffect(() => {
    refreshAuth();
  }, [refreshAuth]);

  // listen for auth changes from the background service worker
  useEffect(() => {
    const listener = (message: { type: string }) => {
      if (message.type === "WRENCH_AUTH_CHANGED") {
        refreshAuth();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [refreshAuth]);

  const openSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
    setView("chat");
  }, []);

  const goBack = useCallback(() => {
    setActiveSessionId(null);
    setView("sessions");
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-clay-100">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-ash-300 border-t-rebolt-500" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <AuthGate onRetry={refreshAuth} />;
  }

  return (
    <div className="flex flex-col h-screen bg-clay-100">
      {/* header */}
      <header className="flex items-center justify-between h-14 px-4 bg-black flex-shrink-0">
        <Button variant="ghost" size="xs" onClick={goBack} className="gap-2">
          <WrenchIcon />
          <span className="text-base font-semibold text-white font-clash">Wrench</span>
        </Button>
        {user && (
          <div className="flex items-center gap-2">
            <img
              src={user.image}
              alt={user.name}
              className="w-6 h-6 rounded-full"
            />
          </div>
        )}
      </header>

      {/* content */}
      <div className="flex-1 overflow-hidden">
        {view === "sessions" && (
          <SessionList
            onSelectSession={openSession}
            onNewSession={() => setView("new-session")}
          />
        )}
        {view === "new-session" && (
          <NewSession
            onCreated={openSession}
            onCancel={goBack}
          />
        )}
        {view === "chat" && activeSessionId && (
          <SessionChat
            sessionId={activeSessionId}
            onBack={goBack}
          />
        )}
      </div>
    </div>
  );
}

function WrenchIcon() {
  return (
    <svg
      className="w-5 h-5 text-rebolt-500"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

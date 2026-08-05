"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { PlusIcon, XIcon } from "@/components/ui/icons";
import { DEFAULT_MODEL, getDefaultReasoningEffort } from "@open-inspect/shared/models";
import type { ModelPreference } from "@/lib/model-selection";
import { useSessionAttachments } from "@/hooks/use-session-attachments";
import { archiveSession } from "@/lib/archive-session";
import {
  useSessionTargetPicker,
  type SessionTargetSelection,
} from "@/hooks/use-session-target-picker";

const MAX_SESSION_TABS = 10;
const NEW_SESSION_TAB_ID = "__new-session__";

export function getSessionTabElementId(sessionId: string): string {
  return `session-tab-${encodeURIComponent(sessionId)}`;
}

export interface SessionTabInput {
  id: string;
  title: string;
  repoOwner?: string | null;
  repoName?: string | null;
  isLoading?: boolean;
}

interface SessionTab extends SessionTabInput {
  href: string;
  kind: "session" | "draft" | "pending";
}

interface SessionTabsContextValue {
  registerSession: (session: SessionTabInput) => void;
  closeSession: (sessionId: string) => void;
  completeNewSession: (sessionId: string) => void;
  openNewSession: () => void;
  updateSessionTitle: (sessionId: string, title: string) => void;
  tabs: SessionTab[];
  activeTabId: string | null;
  navigate: (href: string) => void;
}

export interface NewSessionPendingConfig {
  target: string;
  model: string;
  reasoningEffort?: string;
  branch: string;
}

interface NewSessionDraft {
  storedPreference: ModelPreference;
  setStoredPreference: React.Dispatch<React.SetStateAction<ModelPreference>>;
  modelPreferenceDraft: ModelPreference | null;
  setModelPreferenceDraft: React.Dispatch<React.SetStateAction<ModelPreference | null>>;
  prompt: string;
  setPrompt: React.Dispatch<React.SetStateAction<string>>;
  creating: boolean;
  setCreating: React.Dispatch<React.SetStateAction<boolean>>;
  error: string;
  setError: React.Dispatch<React.SetStateAction<string>>;
  pendingSessionId: string | null;
  setPendingSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  isCreatingSession: boolean;
  setIsCreatingSession: React.Dispatch<React.SetStateAction<boolean>>;
  sessionCreationPromise: React.MutableRefObject<Promise<string | null> | null>;
  abortControllerRef: React.MutableRefObject<AbortController | null>;
  submitInFlightRef: React.MutableRefObject<boolean>;
  pendingConfigRef: React.MutableRefObject<NewSessionPendingConfig | null>;
  hasHydratedModelPreferencesRef: React.MutableRefObject<boolean>;
  warmingGenerationRef: React.MutableRefObject<number>;
  sessionAttachments: ReturnType<typeof useSessionAttachments>;
  picker: SessionTargetSelection;
  reset: (options?: { archivePendingSession?: boolean }) => void;
}

const SessionTabsContext = createContext<SessionTabsContextValue | null>(null);
const NewSessionDraftContext = createContext<NewSessionDraft | null>(null);

function buildTabHref(session: SessionTabInput): string {
  const searchParams = new URLSearchParams();
  if (session.repoOwner && session.repoName) {
    searchParams.set("repoOwner", session.repoOwner);
    searchParams.set("repoName", session.repoName);
  }
  if (session.title) searchParams.set("title", session.title);

  const query = searchParams.toString();
  return `/session/${session.id}${query ? `?${query}` : ""}`;
}

function getActiveSessionId(pathname: string): string | null {
  const match = pathname.match(/^\/session\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function createNewSessionTab(): SessionTab {
  return {
    id: NEW_SESSION_TAB_ID,
    title: "New session",
    href: "/",
    kind: "draft",
  };
}

function appendBoundedTab(
  current: SessionTab[],
  tab: SessionTab,
  protectedTabId: string | null
): SessionTab[] {
  const next = [...current, tab];
  if (next.length <= MAX_SESSION_TABS) return next;

  const evictionIndex = next.findIndex(
    (candidate) =>
      candidate.kind === "session" && candidate.id !== protectedTabId && candidate.id !== tab.id
  );
  return evictionIndex === -1 ? next : next.filter((_, index) => index !== evictionIndex);
}

export function SessionTabsProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [tabs, setTabs] = useState<SessionTab[]>(() =>
    pathname === "/" ? [createNewSessionTab()] : []
  );
  const [storedPreference, setStoredPreference] = useState<ModelPreference>({
    model: DEFAULT_MODEL,
    reasoningEffort: getDefaultReasoningEffort(DEFAULT_MODEL),
  });
  const [modelPreferenceDraft, setModelPreferenceDraft] = useState<ModelPreference | null>(null);
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const sessionCreationPromise = useRef<Promise<string | null> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const submitInFlightRef = useRef(false);
  const pendingConfigRef = useRef<NewSessionPendingConfig | null>(null);
  const hasHydratedModelPreferencesRef = useRef(false);
  const warmingGenerationRef = useRef(0);
  const sessionAttachments = useSessionAttachments();
  const picker = useSessionTargetPicker();
  const pendingSessionIdRef = useRef(pendingSessionId);
  pendingSessionIdRef.current = pendingSessionId;
  const activeTabId =
    pathname === "/"
      ? (tabs.find((tab) => tab.kind === "draft")?.id ??
        tabs.find((tab) => tab.kind === "pending")?.id ??
        NEW_SESSION_TAB_ID)
      : getActiveSessionId(pathname);
  const tabsRef = useRef(tabs);
  const activeTabIdRef = useRef(activeTabId);
  const intendedActiveTabIdRef = useRef(activeTabId);
  tabsRef.current = tabs;
  activeTabIdRef.current = activeTabId;

  useEffect(() => {
    intendedActiveTabIdRef.current = activeTabId;
  }, [activeTabId]);

  useEffect(() => {
    if (pathname !== "/") return;
    setTabs((current) =>
      current.some((tab) => tab.kind === "draft" || tab.kind === "pending")
        ? current
        : appendBoundedTab(current, createNewSessionTab(), activeTabId)
    );
  }, [activeTabId, pathname]);

  const registerSession = useCallback((session: SessionTabInput) => {
    setTabs((current) => {
      const existingIndex = current.findIndex((tab) => tab.id === session.id);
      const nextTab: SessionTab = {
        id: session.id,
        title: session.title,
        repoOwner: session.repoOwner,
        repoName: session.repoName,
        href: buildTabHref(session),
        kind: "session",
      };

      if (existingIndex === -1) {
        return appendBoundedTab(current, nextTab, intendedActiveTabIdRef.current);
      }

      const existing = current[existingIndex];
      if (existing.kind === "pending" && session.isLoading) return current;
      if (
        existing.title === nextTab.title &&
        existing.repoOwner === nextTab.repoOwner &&
        existing.repoName === nextTab.repoName &&
        existing.kind === nextTab.kind
      ) {
        return current;
      }

      return current.map((tab, index) => (index === existingIndex ? nextTab : tab));
    });
  }, []);

  const completeNewSession = useCallback((sessionId: string) => {
    intendedActiveTabIdRef.current = sessionId;
    setTabs((current) => {
      const session: SessionTab = {
        id: sessionId,
        title: "Starting session...",
        href: `/session/${sessionId}`,
        kind: "pending",
      };
      const draftIndex = current.findIndex((tab) => tab.kind === "draft");
      if (draftIndex === -1) {
        return current.some((tab) => tab.id === sessionId)
          ? current
          : appendBoundedTab(current, session, intendedActiveTabIdRef.current);
      }
      return current
        .map((tab, index) => (index === draftIndex ? session : tab))
        .filter((tab, index) => tab.id !== sessionId || index === draftIndex);
    });
  }, []);

  const updateSessionTitle = useCallback((sessionId: string, title: string) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.id === sessionId ? { ...tab, title, href: buildTabHref({ ...tab, title }) } : tab
      )
    );
  }, []);

  const openNewSession = useCallback(() => {
    setTabs((current) =>
      current.some((tab) => tab.kind === "draft")
        ? current
        : appendBoundedTab(current, createNewSessionTab(), intendedActiveTabIdRef.current)
    );
    intendedActiveTabIdRef.current = NEW_SESSION_TAB_ID;
    router.push("/");
  }, [router]);

  const navigate = useCallback(
    (href: string) => {
      intendedActiveTabIdRef.current =
        tabsRef.current.find((tab) => tab.href === href)?.id ??
        (href === "/" ? NEW_SESSION_TAB_ID : getActiveSessionId(href.split("?")[0]));
      router.push(href);
    },
    [router]
  );

  const resetNewSessionDraft = useCallback(
    (options?: { archivePendingSession?: boolean }) => {
      if (options?.archivePendingSession && pendingSessionIdRef.current) {
        void archiveSession(pendingSessionIdRef.current);
      }
      warmingGenerationRef.current += 1;
      abortControllerRef.current?.abort();
      setPrompt("");
      setCreating(false);
      setError("");
      setPendingSessionId(null);
      setIsCreatingSession(false);
      sessionCreationPromise.current = null;
      abortControllerRef.current = null;
      submitInFlightRef.current = false;
      pendingConfigRef.current = null;
      sessionAttachments.clearAttachments();
    },
    [sessionAttachments]
  );

  const closeSession = useCallback(
    (sessionId: string) => {
      const tabs = tabsRef.current;
      const activeTabId = intendedActiveTabIdRef.current ?? activeTabIdRef.current;
      const closingIndex = tabs.findIndex((tab) => tab.id === sessionId);
      if (closingIndex === -1) return;

      const closingTab = tabs[closingIndex];
      if (sessionId === activeTabId) {
        if (tabs.length === 1 && closingTab.kind !== "session") return;
        const nextTab = tabs[closingIndex + 1] ?? tabs[closingIndex - 1];
        intendedActiveTabIdRef.current = nextTab?.id ?? NEW_SESSION_TAB_ID;
        router.push(nextTab?.href ?? "/");
      }

      if (closingTab.kind === "draft") {
        resetNewSessionDraft({ archivePendingSession: true });
      }
      setTabs((current) => current.filter((tab) => tab.id !== sessionId));
    },
    [resetNewSessionDraft, router]
  );

  const newSessionDraft = useMemo<NewSessionDraft>(
    () => ({
      storedPreference,
      setStoredPreference,
      modelPreferenceDraft,
      setModelPreferenceDraft,
      prompt,
      setPrompt,
      creating,
      setCreating,
      error,
      setError,
      pendingSessionId,
      setPendingSessionId,
      isCreatingSession,
      setIsCreatingSession,
      sessionCreationPromise,
      abortControllerRef,
      submitInFlightRef,
      pendingConfigRef,
      hasHydratedModelPreferencesRef,
      warmingGenerationRef,
      sessionAttachments,
      picker,
      reset: resetNewSessionDraft,
    }),
    [
      creating,
      error,
      isCreatingSession,
      modelPreferenceDraft,
      pendingSessionId,
      picker,
      prompt,
      resetNewSessionDraft,
      sessionAttachments,
      storedPreference,
    ]
  );
  const value = useMemo(
    () => ({
      registerSession,
      closeSession,
      completeNewSession,
      openNewSession,
      updateSessionTitle,
      tabs,
      activeTabId,
      navigate,
    }),
    [
      activeTabId,
      closeSession,
      completeNewSession,
      navigate,
      openNewSession,
      registerSession,
      tabs,
      updateSessionTitle,
    ]
  );

  return (
    <SessionTabsContext.Provider value={value}>
      <NewSessionDraftContext.Provider value={newSessionDraft}>
        {children}
      </NewSessionDraftContext.Provider>
    </SessionTabsContext.Provider>
  );
}

export function useSessionTabs() {
  const context = useContext(SessionTabsContext);
  if (!context) {
    throw new Error("useSessionTabs must be used within a SessionTabsProvider");
  }
  return context;
}

export function useNewSessionDraft() {
  const context = useContext(NewSessionDraftContext);
  if (!context) {
    throw new Error("useNewSessionDraft must be used within a SessionTabsProvider");
  }
  return context;
}

export function SessionTabs() {
  const { tabs, activeTabId, closeSession, navigate, openNewSession } = useSessionTabs();
  if (!activeTabId) return null;

  return (
    <SessionTabStrip
      tabs={tabs}
      activeTabId={activeTabId}
      onClose={closeSession}
      onNavigate={navigate}
      onNewSession={openNewSession}
    />
  );
}

function SessionTabStrip({
  tabs,
  activeTabId,
  onClose,
  onNavigate,
  onNewSession,
}: {
  tabs: SessionTab[];
  activeTabId: string;
  onClose: (sessionId: string) => void;
  onNavigate: (href: string) => void;
  onNewSession: () => void;
}) {
  const tabListRef = useRef<HTMLDivElement>(null);

  const handleTabKeyDown = (event: React.KeyboardEvent, tabIndex: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowLeft") nextIndex = (tabIndex - 1 + tabs.length) % tabs.length;
    if (event.key === "ArrowRight") nextIndex = (tabIndex + 1) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    tabListRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
    onNavigate(tabs[nextIndex].href);
  };

  useEffect(() => {
    const tab = Array.from(
      tabListRef.current?.querySelectorAll<HTMLElement>("[data-session-tab]") ?? []
    ).find((candidate) => candidate.dataset.sessionTab === activeTabId);
    tab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeTabId, tabs]);

  if (tabs.length === 0) return null;

  return (
    <nav
      aria-label="Open sessions"
      className="order-first flex h-10 flex-shrink-0 items-end overflow-x-auto border-b border-border bg-muted/40"
    >
      <div ref={tabListRef} role="tablist" className="flex h-full min-w-max items-end px-1 pt-1">
        {tabs.map((tab, tabIndex) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              data-session-tab={tab.id}
              className={`group relative flex h-9 w-44 max-w-[45vw] items-center border-x border-t px-1 transition-colors first:rounded-tl-sm last:rounded-tr-sm md:w-52 ${
                isActive
                  ? "z-10 border-border bg-background text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {isActive && <span className="absolute inset-x-0 top-0 h-0.5 bg-accent" />}
              <button
                type="button"
                id={getSessionTabElementId(tab.id)}
                role="tab"
                aria-selected={isActive}
                aria-controls="session-tab-panel"
                aria-label={`Open ${tab.title}`}
                tabIndex={isActive ? 0 : -1}
                onClick={() => !isActive && onNavigate(tab.href)}
                onKeyDown={(event) => handleTabKeyDown(event, tabIndex)}
                className="flex min-w-0 flex-1 items-center gap-2 px-2 text-left text-xs font-medium"
              >
                <span
                  aria-hidden="true"
                  className={`h-2 w-2 flex-shrink-0 rounded-full ${
                    isActive ? "bg-accent" : "border border-muted-foreground/60"
                  }`}
                />
                <span className="truncate">{tab.title}</span>
              </button>
              <button
                type="button"
                aria-label={`Close ${tab.title}`}
                onClick={() => onClose(tab.id)}
                className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-sm transition hover:bg-muted ${
                  isActive
                    ? "text-muted-foreground"
                    : "md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                }`}
              >
                <XIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        aria-label="New session"
        title="New session"
        onClick={onNewSession}
        className="mx-1 mb-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        <PlusIcon className="h-4 w-4" />
      </button>
    </nav>
  );
}

"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { mutate } from "swr";
import useSWRMutation from "swr/mutation";
import { Suspense, useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useSessionSocket } from "@/hooks/use-session-socket";
import { SessionTimeline } from "@/components/session-timeline";
import { MediaLightbox } from "@/components/media-lightbox";
import { Button } from "@/components/ui/button";
import { useSidebarContext } from "@/components/sidebar-layout";
import { SessionDetailsOverlay } from "@/components/session-details-overlay";
import { SessionPromptComposer } from "@/components/session-prompt-composer";
import { SessionRightSidebar } from "@/components/session-right-sidebar";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import { TerminalPanel } from "@/components/terminal-panel";
import { archiveSession } from "@/lib/archive-session";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import {
  isArchivedSessionListKey,
  isUnarchivedSessionListKey,
  removeSessionFromList,
  type SessionListResponse,
} from "@/lib/session-list";
import { useMediaQuery } from "@/hooks/use-media-query";
import { DEFAULT_MODEL, getDefaultReasoningEffort } from "@open-inspect/shared";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { SidebarIcon } from "@/components/ui/icons";
import type { ComboboxGroup } from "@/components/ui/combobox";

type SessionState = ReturnType<typeof useSessionSocket>["sessionState"];

type FallbackSessionInfo = {
  repoOwner: string | null;
  repoName: string | null;
  title: string | null;
};

function resolveSessionDisplayInfo(
  sessionState: SessionState,
  fallbackSessionInfo: FallbackSessionInfo
): {
  repoLabel: string;
  title: string;
} {
  const resolvedRepoOwner = sessionState?.repoOwner ?? fallbackSessionInfo.repoOwner;
  const resolvedRepoName = sessionState?.repoName ?? fallbackSessionInfo.repoName;
  const repoLabel =
    resolvedRepoOwner && resolvedRepoName
      ? `${resolvedRepoOwner}/${resolvedRepoName}`
      : "Loading session...";

  return {
    repoLabel,
    title: sessionState?.title || fallbackSessionInfo.title || repoLabel,
  };
}

export default function SessionPage() {
  return (
    <Suspense>
      <SessionPageContent />
    </Suspense>
  );
}

function SessionPageContent() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = params.id as string;

  const {
    connected,
    connecting,
    replaying,
    authError,
    connectionError,
    sessionState,
    events,
    participants,
    artifacts,
    currentParticipantId,
    isProcessing,
    loadingHistory,
    sendPrompt,
    stopExecution,
    sendTyping,
    reconnect,
    loadOlderEvents,
  } = useSessionSocket(sessionId);

  const fallbackSessionInfo = useMemo(
    () => ({
      repoOwner: searchParams.get("repoOwner") || null,
      repoName: searchParams.get("repoName") || null,
      title: searchParams.get("title") || null,
    }),
    [searchParams]
  );

  const { trigger: triggerRename } = useSWRMutation(
    `/api/sessions/${sessionId}/title`,
    (url: string, { arg }: { arg: { title: string } }) =>
      fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: arg.title }),
      }).then((r) => {
        if (r.ok) return true;
        console.error("Failed to update session title");
        return false;
      }),
    { throwOnError: false }
  );

  const handleArchive = useCallback(async () => {
    const didArchive = await archiveSession(sessionId);
    if (didArchive) {
      await mutate<SessionListResponse>(
        isUnarchivedSessionListKey,
        (current) =>
          current
            ? { ...current, sessions: removeSessionFromList(current.sessions, sessionId) }
            : current,
        { revalidate: false, populateCache: true }
      );
      router.push("/");
    }
  }, [router, sessionId]);

  const renameSession = useCallback(
    async (title: string) => {
      const updatedAt = Date.now();
      const updateSessionsTitle = (data?: SessionListResponse): SessionListResponse | undefined => {
        if (!data?.sessions) return data;
        return {
          ...data,
          sessions: data.sessions.map((session) =>
            session.id === sessionId ? { ...session, title, updatedAt } : session
          ),
        };
      };

      try {
        const success = await triggerRename({ title });
        if (!success) {
          throw new Error("Failed to update session title");
        }
        await mutate<SessionListResponse>(isUnarchivedSessionListKey, updateSessionsTitle, {
          populateCache: true,
          revalidate: true,
        });
        await mutate<SessionListResponse>(isArchivedSessionListKey, updateSessionsTitle, {
          populateCache: true,
          revalidate: false,
        });
        return true;
      } catch {
        return false;
      }
    },
    [sessionId, triggerRename]
  );

  const { trigger: handleUnarchive } = useSWRMutation(
    `/api/sessions/${sessionId}/unarchive`,
    (url: string) =>
      fetch(url, { method: "POST" }).then(async (r) => {
        if (r.ok) {
          await mutate<SessionListResponse>(
            isArchivedSessionListKey,
            (current) =>
              current
                ? { ...current, sessions: removeSessionFromList(current.sessions, sessionId) }
                : current,
            { revalidate: false, populateCache: true }
          );
          mutate(isUnarchivedSessionListKey);
        } else {
          console.error("Failed to unarchive session");
        }
      }),
    { throwOnError: false }
  );

  const [prompt, setPrompt] = useState("");
  const [selectedMediaArtifactId, setSelectedMediaArtifactId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
  const [reasoningEffort, setReasoningEffort] = useState<string | undefined>(
    getDefaultReasoningEffort(DEFAULT_MODEL)
  );
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const { enabledModels, enabledModelOptions } = useEnabledModels();
  const modelItems = useMemo<ComboboxGroup[]>(
    () =>
      enabledModelOptions.map((group) => ({
        category: group.category,
        options: group.models.map((model) => ({
          value: model.id,
          label: model.name,
          description: model.description,
        })),
      })),
    [enabledModelOptions]
  );

  const handleModelChange = useCallback((model: string) => {
    setSelectedModel(model);
    setReasoningEffort(getDefaultReasoningEffort(model));
  }, []);

  // Reset to default if the selected model is no longer enabled
  useEffect(() => {
    if (enabledModels.length > 0 && !enabledModels.includes(selectedModel)) {
      const fallback = enabledModels[0] ?? DEFAULT_MODEL;
      setSelectedModel(fallback);
      setReasoningEffort(getDefaultReasoningEffort(fallback));
    }
  }, [enabledModels, selectedModel]);

  // Sync selectedModel and reasoningEffort with session state when it loads
  useEffect(() => {
    if (sessionState?.model) {
      setSelectedModel(sessionState.model);
      setReasoningEffort(
        sessionState.reasoningEffort ?? getDefaultReasoningEffort(sessionState.model)
      );
    }
  }, [sessionState?.model, sessionState?.reasoningEffort]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || isProcessing) return;

    sendPrompt(prompt, selectedModel, reasoningEffort);
    setPrompt("");
    // Revalidate sidebar so this session bubbles to the top
    mutate(isUnarchivedSessionListKey);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;

    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setPrompt(e.target.value);

    // Send typing indicator (debounced)
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
    typingTimeoutRef.current = setTimeout(() => {
      sendTyping();
    }, 300);
  };

  return (
    <SessionContent
      sessionState={sessionState}
      connected={connected}
      connecting={connecting}
      replaying={replaying}
      authError={authError}
      connectionError={connectionError}
      reconnect={reconnect}
      participants={participants}
      events={events}
      artifacts={artifacts}
      currentParticipantId={currentParticipantId}
      prompt={prompt}
      isProcessing={isProcessing}
      selectedModel={selectedModel}
      reasoningEffort={reasoningEffort}
      inputRef={inputRef}
      handleSubmit={handleSubmit}
      handleInputChange={handleInputChange}
      handleKeyDown={handleKeyDown}
      setSelectedModel={handleModelChange}
      setReasoningEffort={setReasoningEffort}
      stopExecution={stopExecution}
      handleArchive={handleArchive}
      handleUnarchive={handleUnarchive}
      renameSession={renameSession}
      loadingHistory={loadingHistory}
      loadOlderEvents={loadOlderEvents}
      modelItems={modelItems}
      fallbackSessionInfo={fallbackSessionInfo}
      sessionId={sessionId}
      selectedMediaArtifactId={selectedMediaArtifactId}
      setSelectedMediaArtifactId={setSelectedMediaArtifactId}
    />
  );
}

function SessionContent({
  sessionState,
  connected,
  connecting,
  replaying,
  authError,
  connectionError,
  reconnect,
  participants,
  events,
  artifacts,
  currentParticipantId,
  prompt,
  isProcessing,
  selectedModel,
  reasoningEffort,
  inputRef,
  handleSubmit,
  handleInputChange,
  handleKeyDown,
  setSelectedModel,
  setReasoningEffort,
  stopExecution,
  handleArchive,
  handleUnarchive,
  renameSession,
  loadingHistory,
  loadOlderEvents,
  modelItems,
  fallbackSessionInfo,
  sessionId,
  selectedMediaArtifactId,
  setSelectedMediaArtifactId,
}: {
  sessionState: SessionState;
  connected: boolean;
  connecting: boolean;
  replaying: boolean;
  authError: string | null;
  connectionError: string | null;
  reconnect: () => void;
  participants: ReturnType<typeof useSessionSocket>["participants"];
  events: ReturnType<typeof useSessionSocket>["events"];
  artifacts: ReturnType<typeof useSessionSocket>["artifacts"];
  currentParticipantId: string | null;
  prompt: string;
  isProcessing: boolean;
  selectedModel: string;
  reasoningEffort: string | undefined;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  handleSubmit: (e: React.FormEvent) => void;
  handleInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  setSelectedModel: (model: string) => void;
  setReasoningEffort: (value: string | undefined) => void;
  stopExecution: () => void;
  handleArchive: () => void | Promise<void>;
  handleUnarchive: () => void | Promise<void>;
  renameSession: (title: string) => Promise<boolean | undefined>;
  loadingHistory: boolean;
  loadOlderEvents: () => void;
  modelItems: ComboboxGroup[];
  fallbackSessionInfo: FallbackSessionInfo;
  sessionId: string;
  selectedMediaArtifactId: string | null;
  setSelectedMediaArtifactId: (artifactId: string | null) => void;
}) {
  const { isOpen, toggle } = useSidebarContext();
  const isBelowLg = useMediaQuery("(max-width: 1023px)");
  const isPhone = useMediaQuery("(max-width: 767px)");
  const resolvedRepoOwner = sessionState?.repoOwner ?? fallbackSessionInfo.repoOwner;
  const resolvedRepoName = sessionState?.repoName ?? fallbackSessionInfo.repoName;
  const fallbackRepoLabel =
    resolvedRepoOwner && resolvedRepoName
      ? `${resolvedRepoOwner}/${resolvedRepoName}`
      : "Loading session...";
  const baseResolvedTitle = sessionState?.title ?? fallbackSessionInfo.title ?? fallbackRepoLabel;

  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [title, setTitle] = useState(baseResolvedTitle);
  const [optimisticTitle, setOptimisticTitle] = useState<string | null>(null);
  const detailsButtonRef = useRef<HTMLButtonElement>(null);

  // Terminal panel state
  const [terminalOpen, setTerminalOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("terminal-visible") === "true";
  });
  const toggleTerminal = useCallback(() => {
    setTerminalOpen((prev) => {
      const next = !prev;
      localStorage.setItem("terminal-visible", String(next));
      return next;
    });
  }, []);
  const closeTerminal = useCallback(() => {
    setTerminalOpen(false);
    localStorage.setItem("terminal-visible", "false");
  }, []);
  const ttydUrl = sessionState?.ttydUrl;
  const ttydToken = sessionState?.ttydToken;
  const showTerminal = !!(ttydUrl && ttydToken && terminalOpen && !isBelowLg);

  const toggleDetails = useCallback(() => {
    setIsDetailsOpen((prev) => !prev);
  }, []);

  const handleStartRename = () => {
    setTitle(resolvedTitle);
    setIsRenaming(true);
  };

  const handleRenameSubmit = async () => {
    if (!sessionState) {
      setIsRenaming(false);
      return;
    }

    const trimmed = title.trim();

    if (!trimmed || trimmed === resolvedTitle) {
      setIsRenaming(false);
      return;
    }

    const previousTitle = resolvedTitle;
    setIsRenaming(false);
    setOptimisticTitle(trimmed);

    const success = await renameSession(trimmed);
    if (!success) {
      setOptimisticTitle(null);
      setTitle(previousTitle);
      setIsRenaming(true);
    }
  };

  const resolvedTitle =
    optimisticTitle ?? sessionState?.title ?? fallbackSessionInfo.title ?? fallbackRepoLabel;

  useEffect(() => {
    if (!optimisticTitle) return;
    if (sessionState?.title === optimisticTitle) {
      setOptimisticTitle(null);
    }
  }, [optimisticTitle, sessionState?.title]);

  useEffect(() => {
    if (!isRenaming) setTitle(sessionState?.title ?? "");
  }, [sessionState?.title, isRenaming]);

  useEffect(() => {
    if (isBelowLg) return;
    setIsDetailsOpen(false);
  }, [isBelowLg]);

  const mediaArtifacts = useMemo(
    () =>
      artifacts.filter((artifact) => artifact.type === "screenshot" || artifact.type === "video"),
    [artifacts]
  );
  const selectedMediaArtifact = useMemo(
    () => mediaArtifacts.find((artifact) => artifact.id === selectedMediaArtifactId) ?? null,
    [mediaArtifacts, selectedMediaArtifactId]
  );

  const sessionDisplayInfo = useMemo(
    () => resolveSessionDisplayInfo(sessionState, fallbackSessionInfo),
    [fallbackSessionInfo, sessionState]
  );
  const showTimelineSkeleton = events.length === 0 && (connecting || replaying);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <header className="border-b border-border-muted flex-shrink-0">
        <div className="px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {!isOpen && (
              <Button
                variant="ghost"
                size="icon"
                onClick={toggle}
                title={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
                aria-label={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
              >
                <SidebarIcon className="w-4 h-4" />
              </Button>
            )}
            <div>
              {isRenaming ? (
                <input
                  autoFocus
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={handleRenameSubmit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      e.currentTarget.blur();
                    }
                    if (e.key === "Escape") {
                      setIsRenaming(false);
                    }
                  }}
                  className="text-sm bg-transparent text-foreground outline-none focus:ring-inset focus:ring-ring font-medium max-w-40 truncate"
                />
              ) : (
                <h1
                  className="text-sm font-medium text-foreground max-w-40 truncate cursor-text"
                  onClick={handleStartRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleStartRename();
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  title="Click to rename"
                >
                  {resolvedTitle}
                </h1>
              )}
              <p className="text-sm text-muted-foreground">{sessionDisplayInfo.repoLabel}</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <button
              ref={detailsButtonRef}
              type="button"
              onClick={toggleDetails}
              className="lg:hidden px-3 py-1.5 text-sm text-muted-foreground border border-border-muted hover:text-foreground hover:bg-muted transition"
              aria-label="Toggle session details"
              aria-controls="session-details-dialog"
              aria-expanded={isDetailsOpen}
            >
              Details
            </button>
            {/* Mobile: single combined status dot */}
            <div className="md:hidden">
              <CombinedStatusDot
                connected={connected}
                connecting={connecting}
                sandboxStatus={sessionState?.sandboxStatus}
              />
            </div>
            {/* Desktop: full status indicators */}
            <div className="hidden md:contents">
              <ConnectionStatus connected={connected} connecting={connecting} />
              <SandboxStatus
                status={sessionState?.sandboxStatus}
                dashboardUrl={sessionState?.sandboxDashboardUrl}
              />
              <ParticipantsList participants={participants} />
            </div>
          </div>
        </div>
      </header>

      {/* Connection error banner */}
      {(authError || connectionError) && (
        <div className="bg-destructive-muted border-b border-destructive-border px-4 py-3 flex items-center justify-between">
          <p className="text-sm text-destructive">{authError || connectionError}</p>
          <button
            onClick={reconnect}
            className="px-3 py-1.5 text-sm font-medium text-destructive-foreground bg-destructive hover:bg-destructive/90 transition"
          >
            Reconnect
          </button>
        </div>
      )}

      {/* Main content */}
      <main className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden">
          <PanelGroup orientation="vertical" id="session-terminal">
            {/* Chat / Event Timeline */}
            <Panel defaultSize={showTerminal ? "70%" : "100%"} minSize="30%">
              <SessionTimeline
                events={events}
                sessionId={sessionId}
                currentParticipantId={currentParticipantId}
                isProcessing={isProcessing}
                loadingHistory={loadingHistory}
                showSkeleton={showTimelineSkeleton}
                onLoadOlder={loadOlderEvents}
                onOpenMedia={setSelectedMediaArtifactId}
              />
            </Panel>

            {/* Terminal panel — only rendered when URL + token available and open */}
            {showTerminal && (
              <>
                <PanelResizeHandle className="h-1.5 bg-border-muted hover:bg-accent transition-colors cursor-row-resize" />
                <Panel defaultSize="30%" minSize="15%" maxSize="70%">
                  <TerminalPanel url={ttydUrl!} token={ttydToken!} onClose={closeTerminal} />
                </Panel>
              </>
            )}
          </PanelGroup>
        </div>

        {/* Right sidebar */}
        <SessionRightSidebar
          sessionId={sessionId}
          sessionState={sessionState}
          participants={participants}
          events={events}
          artifacts={artifacts}
          terminalOpen={terminalOpen}
          onToggleTerminal={toggleTerminal}
          onOpenMedia={setSelectedMediaArtifactId}
        />
      </main>

      {isBelowLg && (
        <SessionDetailsOverlay
          open={isDetailsOpen}
          onOpenChange={setIsDetailsOpen}
          isPhone={isPhone}
          returnFocusRef={detailsButtonRef}
          sessionId={sessionId}
          sessionState={sessionState}
          participants={participants}
          events={events}
          artifacts={artifacts}
          terminalOpen={terminalOpen}
          onToggleTerminal={toggleTerminal}
          onOpenMedia={setSelectedMediaArtifactId}
        />
      )}

      <MediaLightbox
        sessionId={sessionId}
        artifact={selectedMediaArtifact}
        open={selectedMediaArtifactId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedMediaArtifactId(null);
          }
        }}
      />

      <SessionPromptComposer
        session={{
          id: sessionId,
          status: sessionState?.status || "",
          artifacts,
          onArchive: handleArchive,
          onUnarchive: handleUnarchive,
        }}
        prompt={{
          value: prompt,
          isProcessing,
          inputRef,
          onSubmit: handleSubmit,
          onChange: handleInputChange,
          onKeyDown: handleKeyDown,
          onStopExecution: stopExecution,
        }}
        model={{
          selectedModel,
          reasoningEffort,
          items: modelItems,
          onModelChange: setSelectedModel,
          onReasoningEffortChange: setReasoningEffort,
        }}
      />
    </div>
  );
}

function ConnectionStatus({ connected, connecting }: { connected: boolean; connecting: boolean }) {
  if (connecting) {
    return (
      <span className="flex items-center gap-1 text-xs text-warning">
        <span className="w-2 h-2 rounded-full bg-warning animate-pulse" />
        Connecting...
      </span>
    );
  }

  if (connected) {
    return (
      <span className="flex items-center gap-1 text-xs text-success">
        <span className="w-2 h-2 rounded-full bg-success" />
        Connected
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1 text-xs text-destructive">
      <span className="w-2 h-2 rounded-full bg-destructive" />
      Disconnected
    </span>
  );
}

function SandboxStatus({
  status,
  dashboardUrl,
}: {
  status?: string;
  dashboardUrl?: string | null;
}) {
  if (!status) return null;

  const colors: Record<string, string> = {
    pending: "text-muted-foreground",
    warming: "text-warning",
    syncing: "text-accent",
    ready: "text-success",
    running: "text-accent",
    stopped: "text-muted-foreground",
    failed: "text-destructive",
  };

  const className = `text-xs ${colors[status] || colors.pending}`;
  const label = `Sandbox: ${status}`;

  if (dashboardUrl) {
    return (
      <a
        href={dashboardUrl}
        target="_blank"
        rel="noreferrer noopener"
        title="Open sandbox in provider dashboard"
        className={`${className} hover:underline`}
      >
        {label}
        <span aria-hidden="true" className="ml-0.5">
          ↗
        </span>
      </a>
    );
  }

  return <span className={className}>{label}</span>;
}

function CombinedStatusDot({
  connected,
  connecting,
  sandboxStatus,
}: {
  connected: boolean;
  connecting: boolean;
  sandboxStatus?: string;
}) {
  let color: string;
  let pulse = false;
  let label: string;

  if (!connected && !connecting) {
    color = "bg-destructive";
    label = "Disconnected";
  } else if (connecting) {
    color = "bg-warning";
    pulse = true;
    label = "Connecting...";
  } else if (sandboxStatus === "failed") {
    color = "bg-destructive";
    label = `Connected \u00b7 Sandbox: ${sandboxStatus}`;
  } else if (["pending", "warming", "syncing"].includes(sandboxStatus || "")) {
    color = "bg-warning";
    label = `Connected \u00b7 Sandbox: ${sandboxStatus}`;
  } else {
    color = "bg-success";
    label = sandboxStatus ? `Connected \u00b7 Sandbox: ${sandboxStatus}` : "Connected";
  }

  return (
    <span title={label} className="flex items-center">
      <span className={`w-2.5 h-2.5 rounded-full ${color}${pulse ? " animate-pulse" : ""}`} />
    </span>
  );
}

function ParticipantsList({
  participants,
}: {
  participants: { userId: string; name: string; status: string }[];
}) {
  if (participants.length === 0) return null;

  // Deduplicate participants by userId (same user may have multiple connections)
  const uniqueParticipants = Array.from(new Map(participants.map((p) => [p.userId, p])).values());

  return (
    <div className="flex -space-x-2">
      {uniqueParticipants.slice(0, 3).map((p) => (
        <div
          key={p.userId}
          className="w-8 h-8 rounded-full bg-card flex items-center justify-center text-xs font-medium text-foreground border-2 border-white"
          title={p.name}
        >
          {p.name.charAt(0).toUpperCase()}
        </div>
      ))}
      {uniqueParticipants.length > 3 && (
        <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-medium text-foreground border-2 border-white">
          +{uniqueParticipants.length - 3}
        </div>
      )}
    </div>
  );
}

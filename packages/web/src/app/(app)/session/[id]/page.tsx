"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { mutate } from "swr";
import useSWRMutation from "swr/mutation";
import { Suspense, useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useSessionSocket } from "@/hooks/use-session-socket";
import { SessionTimeline } from "@/components/session-timeline";
import { MediaLightbox } from "@/components/media-lightbox";
import { SessionHeader } from "@/components/session-header";
import { SessionDetailsOverlay } from "@/components/session-details-overlay";
import { SessionPromptComposer } from "@/components/session-prompt-composer";
import { SessionRightSidebar } from "@/components/session-right-sidebar";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import { TerminalPanel } from "@/components/terminal-panel";
import { archiveSession } from "@/lib/archive-session";
import {
  isArchivedSessionListKey,
  isUnarchivedSessionListKey,
  removeSessionFromList,
  type SessionListResponse,
} from "@/lib/session-list";
import { useMediaQuery } from "@/hooks/use-media-query";
import { usePromptAttachments } from "@/hooks/use-prompt-attachments";
import { DEFAULT_MODEL, getDefaultReasoningEffort } from "@open-inspect/shared";
import type { Attachment } from "@open-inspect/shared";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import type { ComboboxGroup } from "@/components/ui/combobox";

type SessionState = ReturnType<typeof useSessionSocket>["sessionState"];

type FallbackSessionInfo = {
  repoOwner: string | null;
  repoName: string | null;
  title: string | null;
};

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
  const promptAttachments = usePromptAttachments();
  const [selectedMediaArtifactId, setSelectedMediaArtifactId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
  const [reasoningEffort, setReasoningEffort] = useState<string | undefined>(
    getDefaultReasoningEffort(DEFAULT_MODEL)
  );
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Synchronous re-entry guard: React state (isUploading) doesn't commit fast
  // enough to stop a double-click or repeated Cmd+Enter from submitting twice
  // while uploadAll() is awaited.
  const submitInFlightRef = useRef(false);

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const hasAttachments = promptAttachments.attachments.length > 0;
    if (
      submitInFlightRef.current ||
      (!prompt.trim() && !hasAttachments) ||
      isProcessing ||
      promptAttachments.isUploading
    ) {
      return;
    }

    submitInFlightRef.current = true;
    try {
      let attachments: Attachment[] | undefined;
      if (hasAttachments) {
        try {
          attachments = await promptAttachments.uploadAll(sessionId);
        } catch {
          // uploadAll surfaces the error in the composer; keep the draft intact.
          return;
        }
      }

      const trimmed = prompt.trim();
      // Nothing survived to send (e.g. the only attachment failed to upload).
      // Don't post an empty "See the attached files." with no attachments.
      if (!trimmed && (!attachments || attachments.length === 0)) {
        return;
      }

      sendPrompt(trimmed || "See the attached files.", selectedModel, reasoningEffort, attachments);
      setPrompt("");
      promptAttachments.clearAttachments();
      // Revalidate sidebar so this session bubbles to the top
      mutate(isUnarchivedSessionListKey);
    } finally {
      submitInFlightRef.current = false;
    }
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
      promptAttachments={promptAttachments}
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
  promptAttachments,
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
  promptAttachments: ReturnType<typeof usePromptAttachments>;
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
  const isBelowLg = useMediaQuery("(max-width: 1023px)");
  const isPhone = useMediaQuery("(max-width: 767px)");

  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
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

  const showTimelineSkeleton = events.length === 0 && (connecting || replaying);

  return (
    <div className="h-full flex flex-col">
      <SessionHeader
        sessionState={sessionState}
        fallbackSessionInfo={fallbackSessionInfo}
        connected={connected}
        connecting={connecting}
        participants={participants}
        isDetailsOpen={isDetailsOpen}
        detailsButtonRef={detailsButtonRef}
        onToggleDetails={toggleDetails}
        renameSession={renameSession}
      />

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
        attachments={{
          items: promptAttachments.attachments,
          error: promptAttachments.attachmentError,
          isUploading: promptAttachments.isUploading,
          onAdd: promptAttachments.addFiles,
          onRemove: promptAttachments.removeAttachment,
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

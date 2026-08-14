"use client";

import { useRouter } from "next/navigation";
import { mutate } from "swr";
import useSWRMutation from "swr/mutation";
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useSessionSocket } from "@/hooks/use-session-socket";
import { SessionTimeline } from "@/components/session-timeline";
import { MediaLightbox } from "@/components/media-lightbox";
import { SessionHeader } from "@/components/session-header";
import { SessionDetailsOverlay } from "@/components/session-details-overlay";
import { SessionPromptComposer } from "@/components/session-prompt-composer";
import { QueuedPromptStack } from "@/components/queued-prompt-stack";
import { SessionRightSidebar } from "@/components/session-right-sidebar";
import {
  Group as PanelGroup,
  Panel,
  Separator as PanelResizeHandle,
  useDefaultLayout,
} from "react-resizable-panels";
import { TerminalPanel } from "@/components/terminal-panel";
import { archiveSession } from "@/lib/archive-session";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";
import {
  isArchivedSessionListKey,
  isUnarchivedSessionListKey,
  removeSessionFromList,
  type SessionListResponse,
} from "@/lib/session-list";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { SessionAttachmentReference } from "@open-inspect/shared/types/session-attachments";
import { DEFAULT_MODEL, getDefaultReasoningEffort } from "@open-inspect/shared/models";
import { resolveModelPreference, type ModelPreference } from "@/lib/model-selection";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import {
  DEFAULT_ATTACHMENT_ONLY_MESSAGE,
  useSessionAttachments,
} from "@/hooks/use-session-attachments";
import type { ComboboxGroup } from "@/components/ui/combobox";
import { useSessionDiffs } from "@/hooks/use-session-diffs";
import { resolveDiffSelection, type DiffSelection } from "@/lib/session-diffs";
import type {
  SessionDiffFile,
  SessionDiffRepository,
} from "@open-inspect/shared/types/session-diffs";
import { SessionChangesPanel } from "@/components/session-changes-panel";
import {
  SESSION_CHANGES_LAYOUT_ID,
  SessionDesktopLayout,
} from "@/components/session-desktop-layout";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useBrowserLayoutStorage } from "@/hooks/use-browser-layout-storage";
import { focusSessionDetailsTrigger } from "@/lib/session-details-focus";
import { useSessionParticipantProfiles } from "@/hooks/use-session-participant-profiles";
import {
  promptRequestSignature,
  resolvePromptRequestIdentity,
  type PromptRequestIdentity,
} from "@/lib/prompt-request-id";
import {
  classifySessionReadAttempt,
  markMessageRead,
  reconcileSessionReadState,
  SessionReadRequestError,
} from "@/lib/session-read-state";
import { useSessionSnapshot } from "./session-snapshot-provider";

type SessionState = ReturnType<typeof useSessionSocket>["sessionState"];

const TERMINAL_VISIBLE_STORAGE_KEY = "terminal-visible";

export default function SessionPage() {
  const initialSnapshot = useSessionSnapshot();
  const sessionId = initialSnapshot.session.id;
  const {
    connected,
    connecting,
    ready,
    presenceSynced,
    authError,
    connectionError,
    sessionState,
    events,
    participants,
    artifacts,
    currentParticipantId,
    isProcessing,
    promptQueue,
    loadingHistory,
    sendPrompt,
    stopExecution,
    sendTyping,
    reconnect,
    loadOlderEvents,
  } = useSessionSocket(sessionId, initialSnapshot);
  const { profiles, participants: profiledParticipants } = useSessionParticipantProfiles(
    sessionId,
    participants,
    events
  );

  const fallbackSessionInfo = {
    repoOwner: initialSnapshot.session.repoOwner,
    repoName: initialSnapshot.session.repoName,
    title: initialSnapshot.session.title,
  };

  const { handleArchive, handleUnarchive, renameSession } = useSessionListActions(sessionId);
  const {
    selectedModel,
    reasoningEffort,
    setReasoningEffort,
    handleModelChange,
    modelItems,
    loadingEnabledModels,
  } = useModelSelection(sessionState);
  const {
    prompt,
    sessionAttachments,
    inputRef,
    isSubmitting,
    submitError,
    handleSubmit,
    handleInputChange,
    handleKeyDown,
  } = usePromptInput(
    sessionId,
    sendPrompt,
    sendTyping,
    selectedModel,
    reasoningEffort,
    loadingEnabledModels,
    sessionState?.status ?? "created"
  );

  const [selectedMediaArtifactId, setSelectedMediaArtifactId] = useState<string | null>(null);
  const [selectedDiff, setSelectedDiff] = useState<DiffSelection | null>(null);
  const diffReturnFocusRef = useRef<DiffSelection | null>(null);
  const { state: diffState, isLoading: diffLoading } = useSessionDiffs(sessionId);

  const isBelowLg = useMediaQuery("(max-width: 1023px)");
  const isPhone = useMediaQuery("(max-width: 767px)");

  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [isDesktopDetailsOpen, setIsDesktopDetailsOpen] = useState(true);
  const detailsButtonRef = useRef<HTMLButtonElement>(null);
  const actionsButtonRef = useRef<HTMLButtonElement>(null);

  // Terminal panel state. Starts closed so the server and the client render the
  // same markup, then adopts the stored preference after hydration.
  const [terminalOpen, setTerminalOpen] = useState(false);
  useEffect(() => {
    try {
      setTerminalOpen(localStorage.getItem(TERMINAL_VISIBLE_STORAGE_KEY) === "true");
    } catch {
      // Storage is optional; the terminal stays closed when it is unavailable.
    }
  }, []);
  const applyTerminalOpen = useCallback((next: boolean) => {
    setTerminalOpen(next);
    try {
      localStorage.setItem(TERMINAL_VISIBLE_STORAGE_KEY, String(next));
    } catch {
      // Continue with the in-memory preference when storage is unavailable.
    }
  }, []);
  const toggleTerminal = useCallback(() => {
    applyTerminalOpen(!terminalOpen);
  }, [applyTerminalOpen, terminalOpen]);
  const closeTerminal = useCallback(() => {
    applyTerminalOpen(false);
  }, [applyTerminalOpen]);
  const ttydUrl = sessionState?.ttydUrl;
  const ttydToken = sessionState?.ttydToken;
  const showTerminal = !!(ttydUrl && ttydToken && terminalOpen && !isBelowLg);

  const toggleDetails = useCallback(() => {
    setIsDetailsOpen((prev) => !prev);
  }, []);
  const toggleDesktopDetails = useCallback(() => {
    setIsDesktopDetailsOpen((prev) => !prev);
  }, []);
  const openMobileDetails = useCallback(() => {
    setIsDetailsOpen(true);
  }, []);
  const focusDetailsTrigger = useCallback(
    () => focusSessionDetailsTrigger(isPhone, actionsButtonRef.current, detailsButtonRef.current),
    [isPhone]
  );

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
  const primaryRepo =
    sessionState?.repositories?.[0] ??
    (sessionState?.repoOwner && sessionState?.repoName
      ? { repoOwner: sessionState.repoOwner, repoName: sessionState.repoName }
      : null);

  const resolvedDiff = useMemo(
    () =>
      selectedDiff && diffState?.current
        ? resolveDiffSelection(diffState.current, selectedDiff)
        : null,
    [diffState, selectedDiff]
  );
  const changesLayoutStorage = useBrowserLayoutStorage();
  const changesLayout = useDefaultLayout({
    id: SESSION_CHANGES_LAYOUT_ID,
    panelIds:
      resolvedDiff && diffState && !isBelowLg
        ? ["session-main", "session-changes"]
        : ["session-main"],
    storage: changesLayoutStorage,
  });
  const openDiff = useCallback((repository: SessionDiffRepository, file: SessionDiffFile) => {
    const selection = { repositoryPosition: repository.position, path: file.path };
    diffReturnFocusRef.current = selection;
    setSelectedDiff(selection);
    setIsDetailsOpen(false);
  }, []);
  const attemptMarkVisibleMessageRead = useCallback(
    async (messageId: string) => {
      try {
        const result = await markMessageRead(sessionId, messageId);
        await reconcileSessionReadState(result);
        return classifySessionReadAttempt(result);
      } catch (error) {
        if (
          error instanceof SessionReadRequestError &&
          [400, 401, 403, 404, 405].includes(error.status)
        ) {
          return "permanent_failure" as const;
        }
        return "retry" as const;
      }
    },
    [sessionId]
  );
  const closeDiff = useCallback(() => {
    const returnSelection = diffReturnFocusRef.current;
    setSelectedDiff(null);
    requestAnimationFrame(() => {
      if (!isBelowLg && returnSelection) {
        const row = Array.from(
          document.querySelectorAll<HTMLButtonElement>("button[data-diff-path]")
        ).find(
          (candidate) =>
            candidate.dataset.diffRepositoryPosition ===
              String(returnSelection.repositoryPosition) &&
            candidate.dataset.diffPath === returnSelection.path
        );
        if (row) {
          row.focus();
          return;
        }
      }
      focusDetailsTrigger();
    });
  }, [focusDetailsTrigger, isBelowLg]);

  const sessionWorkspace = (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-clip">
      <div className="min-h-0 min-w-0 flex-1 overflow-clip">
        <PanelGroup orientation="vertical" id="session-terminal" style={{ overflow: "clip" }}>
          <Panel
            defaultSize={showTerminal ? "70%" : "100%"}
            minSize="30%"
            style={{ minHeight: 0, overflow: "clip" }}
          >
            <SessionTimeline
              events={events}
              sessionId={sessionId}
              currentParticipantId={currentParticipantId}
              participantProfiles={profiles}
              isProcessing={isProcessing}
              promptQueue={promptQueue}
              loadingHistory={loadingHistory}
              showSkeleton={false}
              onLoadOlder={loadOlderEvents}
              onOpenMedia={setSelectedMediaArtifactId}
              terminalMessageReadObservationEnabled={
                !loadingHistory &&
                !isDetailsOpen &&
                selectedMediaArtifactId === null &&
                resolvedDiff === null
              }
              onMarkMessageRead={attemptMarkVisibleMessageRead}
            />
          </Panel>
          {showTerminal && (
            <>
              <PanelResizeHandle className="h-1.5 cursor-row-resize bg-border-muted transition-colors hover:bg-accent" />
              <Panel defaultSize="30%" minSize="15%" maxSize="70%">
                <TerminalPanel url={ttydUrl!} token={ttydToken!} onClose={closeTerminal} />
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>
      <QueuedPromptStack promptQueue={promptQueue} />
      <SessionPromptComposer
        session={{
          id: sessionId,
          status: sessionState?.status ?? "created",
          artifacts,
          primaryRepo,
          onArchive: handleArchive,
          onUnarchive: handleUnarchive,
        }}
        prompt={{
          value: prompt,
          isProcessing: ready && isProcessing,
          draftLocked: !ready || isSubmitting || sessionAttachments.isUploading,
          submitError,
          inputRef,
          onSubmit: handleSubmit,
          onChange: handleInputChange,
          onKeyDown: handleKeyDown,
          onStopExecution: stopExecution,
        }}
        attachments={{
          items: sessionAttachments.attachments,
          error: sessionAttachments.attachmentError,
          isUploading: sessionAttachments.isUploading,
          onAdd: sessionAttachments.addFiles,
          onRemove: sessionAttachments.removeAttachment,
        }}
        model={{
          selectedModel,
          reasoningEffort,
          items: modelItems,
          onModelChange: handleModelChange,
          onReasoningEffortChange: setReasoningEffort,
        }}
      />
    </div>
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-clip">
      <SessionHeader
        sessionState={sessionState}
        fallbackSessionInfo={fallbackSessionInfo}
        connected={connected && ready}
        connecting={connecting || (connected && !ready)}
        isDetailsOpen={isDetailsOpen}
        isDesktopDetailsOpen={isDesktopDetailsOpen}
        showDesktopDetailsToggle={!resolvedDiff}
        detailsButtonRef={detailsButtonRef}
        actionsButtonRef={actionsButtonRef}
        onToggleDetails={toggleDetails}
        onToggleDesktopDetails={toggleDesktopDetails}
        onOpenMobileDetails={openMobileDetails}
        actions={{
          sessionId,
          sessionStatus: sessionState?.status ?? "created",
          artifacts,
          primaryRepo,
          onArchive: handleArchive,
          onUnarchive: handleUnarchive,
        }}
        renameSession={renameSession}
      />

      {/* Connection error banner */}
      {(authError || connectionError) && (
        <div className="bg-destructive-muted border-b border-destructive-border px-4 py-3 flex items-center justify-between">
          <p className="text-sm text-destructive">{authError || connectionError}</p>
          <button
            type="button"
            onClick={reconnect}
            className="px-3 py-1.5 text-sm font-medium text-destructive-foreground bg-destructive hover:bg-destructive/90 transition"
          >
            Reconnect
          </button>
        </div>
      )}

      {/* Main content */}
      <main className="flex min-h-0 min-w-0 flex-1 overflow-clip">
        {!isBelowLg ? (
          <SessionDesktopLayout
            workspace={sessionWorkspace}
            sidebar={
              <SessionRightSidebar
                isOpen={isDesktopDetailsOpen && !resolvedDiff}
                sessionId={sessionId}
                sessionState={sessionState}
                participants={profiledParticipants}
                presenceSynced={presenceSynced}
                events={events}
                artifacts={artifacts}
                terminalOpen={terminalOpen}
                onToggleTerminal={toggleTerminal}
                onOpenMedia={setSelectedMediaArtifactId}
                diffState={diffState}
                diffLoading={diffLoading}
                selectedDiff={selectedDiff}
                onOpenDiff={openDiff}
              />
            }
            changes={
              resolvedDiff && diffState ? (
                <SessionChangesPanel
                  sessionId={sessionId}
                  state={diffState}
                  resolved={resolvedDiff}
                  onClose={closeDiff}
                  onSelect={setSelectedDiff}
                />
              ) : null
            }
            defaultLayout={changesLayout.defaultLayout}
            onLayoutChanged={changesLayout.onLayoutChanged}
          />
        ) : (
          <>
            {sessionWorkspace}
            <SessionRightSidebar
              sessionId={sessionId}
              sessionState={sessionState}
              participants={profiledParticipants}
              presenceSynced={presenceSynced}
              events={events}
              artifacts={artifacts}
              terminalOpen={terminalOpen}
              onToggleTerminal={toggleTerminal}
              onOpenMedia={setSelectedMediaArtifactId}
              diffState={diffState}
              diffLoading={diffLoading}
              selectedDiff={selectedDiff}
              onOpenDiff={openDiff}
            />
          </>
        )}
      </main>

      {isBelowLg && (
        <SessionDetailsOverlay
          open={isDetailsOpen}
          onOpenChange={setIsDetailsOpen}
          isPhone={isPhone}
          onReturnFocus={focusDetailsTrigger}
          sessionId={sessionId}
          sessionState={sessionState}
          participants={profiledParticipants}
          presenceSynced={presenceSynced}
          events={events}
          artifacts={artifacts}
          terminalOpen={terminalOpen}
          onToggleTerminal={toggleTerminal}
          onOpenMedia={setSelectedMediaArtifactId}
          diffState={diffState}
          diffLoading={diffLoading}
          selectedDiff={selectedDiff}
          onOpenDiff={openDiff}
        />
      )}

      {isBelowLg && (
        <Sheet
          open={Boolean(resolvedDiff && diffState)}
          onOpenChange={(open) => !open && closeDiff()}
        >
          <SheetContent className="inset-0 h-dvh w-screen max-w-none gap-0 p-0 sm:max-w-none">
            <SheetTitle className="sr-only">Changes</SheetTitle>
            {resolvedDiff && diffState && (
              <SessionChangesPanel
                mobile
                sessionId={sessionId}
                state={diffState}
                resolved={resolvedDiff}
                onClose={closeDiff}
                onSelect={setSelectedDiff}
              />
            )}
          </SheetContent>
        </Sheet>
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
    </div>
  );
}

/**
 * Archive, unarchive, and rename actions for the current session, each keeping
 * the SWR session-list caches in sync.
 */
function useSessionListActions(sessionId: string) {
  const router = useRouter();

  const { trigger: triggerRename } = useSWRMutation(
    `/api/sessions/${sessionId}/title`,
    (url: BrowserApiPath, { arg }: { arg: { title: string } }) =>
      browserApiFetch(url, {
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
        await Promise.all([
          mutate<SessionListResponse>(isUnarchivedSessionListKey, updateSessionsTitle, {
            populateCache: true,
            revalidate: true,
          }),
          mutate<SessionListResponse>(isArchivedSessionListKey, updateSessionsTitle, {
            populateCache: true,
            revalidate: false,
          }),
        ]);
        return true;
      } catch {
        return false;
      }
    },
    [sessionId, triggerRename]
  );

  const { trigger: handleUnarchive } = useSWRMutation(
    `/api/sessions/${sessionId}/unarchive`,
    (url: BrowserApiPath) =>
      browserApiFetch(url, { method: "POST" }).then(async (r) => {
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

  return { handleArchive, handleUnarchive, renameSession };
}

/**
 * Model and reasoning-effort selection derived from session state until the
 * user takes ownership of an explicit draft.
 */
function useModelSelection(sessionState: SessionState) {
  const [modelPreferenceDraft, setModelPreferenceDraft] = useState<ModelPreference | null>(null);

  const { enabledModels, enabledModelOptions, loading: loadingEnabledModels } = useEnabledModels();
  const { model: selectedModel, reasoningEffort } = resolveModelPreference(
    modelPreferenceDraft ?? {
      model: sessionState?.model ?? DEFAULT_MODEL,
      reasoningEffort:
        sessionState?.reasoningEffort ??
        getDefaultReasoningEffort(sessionState?.model ?? DEFAULT_MODEL),
    },
    loadingEnabledModels ? undefined : enabledModels
  );
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
    setModelPreferenceDraft({ model, reasoningEffort: getDefaultReasoningEffort(model) });
  }, []);

  const setReasoningEffort = useCallback(
    (nextReasoningEffort: string | undefined) => {
      setModelPreferenceDraft({ model: selectedModel, reasoningEffort: nextReasoningEffort });
    },
    [selectedModel]
  );

  return {
    selectedModel,
    reasoningEffort,
    setReasoningEffort,
    handleModelChange,
    modelItems,
    loadingEnabledModels,
  };
}

/**
 * Prompt textarea state and handlers: submit, Cmd/Ctrl+Enter, and the
 * debounced typing indicator.
 */
function usePromptInput(
  sessionId: string,
  sendPrompt: ReturnType<typeof useSessionSocket>["sendPrompt"],
  sendTyping: ReturnType<typeof useSessionSocket>["sendTyping"],
  selectedModel: string,
  reasoningEffort: string | undefined,
  loadingEnabledModels: boolean,
  sessionStatus: NonNullable<SessionState>["status"]
) {
  const [prompt, setPrompt] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const sessionAttachments = useSessionAttachments();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const submitInFlightRef = useRef(false);
  const retryRequestRef = useRef<PromptRequestIdentity | null>(null);
  const attachmentDraftSignature = sessionAttachments.attachments
    .map((attachment) => attachment.id)
    .join("\u0000");

  const clearTypingTimeout = useCallback(() => {
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => clearTypingTimeout, [clearTypingTimeout]);
  useEffect(() => {
    retryRequestRef.current = null;
  }, [selectedModel, reasoningEffort, attachmentDraftSignature]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const hasAttachments = sessionAttachments.attachments.length > 0;
    if (
      submitInFlightRef.current ||
      (!prompt.trim() && !hasAttachments) ||
      sessionStatus === "archived" ||
      sessionStatus === "cancelled" ||
      loadingEnabledModels ||
      sessionAttachments.isUploading
    ) {
      return;
    }

    submitInFlightRef.current = true;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const content = prompt.trim() || DEFAULT_ATTACHMENT_ONLY_MESSAGE;
      let attachments: SessionAttachmentReference[] | undefined;
      if (hasAttachments) {
        try {
          attachments = await sessionAttachments.uploadAll(sessionId);
        } catch (error) {
          setSubmitError(error instanceof Error ? error.message : "Failed to upload attachments");
          return;
        }
      }

      // Drop any queued typing indicator — the prompt supersedes it
      clearTypingTimeout();
      const signature = promptRequestSignature({
        content,
        model: selectedModel,
        reasoningEffort,
        attachmentIds: sessionAttachments.attachments.map((attachment) => attachment.id),
      });
      const requestIdentity = resolvePromptRequestIdentity(signature, retryRequestRef.current);
      retryRequestRef.current = requestIdentity;
      const result = await sendPrompt(
        content,
        selectedModel,
        reasoningEffort,
        attachments,
        requestIdentity.clientRequestId
      );
      if (!result.ok) {
        setSubmitError(
          result.message ??
            (result.reason === "timeout"
              ? "Confirmation timed out. Retry while this page is open to reuse the same request."
              : result.reason === "disconnected"
                ? "Disconnected before confirmation. Retry on this page after reconnecting."
                : "The prompt could not be queued.")
        );
        return;
      }

      retryRequestRef.current = null;
      setPrompt("");
      sessionAttachments.clearAttachments();
      // Revalidate sidebar so this session bubbles to the top
      mutate(isUnarchivedSessionListKey);
    } finally {
      submitInFlightRef.current = false;
      setIsSubmitting(false);
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
    setSubmitError(null);
    retryRequestRef.current = null;

    // Send typing indicator (debounced)
    clearTypingTimeout();
    typingTimeoutRef.current = setTimeout(() => {
      sendTyping();
    }, 300);
  };

  return {
    prompt,
    sessionAttachments,
    inputRef,
    isSubmitting,
    submitError,
    handleSubmit,
    handleInputChange,
    handleKeyDown,
  };
}

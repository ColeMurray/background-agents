"use client";

import { useRouter } from "next/navigation";
import { mutate } from "swr";
import useSWRMutation from "swr/mutation";
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useSessionSocket } from "@/hooks/use-session-socket";
import { useSessionSkills } from "@/hooks/use-session-skills";
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
import { DEFAULT_MODEL, getDefaultReasoningEffort } from "@open-inspect/shared/models";
import { resolveModelPreference, type ModelPreference } from "@/lib/model-selection";
import { useEnabledModels } from "@/hooks/use-enabled-models";
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
import { useSessionDetailsSidebar } from "@/hooks/use-session-details-sidebar";
import {
  classifySessionReadAttempt,
  markMessageRead,
  reconcileSessionReadState,
  SessionReadRequestError,
} from "@/lib/session-read-state";
import { usePromptInput } from "@/hooks/use-prompt-input";
import { useSessionSnapshot } from "./session-snapshot-provider";
import { useSessionRename } from "@/hooks/use-session-rename";

type SessionState = ReturnType<typeof useSessionSocket>["sessionState"];

const TERMINAL_VISIBLE_STORAGE_KEY = "terminal-visible";
const DEFAULT_SESSION_STATUS = "created" as const;

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
    sandboxError,
    events,
    participants,
    artifacts,
    currentParticipantId,
    isProcessing,
    promptQueue,
    loadingHistory,
    sendPrompt,
    cancelPrompt,
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
  const { suggestions: skillSuggestions } = useSessionSkills(sessionId);

  const fallbackSessionInfo = {
    repoOwner: initialSnapshot.session.repoOwner,
    repoName: initialSnapshot.session.repoName,
    title: initialSnapshot.session.title,
  };

  const { handleArchive, handleUnarchive } = useSessionListActions(sessionId);
  const { optimisticTitle, renameSession } = useSessionRename({
    sessionId,
    currentTitle: sessionState?.title ?? initialSnapshot.session.title,
    authoritativeTitle: sessionState?.title,
    awaitAuthoritativeTitle: true,
  });
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
    setSubmitError,
    handleSubmit,
    handleInputValueChange,
    handleKeyDown,
    restorePrompt,
  } = usePromptInput(
    sessionId,
    sendPrompt,
    sendTyping,
    selectedModel,
    reasoningEffort,
    loadingEnabledModels,
    sessionState?.status ?? DEFAULT_SESSION_STATUS,
    ready
  );
  const [cancellingPromptIds, setCancellingPromptIds] = useState<ReadonlySet<string>>(new Set());
  const cancellingPromptIdsRef = useRef(new Set<string>());
  const handleRemoveQueuedPrompt = useCallback(
    async (messageId: string) => {
      if (cancellingPromptIdsRef.current.has(messageId)) return;
      const queuedPrompt = promptQueue.find((item) => item.messageId === messageId);
      if (!queuedPrompt || queuedPrompt.status !== "pending") return;

      cancellingPromptIdsRef.current.add(messageId);
      setCancellingPromptIds(new Set(cancellingPromptIdsRef.current));
      try {
        const result = await cancelPrompt(messageId);
        if (!result.ok) {
          const message =
            result.message ??
            (result.reason === "timeout"
              ? "Removing the queued prompt timed out"
              : result.reason === "disconnected"
                ? "Reconnect before removing a queued prompt"
                : "The queued prompt could not be removed");
          setSubmitError(message);
          return;
        }
        restorePrompt(queuedPrompt.content);
      } finally {
        cancellingPromptIdsRef.current.delete(messageId);
        setCancellingPromptIds(new Set(cancellingPromptIdsRef.current));
      }
    },
    [cancelPrompt, promptQueue, restorePrompt, setSubmitError]
  );

  const [selectedMediaArtifactId, setSelectedMediaArtifactId] = useState<string | null>(null);
  const [selectedDiff, setSelectedDiff] = useState<DiffSelection | null>(null);
  const diffReturnFocusRef = useRef<DiffSelection | null>(null);
  const { state: diffState, isLoading: diffLoading } = useSessionDiffs(sessionId);

  const isBelowLg = useMediaQuery("(max-width: 1023px)");
  const isPhone = useMediaQuery("(max-width: 767px)");

  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const { isOpen: isDesktopDetailsOpen, toggle: toggleDesktopDetails } = useSessionDetailsSidebar();
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
      <QueuedPromptStack
        promptQueue={promptQueue}
        cancellingPromptIds={cancellingPromptIds}
        onRemove={handleRemoveQueuedPrompt}
      />
      <SessionPromptComposer
        session={{
          id: sessionId,
          status: sessionState?.status ?? DEFAULT_SESSION_STATUS,
          artifacts,
          primaryRepo,
          onArchive: handleArchive,
          onUnarchive: handleUnarchive,
        }}
        prompt={{
          value: prompt,
          isProcessing: ready && isProcessing,
          draftLocked: isSubmitting || sessionAttachments.isUploading,
          sendBlocked: !ready,
          submitError,
          inputRef,
          onSubmit: handleSubmit,
          onValueChange: handleInputValueChange,
          onKeyDown: handleKeyDown,
          onStopExecution: stopExecution,
        }}
        skillSuggestions={skillSuggestions}
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
        sandboxError={sandboxError}
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
          sessionStatus: sessionState?.status ?? DEFAULT_SESSION_STATUS,
          artifacts,
          primaryRepo,
          onArchive: handleArchive,
          onUnarchive: handleUnarchive,
        }}
        optimisticTitle={optimisticTitle}
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
 * Archive and unarchive actions for the current session.
 */
function useSessionListActions(sessionId: string) {
  const router = useRouter();

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

  return { handleArchive, handleUnarchive };
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

"use client";

import { notFound, useRouter } from "next/navigation";
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
import { ActionBar } from "@/components/action-bar";
import { QueuedPromptStack } from "@/components/queued-prompt-stack";
import { SessionRightSidebar } from "@/components/session-right-sidebar";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import { TerminalPanel } from "@/components/terminal-panel";
import { archiveSession } from "@/lib/archive-session";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";
import { sessionActionErrorMessage } from "@/lib/session-action-error";
import { toast } from "sonner";
import {
  isArchivedSessionListKey,
  isUnarchivedSessionListKey,
  removeSessionFromList,
  type SessionListResponse,
} from "@/lib/session-list";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  DEFAULT_MODEL,
  getDefaultReasoningEffort,
  type ReasoningEffort,
  type ValidModel,
} from "@open-inspect/shared/models";
import type { ModelPreference } from "@/lib/model-selection";
import type { HarnessId } from "@open-inspect/shared/harnesses";
import { resolveHarnessModelSelection } from "@/lib/session-harness";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { useSessionDiffs } from "@/hooks/use-session-diffs";
import { resolveDiffSelection } from "@/lib/session-diffs";
import { SessionFileLinksProvider } from "@/lib/session-file-links";
import type {
  SessionDiffFile,
  SessionDiffRepository,
} from "@open-inspect/shared/types/session-diffs";
import { SessionChangesPanel } from "@/components/session-changes-panel";
import { SessionDesktopLayout } from "@/components/session-desktop-layout";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { focusSessionDetailsTrigger } from "@/lib/session-details-focus";
import { useSessionParticipantProfiles } from "@/hooks/use-session-participant-profiles";
import { useSessionDetailsSidebar } from "@/hooks/use-session-details-sidebar";
import { useSessionDiffSelection } from "@/hooks/use-session-diff-selection";
import { useSessionInspectorTab } from "@/hooks/use-session-inspector-tab";
import { findLatestTerminalMessageId } from "@/lib/session-read-state";
import { useMarkSessionRead } from "@/hooks/use-mark-session-read";
import { usePromptInput } from "@/hooks/use-prompt-input";
import { formatSessionCost } from "@/lib/session-cost";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useSessionSnapshot, useRefreshSessionSnapshot } from "./session-snapshot-provider";
import { useSessionRename } from "@/hooks/use-session-rename";
import { SandboxShutdownBanner } from "@/components/sandbox-shutdown-banner";
import { sandboxPromptBlockReason } from "@open-inspect/shared/types/sandbox-shutdown";

type SessionState = ReturnType<typeof useSessionSocket>["sessionState"];

const TERMINAL_VISIBLE_STORAGE_KEY = "terminal-visible";
const DEFAULT_SESSION_STATUS = "created" as const;

export default function SessionPage() {
  const initialSnapshot = useSessionSnapshot();
  const socket = useSessionSocket(initialSnapshot.session.id, initialSnapshot);
  if (socket.sessionGone) notFound();
  return <SessionContent initialSnapshot={initialSnapshot} socket={socket} />;
}

function SessionContent({
  initialSnapshot,
  socket,
}: {
  initialSnapshot: ReturnType<typeof useSessionSnapshot>;
  socket: ReturnType<typeof useSessionSocket>;
}) {
  const { shortcuts } = useKeyboardShortcuts();
  const refreshSnapshot = useRefreshSessionSnapshot();
  const sessionId = initialSnapshot.session.id;
  const scope =
    initialSnapshot.session.visibility === undefined
      ? undefined
      : {
          ownerTeamId: initialSnapshot.session.ownerTeamId ?? null,
          ownerUserId: initialSnapshot.session.ownerUserId ?? null,
          visibility: initialSnapshot.session.visibility,
          collaborators: initialSnapshot.session.collaborators ?? [],
          onUpdated: refreshSnapshot,
        };
  const {
    capabilities,
    connected,
    connecting,
    reconnecting,
    ready,
    presenceSynced,
    authError,
    connectionError,
    sessionState,
    sandboxError,
    boot,
    events,
    participants,
    artifacts,
    currentParticipantId,
    canManageBudget,
    isProcessing,
    promptQueue,
    sendPrompt,
    cancelPrompt,
    stopExecution,
    recoverShutdown,
    sendTyping,
    reconnect,
    loadOlderEvents,
  } = socket;
  const latestTerminalMessageId = useMemo(() => findLatestTerminalMessageId(events), [events]);
  useMarkSessionRead(sessionId, latestTerminalMessageId);
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
  // Fixed at create; per-message model overrides must stay within it.
  const sessionHarness = sessionState?.harness ?? initialSnapshot.session.harness;
  const sandboxBlockReason = sandboxPromptBlockReason(sessionState?.sandboxPreservation);
  const {
    selectedModel,
    reasoningEffort,
    setReasoningEffort,
    handleModelChange,
    enabledModelOptions,
    loadingEnabledModels,
    modelAvailability,
  } = useModelSelection(sessionState, sessionHarness);
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
    ready && capabilities.collaborate && !sessionState?.budgetExhausted && !sandboxBlockReason,
    shortcuts["send-prompt"]
  );
  const [cancellingPromptIds, setCancellingPromptIds] = useState<ReadonlySet<string>>(new Set());
  const cancellingPromptIdsRef = useRef(new Set<string>());
  const handleRemoveQueuedPrompt = useCallback(
    async (messageId: string) => {
      if (!capabilities.lifecycle) return;
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
    [cancelPrompt, capabilities.lifecycle, promptQueue, restorePrompt, setSubmitError]
  );

  const [selectedMediaArtifactId, setSelectedMediaArtifactId] = useState<string | null>(null);
  const { state: diffState, isLoading: diffLoading } = useSessionDiffs(sessionId);

  const isBelowLg = useMediaQuery("(max-width: 1023px)");
  const isPhone = useMediaQuery("(max-width: 767px)");

  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const { isOpen: isDesktopDetailsOpen, toggle: toggleDesktopDetails } = useSessionDetailsSidebar();
  const detailsButtonRef = useRef<HTMLButtonElement>(null);
  const actionsButtonRef = useRef<HTMLButtonElement>(null);
  const desktopDetailsButtonRef = useRef<HTMLButtonElement>(null);
  const {
    tab: inspectorTab,
    selectTab: selectInspectorTab,
    showTab: showInspectorTab,
  } = useSessionInspectorTab();

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
  const showTerminal = !!(
    capabilities.sandboxAccess &&
    ttydUrl &&
    ttydToken &&
    terminalOpen &&
    !isBelowLg
  );

  const toggleDetails = useCallback(() => {
    setIsDetailsOpen((prev) => !prev);
  }, []);
  const openMobileDetails = useCallback(() => {
    setIsDetailsOpen(true);
  }, []);
  const openMobileMedia = useCallback(() => {
    setIsDetailsOpen(true);
    // Media lives in Info's Artifacts section. Showing it is navigation, so the
    // viewer's remembered tab stays as it was.
    showInspectorTab("info");
  }, [showInspectorTab]);
  const focusDetailsTrigger = useCallback(
    () => focusSessionDetailsTrigger(isPhone, actionsButtonRef.current, detailsButtonRef.current),
    [isPhone]
  );
  const handleDiffOpen = useCallback(() => {
    setIsDetailsOpen(false);
    // The diff is navigated from the Changes list. Showing it is navigation, so the
    // viewer's remembered tab stays as it was.
    showInspectorTab("changes");
  }, [showInspectorTab]);
  const focusAfterDiff = useCallback(() => {
    if (isBelowLg) focusDetailsTrigger();
    else desktopDetailsButtonRef.current?.focus();
  }, [focusDetailsTrigger, isBelowLg]);
  const {
    selectedDiff,
    openDiff: openDiffSelection,
    selectDiff,
    closeDiff,
  } = useSessionDiffSelection({ onOpen: handleDiffOpen, focusFallback: focusAfterDiff });

  useEffect(() => {
    if (isBelowLg) return;
    setIsDetailsOpen(false);
  }, [isBelowLg]);

  const openedArtifactLink = useRef<string | null>(null);
  useEffect(() => {
    const artifactId = new URLSearchParams(window.location.search).get("artifact");
    if (!artifactId || openedArtifactLink.current === `${sessionId}:${artifactId}`) return;
    const artifact = artifacts.find((item) => item.id === artifactId);
    if (!artifact) return;
    openedArtifactLink.current = `${sessionId}:${artifactId}`;
    if (artifact.type === "screenshot" || artifact.type === "video") {
      setSelectedMediaArtifactId(artifactId);
    } else {
      showInspectorTab("info");
      if (isBelowLg) setIsDetailsOpen(true);
      else if (!isDesktopDetailsOpen) toggleDesktopDetails();
    }
  }, [
    artifacts,
    sessionId,
    showInspectorTab,
    isBelowLg,
    isDesktopDetailsOpen,
    toggleDesktopDetails,
  ]);

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
  const openDiff = useCallback(
    (repository: SessionDiffRepository, file: SessionDiffFile) =>
      openDiffSelection({ repositoryPosition: repository.position, path: file.path }),
    [openDiffSelection]
  );

  const sessionWorkspace = (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-clip">
      <div className="min-h-0 min-w-0 flex-1 overflow-clip">
        <PanelGroup orientation="vertical" id="session-terminal" style={{ overflow: "clip" }}>
          <Panel
            defaultSize={showTerminal ? "70%" : "100%"}
            minSize="30%"
            style={{ minHeight: 0, overflow: "clip" }}
          >
            <SessionFileLinksProvider
              manifest={diffState?.current ?? null}
              onOpen={openDiffSelection}
            >
              <SessionTimeline
                events={events}
                sessionId={sessionId}
                currentParticipantId={currentParticipantId}
                participantProfiles={profiles}
                isProcessing={isProcessing}
                promptQueue={promptQueue}
                showSkeleton={false}
                onLoadOlder={loadOlderEvents}
                onOpenMedia={setSelectedMediaArtifactId}
              />
            </SessionFileLinksProvider>
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
        capabilities={capabilities}
      />
      {!capabilities.collaborate && capabilities.read && (
        <div className="hidden border-t border-border-muted p-4 md:block">
          <ActionBar
            sessionId={sessionId}
            sessionStatus={sessionState?.status ?? DEFAULT_SESSION_STATUS}
            artifacts={artifacts}
            primaryRepo={primaryRepo}
            onArchive={handleArchive}
            onUnarchive={handleUnarchive}
            capabilities={capabilities}
          />
        </div>
      )}
      {capabilities.collaborate && (
        <SessionPromptComposer
          session={{
            id: sessionId,
            status: sessionState?.status ?? DEFAULT_SESSION_STATUS,
            artifacts,
            primaryRepo,
            onArchive: handleArchive,
            onUnarchive: handleUnarchive,
            capabilities,
            harness: sessionHarness,
          }}
          prompt={{
            value: prompt,
            isProcessing: ready && isProcessing,
            draftLocked: isSubmitting || sessionAttachments.isUploading,
            sendBlocked:
              !ready ||
              Boolean(sandboxBlockReason) ||
              Boolean(sessionState?.budgetExhausted) ||
              modelAvailability.status === "unavailable",
            blockedReason:
              sandboxBlockReason ??
              (sessionState?.budgetExhausted
                ? canManageBudget
                  ? `Session cost limit reached at ${formatSessionCost(sessionState.totalCost ?? 0)} of ${formatSessionCost(sessionState.maxSessionCostUsd ?? 0)}. Raise or remove the limit to continue.`
                  : `Session cost limit reached at ${formatSessionCost(sessionState.totalCost ?? 0)} of ${formatSessionCost(sessionState.maxSessionCostUsd ?? 0)}. The session owner must raise or remove the limit to continue.`
                : modelAvailability.status === "unavailable"
                  ? modelAvailability.message
                  : undefined),
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
            items: enabledModelOptions,
            onModelChange: handleModelChange,
            onReasoningEffortChange: setReasoningEffort,
          }}
        />
      )}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-clip">
      <SessionHeader
        sessionState={sessionState}
        sandboxError={sandboxError}
        bootPhase={boot?.phase ?? null}
        fallbackSessionInfo={fallbackSessionInfo}
        connected={connected && ready}
        connecting={connecting || (connected && !ready)}
        reconnecting={reconnecting}
        isDetailsOpen={isDetailsOpen}
        isDesktopDetailsOpen={isDesktopDetailsOpen}
        detailsButtonRef={detailsButtonRef}
        actionsButtonRef={actionsButtonRef}
        desktopDetailsButtonRef={desktopDetailsButtonRef}
        onToggleDetails={toggleDetails}
        onToggleDesktopDetails={toggleDesktopDetails}
        onOpenMobileDetails={openMobileDetails}
        onOpenMobileMedia={openMobileMedia}
        actions={{
          sessionId,
          sessionStatus: sessionState?.status ?? DEFAULT_SESSION_STATUS,
          artifacts,
          primaryRepo,
          onArchive: handleArchive,
          onUnarchive: handleUnarchive,
          capabilities,
        }}
        optimisticTitle={optimisticTitle}
        renameSession={renameSession}
        capabilities={capabilities}
      />

      {/* Connection error banner */}
      {capabilities.read && (authError || connectionError) && (
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

      {capabilities.read && (
        <SandboxShutdownBanner
          shutdown={sessionState?.sandboxPreservation}
          onRecover={capabilities.lifecycle && ready ? recoverShutdown : undefined}
        />
      )}

      {/* Main content */}
      <main className="flex min-h-0 min-w-0 flex-1 overflow-clip">
        {!isBelowLg ? (
          <SessionDesktopLayout
            workspace={sessionWorkspace}
            sidebar={
              <SessionRightSidebar
                isOpen={isDesktopDetailsOpen}
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
                canManageBudget={canManageBudget}
                activeTab={inspectorTab}
                onTabChange={selectInspectorTab}
                capabilities={capabilities}
                scope={scope}
              />
            }
            changes={
              resolvedDiff && diffState ? (
                <SessionChangesPanel
                  sessionId={sessionId}
                  state={diffState}
                  resolved={resolvedDiff}
                  onClose={closeDiff}
                  onSelect={selectDiff}
                  sidebarShowsFileList={isDesktopDetailsOpen && inspectorTab === "changes"}
                  capabilities={capabilities}
                />
              ) : null
            }
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
              canManageBudget={canManageBudget}
              activeTab={inspectorTab}
              onTabChange={selectInspectorTab}
              capabilities={capabilities}
              scope={scope}
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
          canManageBudget={canManageBudget}
          activeTab={inspectorTab}
          onTabChange={selectInspectorTab}
          capabilities={capabilities}
          scope={scope}
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
                onSelect={selectDiff}
                capabilities={capabilities}
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
          toast.error(await sessionActionErrorMessage(r, "Failed to unarchive session"));
        }
      }),
    { throwOnError: false, onError: () => toast.error("Failed to unarchive session") }
  );

  return { handleArchive, handleUnarchive };
}

/**
 * Model and reasoning-effort selection derived from session state until the
 * user takes ownership of an explicit draft. Only models the session's harness
 * can run are offered, and `modelAvailability` says when none can be sent.
 */
function useModelSelection(sessionState: SessionState, harness: HarnessId) {
  const [modelPreferenceDraft, setModelPreferenceDraft] = useState<ModelPreference | null>(null);

  const { enabledModels, enabledModelOptions, loading: loadingEnabledModels } = useEnabledModels();
  const sessionModel = sessionState?.model ?? DEFAULT_MODEL;
  const sessionReasoningEffort =
    sessionState?.reasoningEffort ?? getDefaultReasoningEffort(sessionModel);
  const {
    model: selectedModel,
    reasoningEffort,
    options,
    availability: modelAvailability,
  } = useMemo(
    () =>
      resolveHarnessModelSelection({
        harness,
        preference: modelPreferenceDraft ?? {
          model: sessionModel,
          reasoningEffort: sessionReasoningEffort,
        },
        enabledModels,
        enabledModelOptions,
        loading: loadingEnabledModels,
      }),
    [
      enabledModelOptions,
      enabledModels,
      harness,
      loadingEnabledModels,
      modelPreferenceDraft,
      sessionModel,
      sessionReasoningEffort,
    ]
  );
  const handleModelChange = useCallback((model: ValidModel) => {
    setModelPreferenceDraft({ model, reasoningEffort: getDefaultReasoningEffort(model) });
  }, []);

  const setReasoningEffort = useCallback(
    (nextReasoningEffort: ReasoningEffort | undefined) => {
      setModelPreferenceDraft({ model: selectedModel, reasoningEffort: nextReasoningEffort });
    },
    [selectedModel]
  );

  return {
    selectedModel,
    reasoningEffort,
    setReasoningEffort,
    handleModelChange,
    enabledModelOptions: options,
    loadingEnabledModels,
    modelAvailability,
  };
}

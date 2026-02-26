"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { mutate } from "swr";
import useSWRMutation from "swr/mutation";
import {
  Suspense,
  memo,
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
} from "react";
import { useSessionSocket } from "@/hooks/use-session-socket";
import { SafeMarkdown } from "@/components/safe-markdown";
import { ToolCallGroup } from "@/components/tool-call-group";
import { useSidebarContext } from "@/components/sidebar-layout";
import {
  SessionRightSidebar,
  SessionRightSidebarContent,
} from "@/components/session-right-sidebar";
import { ActionBar } from "@/components/action-bar";
import { copyToClipboard, formatModelNameLower } from "@/lib/format";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import { useMediaQuery } from "@/hooks/use-media-query";
import { DEFAULT_MODEL, getDefaultReasoningEffort, type ModelCategory } from "@open-inspect/shared";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { ReasoningEffortPills } from "@/components/reasoning-effort-pills";
import type { SandboxEvent } from "@/types/session";
import {
  SidebarIcon,
  ModelIcon,
  CheckIcon,
  SendIcon,
  StopIcon,
  CopyIcon,
  ErrorIcon,
} from "@/components/ui/icons";
import { Combobox, type ComboboxGroup } from "@/components/ui/combobox";

// Event grouping types
type EventGroup =
  | { type: "tool_group"; events: SandboxEvent[]; id: string }
  | { type: "single"; event: SandboxEvent; id: string };

// Group consecutive tool calls of the same type
function groupEvents(events: SandboxEvent[]): EventGroup[] {
  const groups: EventGroup[] = [];
  let currentToolGroup: SandboxEvent[] = [];
  let groupIndex = 0;

  const flushToolGroup = () => {
    if (currentToolGroup.length > 0) {
      groups.push({
        type: "tool_group",
        events: [...currentToolGroup],
        id: `tool-group-${groupIndex++}`,
      });
      currentToolGroup = [];
    }
  };

  for (const event of events) {
    if (event.type === "tool_call") {
      // Check if same tool as current group
      if (currentToolGroup.length > 0 && currentToolGroup[0].tool === event.tool) {
        currentToolGroup.push(event);
      } else {
        // Flush previous group and start new one
        flushToolGroup();
        currentToolGroup = [event];
      }
    } else {
      // Flush any tool group before non-tool event
      flushToolGroup();
      groups.push({
        type: "single",
        event,
        id: `single-${event.type}-${event.messageId || event.timestamp}-${groupIndex++}`,
      });
    }
  }

  // Flush final group
  flushToolGroup();

  return groups;
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

  const { trigger: triggerArchive } = useSWRMutation(
    `/api/sessions/${sessionId}/archive`,
    (url: string) =>
      fetch(url, { method: "POST" }).then((r) => {
        if (r.ok) {
          mutate("/api/sessions");
          return true;
        }

        console.error("Failed to archive session");
        return false;
      }),
    { throwOnError: false }
  );

  const handleArchive = useCallback(async () => {
    const didArchive = await triggerArchive();
    if (didArchive) {
      router.push("/");
    }
  }, [router, triggerArchive]);

  const { trigger: handleUnarchive } = useSWRMutation(
    `/api/sessions/${sessionId}/unarchive`,
    (url: string) =>
      fetch(url, { method: "POST" }).then((r) => {
        if (r.ok) mutate("/api/sessions");
        else console.error("Failed to unarchive session");
      }),
    { throwOnError: false }
  );

  const [prompt, setPrompt] = useState("");
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
  const [reasoningEffort, setReasoningEffort] = useState<string | undefined>(
    getDefaultReasoningEffort(DEFAULT_MODEL)
  );
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const { enabledModels, enabledModelOptions } = useEnabledModels();

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
    mutate("/api/sessions");
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
      messagesEndRef={messagesEndRef}
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
      loadingHistory={loadingHistory}
      loadOlderEvents={loadOlderEvents}
      modelOptions={enabledModelOptions}
      fallbackSessionInfo={fallbackSessionInfo}
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
  messagesEndRef,
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
  loadingHistory,
  loadOlderEvents,
  modelOptions,
  fallbackSessionInfo,
}: {
  sessionState: ReturnType<typeof useSessionSocket>["sessionState"];
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
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
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
  loadingHistory: boolean;
  loadOlderEvents: () => void;
  modelOptions: ModelCategory[];
  fallbackSessionInfo: {
    repoOwner: string | null;
    repoName: string | null;
    title: string | null;
  };
}) {
  const { isOpen, toggle } = useSidebarContext();
  const isBelowLg = useMediaQuery("(max-width: 1023px)");
  const isPhone = useMediaQuery("(max-width: 767px)");
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [sheetDragY, setSheetDragY] = useState(0);
  const sheetDragYRef = useRef(0);
  const detailsButtonRef = useRef<HTMLButtonElement>(null);
  const sheetTouchStartYRef = useRef<number | null>(null);

  // Scroll pagination refs
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const hasScrolledRef = useRef(false);
  const isPrependingRef = useRef(false);
  const prevScrollHeightRef = useRef(0);
  const isNearBottomRef = useRef(true);

  const closeDetails = useCallback(() => {
    setIsDetailsOpen(false);
    setSheetDragY(0);
    sheetDragYRef.current = 0;
    detailsButtonRef.current?.focus();
  }, []);

  const toggleDetails = useCallback(() => {
    setIsDetailsOpen((prev) => {
      const next = !prev;
      if (!next) {
        setSheetDragY(0);
        sheetDragYRef.current = 0;
      }
      return next;
    });
  }, []);

  const handleSheetTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const startY = event.touches[0]?.clientY;
    sheetTouchStartYRef.current = startY ?? null;
  }, []);

  const handleSheetTouchMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const startY = sheetTouchStartYRef.current;
    const currentY = event.touches[0]?.clientY;

    if (startY === null || currentY === undefined) return;

    const delta = currentY - startY;
    if (delta > 0) {
      const nextDragY = Math.min(delta, 180);
      sheetDragYRef.current = nextDragY;
      setSheetDragY(nextDragY);
    } else {
      sheetDragYRef.current = 0;
      setSheetDragY(0);
    }
  }, []);

  const handleSheetTouchEnd = useCallback(() => {
    if (sheetDragYRef.current > 100) {
      closeDetails();
      sheetTouchStartYRef.current = null;
      return;
    }

    sheetDragYRef.current = 0;
    setSheetDragY(0);
    sheetTouchStartYRef.current = null;
  }, [closeDetails]);

  useEffect(() => {
    if (isBelowLg) return;
    setIsDetailsOpen(false);
    setSheetDragY(0);
    sheetDragYRef.current = 0;
  }, [isBelowLg]);

  useEffect(() => {
    if (!isDetailsOpen) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeDetails();
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [closeDetails, isDetailsOpen]);

  useEffect(() => {
    if (!isDetailsOpen) return;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [isDetailsOpen]);

  // Track user scroll
  const handleScroll = useCallback(() => {
    hasScrolledRef.current = true;
    const el = scrollContainerRef.current;
    if (el) {
      isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    }
  }, []);

  // IntersectionObserver to trigger loading older events
  useEffect(() => {
    const sentinel = topSentinelRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (
          entry.isIntersecting &&
          hasScrolledRef.current &&
          container.scrollHeight > container.clientHeight
        ) {
          // Capture scroll height BEFORE triggering load
          prevScrollHeightRef.current = container.scrollHeight;
          isPrependingRef.current = true;
          loadOlderEvents();
        }
      },
      { root: container, threshold: 0.1 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadOlderEvents]);

  // Maintain scroll position when older events are prepended
  useLayoutEffect(() => {
    if (isPrependingRef.current && scrollContainerRef.current) {
      const el = scrollContainerRef.current;
      el.scrollTop += el.scrollHeight - prevScrollHeightRef.current;
      isPrependingRef.current = false;
    }
  }, [events]);

  // Auto-scroll to bottom only when near bottom (not when prepending older history)
  useEffect(() => {
    if (isNearBottomRef.current && !isPrependingRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
    }
  }, [events, messagesEndRef]);

  // Deduplicate and group events for rendering
  const groupedEvents = useMemo(() => {
    const filteredEvents: SandboxEvent[] = [];
    const seenToolCalls = new Map<string, number>();
    const seenCompletions = new Set<string>();
    const seenTokens = new Map<string, number>();

    for (const event of events as SandboxEvent[]) {
      if (event.type === "tool_call" && event.callId) {
        // Deduplicate tool_call events by callId - keep the latest (most complete) one
        const existingIdx = seenToolCalls.get(event.callId);
        if (existingIdx !== undefined) {
          filteredEvents[existingIdx] = event;
        } else {
          seenToolCalls.set(event.callId, filteredEvents.length);
          filteredEvents.push(event);
        }
      } else if (event.type === "execution_complete" && event.messageId) {
        // Skip duplicate execution_complete for the same message
        if (!seenCompletions.has(event.messageId)) {
          seenCompletions.add(event.messageId);
          filteredEvents.push(event);
        }
      } else if (event.type === "token" && event.messageId) {
        // Deduplicate tokens by messageId - keep latest at its chronological position
        const existingIdx = seenTokens.get(event.messageId);
        if (existingIdx !== undefined) {
          filteredEvents[existingIdx] = null as unknown as SandboxEvent;
        }
        seenTokens.set(event.messageId, filteredEvents.length);
        filteredEvents.push(event);
      } else {
        // All other events (user_message, git_sync, etc.) - add as-is
        filteredEvents.push(event);
      }
    }

    return groupEvents(filteredEvents.filter(Boolean) as SandboxEvent[]);
  }, [events]);

  const resolvedRepoOwner = sessionState?.repoOwner ?? fallbackSessionInfo.repoOwner;
  const resolvedRepoName = sessionState?.repoName ?? fallbackSessionInfo.repoName;
  const fallbackRepoLabel =
    resolvedRepoOwner && resolvedRepoName
      ? `${resolvedRepoOwner}/${resolvedRepoName}`
      : "Loading session...";
  const resolvedTitle = sessionState?.title || fallbackSessionInfo.title || fallbackRepoLabel;
  const showTimelineSkeleton = events.length === 0 && (connecting || replaying);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <header className="border-b border-border-muted flex-shrink-0">
        <div className="px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {!isOpen && (
              <button
                onClick={toggle}
                className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition"
                title={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
                aria-label={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
              >
                <SidebarIcon className="w-4 h-4" />
              </button>
            )}
            <div>
              <h1 className="font-medium text-foreground">{resolvedTitle}</h1>
              <p className="text-sm text-muted-foreground">{fallbackRepoLabel}</p>
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
              <SandboxStatus status={sessionState?.sandboxStatus} />
              <ParticipantsList participants={participants} />
            </div>
          </div>
        </div>
      </header>

      {/* Connection error banner */}
      {(authError || connectionError) && (
        <div className="bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800 px-4 py-3 flex items-center justify-between">
          <p className="text-sm text-red-700 dark:text-red-400">{authError || connectionError}</p>
          <button
            onClick={reconnect}
            className="px-3 py-1.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 transition"
          >
            Reconnect
          </button>
        </div>
      )}

      {/* Main content */}
      <main className="flex-1 flex overflow-hidden">
        {/* Event timeline */}
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto overflow-x-hidden p-4"
        >
          <div className="max-w-3xl mx-auto space-y-2">
            {/* Scroll sentinel for loading older history */}
            <div ref={topSentinelRef} className="h-1" />
            {loadingHistory && (
              <div className="text-center text-muted-foreground text-sm py-2">Loading...</div>
            )}
            {showTimelineSkeleton ? (
              <TimelineSkeleton />
            ) : (
              groupedEvents.map((group) =>
                group.type === "tool_group" ? (
                  <ToolCallGroup key={group.id} events={group.events} groupId={group.id} />
                ) : (
                  <EventItem
                    key={group.id}
                    event={group.event}
                    currentParticipantId={currentParticipantId}
                  />
                )
              )
            )}
            {isProcessing && <ThinkingIndicator />}

            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Right sidebar */}
        <SessionRightSidebar
          sessionState={sessionState}
          participants={participants}
          events={events}
          artifacts={artifacts}
        />
      </main>

      {isBelowLg && (
        <div
          className={`fixed inset-0 z-50 lg:hidden ${isDetailsOpen ? "" : "pointer-events-none"}`}
        >
          <div
            className={`absolute inset-0 bg-black/50 transition-opacity duration-200 ${
              isDetailsOpen ? "opacity-100" : "opacity-0"
            }`}
            onClick={closeDetails}
          />

          {isPhone ? (
            <div
              id="session-details-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Session details"
              className="absolute inset-x-0 bottom-0 max-h-[85vh] bg-background border-t border-border-muted shadow-xl flex flex-col"
              style={{
                transform: isDetailsOpen ? `translateY(${sheetDragY}px)` : "translateY(100%)",
                transition: sheetDragY > 0 ? "none" : "transform 200ms ease-in-out",
              }}
            >
              <div
                className="px-4 pt-3 pb-2 border-b border-border-muted"
                onTouchStart={handleSheetTouchStart}
                onTouchMove={handleSheetTouchMove}
                onTouchEnd={handleSheetTouchEnd}
                onTouchCancel={handleSheetTouchEnd}
              >
                <div className="mx-auto mb-2 h-1.5 w-12 rounded-full bg-muted" />
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-medium text-foreground">Session details</h2>
                  <button
                    type="button"
                    onClick={closeDetails}
                    className="text-sm text-muted-foreground hover:text-foreground transition"
                  >
                    Close
                  </button>
                </div>
              </div>
              <div className="overflow-y-auto">
                <SessionRightSidebarContent
                  sessionState={sessionState}
                  participants={participants}
                  events={events}
                  artifacts={artifacts}
                />
              </div>
            </div>
          ) : (
            <div
              id="session-details-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Session details"
              className="absolute inset-y-0 right-0 w-80 max-w-[85vw] bg-background border-l border-border-muted shadow-xl flex flex-col transition-transform duration-200 ease-in-out"
              style={{ transform: isDetailsOpen ? "translateX(0)" : "translateX(100%)" }}
            >
              <div className="px-4 py-3 border-b border-border-muted flex items-center justify-between">
                <h2 className="text-sm font-medium text-foreground">Session details</h2>
                <button
                  type="button"
                  onClick={closeDetails}
                  className="text-sm text-muted-foreground hover:text-foreground transition"
                >
                  Close
                </button>
              </div>
              <div className="flex-1 overflow-y-auto">
                <SessionRightSidebarContent
                  sessionState={sessionState}
                  participants={participants}
                  events={events}
                  artifacts={artifacts}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Input */}
      <footer className="border-t border-border-muted flex-shrink-0">
        <form onSubmit={handleSubmit} className="max-w-4xl mx-auto p-4 pb-6">
          {/* Action bar above input */}
          <div className="mb-3">
            <ActionBar
              sessionId={sessionState?.id || ""}
              sessionStatus={sessionState?.status || ""}
              artifacts={artifacts}
              onArchive={handleArchive}
              onUnarchive={handleUnarchive}
            />
          </div>

          {/* Input container */}
          <div className="border border-border bg-input">
            {/* Text input area with floating send button */}
            <div className="relative">
              <textarea
                ref={inputRef}
                value={prompt}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder={isProcessing ? "Type your next message..." : "Ask or build anything"}
                className="w-full resize-none bg-transparent px-4 pt-4 pb-12 focus:outline-none text-foreground placeholder:text-secondary-foreground"
                rows={3}
              />
              {/* Floating action buttons */}
              <div className="absolute bottom-3 right-3 flex items-center gap-2">
                {isProcessing && prompt.trim() && (
                  <span className="text-xs text-amber-600 dark:text-amber-400">Waiting...</span>
                )}
                {isProcessing && (
                  <button
                    type="button"
                    onClick={stopExecution}
                    className="p-2 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition"
                    title="Stop"
                  >
                    <StopIcon className="w-5 h-5" />
                  </button>
                )}
                <button
                  type="submit"
                  disabled={!prompt.trim() || isProcessing}
                  className="p-2 text-secondary-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition"
                  title={
                    isProcessing && prompt.trim()
                      ? "Wait for execution to complete"
                      : `Send (${SHORTCUT_LABELS.SEND_PROMPT})`
                  }
                  aria-label={
                    isProcessing && prompt.trim()
                      ? "Wait for execution to complete"
                      : `Send (${SHORTCUT_LABELS.SEND_PROMPT})`
                  }
                >
                  <SendIcon className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Footer row with model selector, reasoning pills, and agent label */}
            <div className="flex flex-col gap-2 px-4 py-2 border-t border-border-muted sm:flex-row sm:items-center sm:justify-between sm:gap-0">
              {/* Left side - Model selector + Reasoning pills */}
              <div className="flex flex-wrap items-center gap-2 sm:gap-4 min-w-0">
                <Combobox
                  value={selectedModel}
                  onChange={setSelectedModel}
                  items={
                    modelOptions.map((group) => ({
                      category: group.category,
                      options: group.models.map((model) => ({
                        value: model.id,
                        label: model.name,
                        description: model.description,
                      })),
                    })) as ComboboxGroup[]
                  }
                  direction="up"
                  dropdownWidth="w-56"
                  disabled={isProcessing}
                  triggerClassName="flex max-w-full items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition"
                >
                  <ModelIcon className="w-3.5 h-3.5" />
                  <span className="truncate max-w-[9rem] sm:max-w-none">
                    {formatModelNameLower(selectedModel)}
                  </span>
                </Combobox>

                {/* Reasoning effort pills */}
                <ReasoningEffortPills
                  selectedModel={selectedModel}
                  reasoningEffort={reasoningEffort}
                  onSelect={setReasoningEffort}
                  disabled={isProcessing}
                />
              </div>

              {/* Right side - Agent label */}
              <span className="hidden sm:inline text-sm text-muted-foreground">build agent</span>
            </div>
          </div>
        </form>
      </footer>
    </div>
  );
}

function ConnectionStatus({ connected, connecting }: { connected: boolean; connecting: boolean }) {
  if (connecting) {
    return (
      <span className="flex items-center gap-1 text-xs text-yellow-600 dark:text-yellow-500">
        <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
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
    <span className="flex items-center gap-1 text-xs text-red-600 dark:text-red-500">
      <span className="w-2 h-2 rounded-full bg-red-500" />
      Disconnected
    </span>
  );
}

function SandboxStatus({ status }: { status?: string }) {
  if (!status) return null;

  const colors: Record<string, string> = {
    pending: "text-muted-foreground",
    warming: "text-yellow-600 dark:text-yellow-500",
    syncing: "text-accent",
    ready: "text-success",
    running: "text-accent",
    stopped: "text-muted-foreground",
    failed: "text-red-600 dark:text-red-500",
  };

  return <span className={`text-xs ${colors[status] || colors.pending}`}>Sandbox: {status}</span>;
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
    color = "bg-red-500";
    label = "Disconnected";
  } else if (connecting) {
    color = "bg-yellow-500";
    pulse = true;
    label = "Connecting...";
  } else if (sandboxStatus === "failed") {
    color = "bg-red-500";
    label = `Connected \u00b7 Sandbox: ${sandboxStatus}`;
  } else if (["pending", "warming", "syncing"].includes(sandboxStatus || "")) {
    color = "bg-yellow-500";
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

function ThinkingIndicator() {
  return (
    <div className="bg-card p-4 flex items-center gap-2">
      <span className="inline-block w-2 h-2 bg-accent rounded-full animate-pulse" />
      <span className="text-sm text-muted-foreground">Thinking...</span>
    </div>
  );
}

function TimelineSkeleton() {
  return (
    <div className="space-y-3 py-2 animate-pulse">
      <div className="bg-card p-4 space-y-2">
        <div className="h-3 w-24 bg-muted rounded" />
        <div className="h-3 w-full bg-muted rounded" />
        <div className="h-3 w-5/6 bg-muted rounded" />
      </div>
      <div className="bg-accent-muted p-4 ml-8 space-y-2">
        <div className="h-3 w-20 bg-muted rounded" />
        <div className="h-3 w-4/5 bg-muted rounded" />
      </div>
      <div className="bg-card p-4 space-y-2">
        <div className="h-3 w-32 bg-muted rounded" />
        <div className="h-3 w-3/4 bg-muted rounded" />
      </div>
    </div>
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

const EventItem = memo(function EventItem({
  event,
  currentParticipantId,
}: {
  event: SandboxEvent;
  currentParticipantId: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const time = new Date(event.timestamp * 1000).toLocaleTimeString();

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const handleCopyContent = useCallback(async (content: string) => {
    const success = await copyToClipboard(content);
    if (!success) return;

    setCopied(true);
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
    }
    copyTimeoutRef.current = setTimeout(() => {
      setCopied(false);
      copyTimeoutRef.current = null;
    }, 1500);
  }, []);

  switch (event.type) {
    case "user_message": {
      // Display user's prompt with correct author attribution
      if (!event.content) return null;
      const messageContent = event.content;

      // Determine if this message is from the current user
      const isCurrentUser =
        event.author?.participantId && currentParticipantId
          ? event.author.participantId === currentParticipantId
          : !event.author; // Messages without author are assumed to be from current user (local)

      const authorName = isCurrentUser ? "You" : event.author?.name || "Unknown User";

      return (
        <div className="group bg-accent-muted p-4 ml-8">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              {!isCurrentUser && event.author?.avatar && (
                <img src={event.author.avatar} alt={authorName} className="w-5 h-5 rounded-full" />
              )}
              <span className="text-xs text-accent">{authorName}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => handleCopyContent(messageContent)}
                className="p-1 text-secondary-foreground hover:text-foreground hover:bg-muted/60 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto transition-colors"
                title={copied ? "Copied" : "Copy markdown"}
                aria-label={copied ? "Copied" : "Copy markdown"}
              >
                {copied ? (
                  <CheckIcon className="w-3.5 h-3.5" />
                ) : (
                  <CopyIcon className="w-3.5 h-3.5" />
                )}
              </button>
              <span className="text-xs text-secondary-foreground">{time}</span>
            </div>
          </div>
          <pre className="whitespace-pre-wrap text-sm text-foreground">{messageContent}</pre>
        </div>
      );
    }

    case "token": {
      // Display the model's text response with safe markdown rendering
      if (!event.content) return null;
      const messageContent = event.content;
      return (
        <div className="group bg-card p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-muted-foreground">Assistant</span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => handleCopyContent(messageContent)}
                className="p-1 text-secondary-foreground hover:text-foreground hover:bg-muted opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto transition-colors"
                title={copied ? "Copied" : "Copy markdown"}
                aria-label={copied ? "Copied" : "Copy markdown"}
              >
                {copied ? (
                  <CheckIcon className="w-3.5 h-3.5" />
                ) : (
                  <CopyIcon className="w-3.5 h-3.5" />
                )}
              </button>
              <span className="text-xs text-secondary-foreground">{time}</span>
            </div>
          </div>
          <SafeMarkdown content={messageContent} className="text-sm" />
        </div>
      );
    }

    case "tool_call":
      // Tool calls are handled by ToolCallGroup component
      return null;

    case "tool_result":
      // Tool results are now shown inline with tool calls
      // Only show standalone results if they're errors
      if (!event.error) return null;
      return (
        <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400 py-1">
          <ErrorIcon className="w-4 h-4" />
          <span className="truncate">{event.error}</span>
          <span className="text-xs text-secondary-foreground ml-auto">{time}</span>
        </div>
      );

    case "git_sync":
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="w-2 h-2 rounded-full bg-accent" />
          Git sync: {event.status}
          <span className="text-xs">{time}</span>
        </div>
      );

    case "error":
      return (
        <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
          <span className="w-2 h-2 rounded-full bg-red-500" />
          Error{event.error ? `: ${event.error}` : ""}
          <span className="text-xs text-secondary-foreground">{time}</span>
        </div>
      );

    case "execution_complete":
      if (event.success === false) {
        return (
          <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
            <span className="w-2 h-2 rounded-full bg-red-500" />
            Execution failed{event.error ? `: ${event.error}` : ""}
            <span className="text-xs text-secondary-foreground">{time}</span>
          </div>
        );
      }
      return (
        <div className="flex items-center gap-2 text-sm text-success">
          <span className="w-2 h-2 rounded-full bg-success" />
          Execution complete
          <span className="text-xs text-secondary-foreground">{time}</span>
        </div>
      );

    default:
      return null;
  }
});

"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import useSWR, { mutate } from "swr";
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
import { ScreenshotArtifactCard } from "@/components/screenshot-artifact-card";
import { MediaLightbox } from "@/components/media-lightbox";
import { Button } from "@/components/ui/button";
import { useSidebarContext } from "@/components/sidebar-layout";
import {
  SessionRightSidebar,
  SessionRightSidebarContent,
} from "@/components/session-right-sidebar";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import { TerminalPanel } from "@/components/terminal-panel";
import { ActionBar } from "@/components/action-bar";
import { PlanApprovalBanner } from "@/components/plan-approval-banner";
import { copyToClipboard, formatModelNameLower } from "@/lib/format";
import { archiveSession } from "@/lib/archive-session";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import {
  removeSessionFromList,
  SIDEBAR_SESSIONS_KEY,
  type SessionListResponse,
} from "@/lib/session-list";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  DEFAULT_MODEL,
  getDefaultReasoningEffort,
  isValidReasoningEffort,
  type ModelCategory,
  type PlanArtifact,
} from "@open-inspect/shared";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { ReasoningEffortPills } from "@/components/reasoning-effort-pills";
import type { Artifact, SandboxEvent } from "@/types/session";
import {
  SidebarIcon,
  ModelIcon,
  CheckIcon,
  SendIcon,
  StopIcon,
  CopyIcon,
  ErrorIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "@/components/ui/icons";
import { Combobox, type ComboboxGroup } from "@/components/ui/combobox";

type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;
import type { SessionItem } from "@/components/session-sidebar";

// Event grouping types
type EventGroup =
  | { type: "tool_group"; events: ToolCallEvent[]; id: string }
  | { type: "single"; event: SandboxEvent; id: string };

type PlanBubbleStatus = "awaiting" | "approved" | "rejected" | "superseded";

type TimelineItem =
  | EventGroup
  | { type: "plan"; plan: PlanArtifact; status: PlanBubbleStatus; id: string };

type SessionState = ReturnType<typeof useSessionSocket>["sessionState"];

type FallbackSessionInfo = {
  repoOwner: string | null;
  repoName: string | null;
  title: string | null;
};

type SessionsResponse = { sessions: SessionItem[] };

// Group consecutive tool calls of the same type
function groupEvents(events: SandboxEvent[]): EventGroup[] {
  const groups: EventGroup[] = [];
  let currentToolGroup: ToolCallEvent[] = [];
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
        id: `single-${event.type}-${("messageId" in event ? event.messageId : undefined) || event.timestamp}-${groupIndex++}`,
      });
    }
  }

  // Flush final group
  flushToolGroup();

  return groups;
}

const KNOWN_EVENT_TYPES = new Set<SandboxEvent["type"]>([
  "heartbeat",
  "token",
  "tool_call",
  "step_start",
  "step_finish",
  "tool_result",
  "git_sync",
  "error",
  "execution_complete",
  "artifact",
  "push_complete",
  "push_error",
  "user_message",
]);

function dedupeAndGroupEvents(
  events: SandboxEvent[],
  suppressedPlanMessageIds: Set<string>
): EventGroup[] {
  const filteredEvents: Array<SandboxEvent | null> = [];
  const seenToolCalls = new Map<string, number>();
  const seenCompletions = new Set<string>();
  const seenTokens = new Map<string, number>();

  for (const event of events) {
    // Drop events with no recognized type. The server replays internal event
    // rows (e.g. `plan_saved`) whose `data` blob carries no `type` field, so
    // they arrive as untyped objects with a fallback timestamp = now, which
    // would otherwise confuse chronological insertion logic downstream.
    if (!event.type || !KNOWN_EVENT_TYPES.has(event.type)) {
      continue;
    }
    // Suppress the streamed assistant text for planning turns once the plan
    // has been persisted — the PlanBubble below already renders the same
    // content. During streaming (before the plan POST lands) the set is empty,
    // so the live tokens show normally; once the plan saves the token event
    // disappears on the next render.
    if (
      event.type === "token" &&
      event.messageId &&
      suppressedPlanMessageIds.has(event.messageId)
    ) {
      continue;
    }
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
        filteredEvents[existingIdx] = null;
      }
      seenTokens.set(event.messageId, filteredEvents.length);
      filteredEvents.push(event);
    } else {
      // All other events (user_message, git_sync, etc.) - add as-is
      filteredEvents.push(event);
    }
  }

  return groupEvents(filteredEvents.filter((event): event is SandboxEvent => event !== null));
}

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
        SIDEBAR_SESSIONS_KEY,
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
      const updateSessionsTitle = (data?: SessionsResponse): SessionsResponse => {
        if (!data?.sessions) return { sessions: [] };
        return {
          ...data,
          sessions: data.sessions.map((session) =>
            session.id === sessionId ? { ...session, title, updatedAt } : session
          ),
        };
      };

      try {
        await mutate<SessionsResponse>(
          "/api/sessions",
          async (currentData?: SessionsResponse) => {
            const success = await triggerRename({ title });
            if (!success) {
              throw new Error("Failed to update session title");
            }
            return updateSessionsTitle(currentData);
          },
          {
            optimisticData: updateSessionsTitle,
            rollbackOnError: true,
            populateCache: true,
            revalidate: true,
          }
        );
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
      fetch(url, { method: "POST" }).then((r) => {
        if (r.ok) mutate(SIDEBAR_SESSIONS_KEY);
        else console.error("Failed to unarchive session");
      }),
    { throwOnError: false }
  );

  const [prompt, setPrompt] = useState("");
  const [selectedMediaArtifactId, setSelectedMediaArtifactId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
  const [reasoningEffort, setReasoningEffort] = useState<string | undefined>(
    getDefaultReasoningEffort(DEFAULT_MODEL)
  );
  // Per-prompt opt-in toggle for plan mode. Default OFF: the user enables it
  // when they want the next prompt to generate a plan rather than build.
  const [planToggle, setPlanToggle] = useState(false);
  // Set when the user explicitly picks a model on this page. Until then, the
  // Plan toggle auto-swaps between the session baseline and defaultPlanModel.
  const userPickedModelRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const { enabledModels, enabledModelOptions, defaultModel, defaultPlanModel } = useEnabledModels();

  const handleModelChange = useCallback((model: string) => {
    userPickedModelRef.current = true;
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

  // Auto-switch the per-prompt model when the Plan toggle flips, as long as the
  // user hasn't explicitly picked a model on this page. The baseline (toggle
  // OFF) is the session's model — that's what the user implicitly chose at
  // session creation. Toggle ON switches to the deployment's defaultPlanModel.
  useEffect(() => {
    if (userPickedModelRef.current) return;
    const baseline = sessionState?.model ?? defaultModel;
    const target = planToggle ? defaultPlanModel : baseline;
    if (!target) return;
    if (enabledModels.length > 0 && !enabledModels.includes(target)) return;
    if (target === selectedModel) return;
    setSelectedModel(target);
    // Preserve the user's current reasoning effort across the auto-switch when
    // it's valid for the target model — otherwise fall back to the target's
    // default. Avoids surprising the user by promoting them to "max" just
    // because the plan-default model's default reasoning happens to be max.
    setReasoningEffort(
      reasoningEffort && isValidReasoningEffort(target, reasoningEffort)
        ? reasoningEffort
        : getDefaultReasoningEffort(target)
    );
  }, [
    planToggle,
    sessionState?.model,
    defaultModel,
    defaultPlanModel,
    enabledModels,
    selectedModel,
    reasoningEffort,
  ]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || isProcessing) return;

    sendPrompt(prompt, selectedModel, reasoningEffort, planToggle || undefined);
    setPrompt("");
    // Revalidate sidebar so this session bubbles to the top
    mutate(SIDEBAR_SESSIONS_KEY);
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
      planToggle={planToggle}
      setPlanToggle={setPlanToggle}
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
      modelOptions={enabledModelOptions}
      defaultImplementationModel={defaultModel}
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
  messagesEndRef,
  prompt,
  isProcessing,
  selectedModel,
  reasoningEffort,
  planToggle,
  setPlanToggle,
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
  modelOptions,
  defaultImplementationModel,
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
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  prompt: string;
  isProcessing: boolean;
  selectedModel: string;
  reasoningEffort: string | undefined;
  planToggle: boolean;
  setPlanToggle: (v: boolean) => void;
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
  modelOptions: ModelCategory[];
  defaultImplementationModel: string;
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
  const [sheetDragY, setSheetDragY] = useState(0);
  const sheetDragYRef = useRef(0);
  const detailsButtonRef = useRef<HTMLButtonElement>(null);
  const sheetTouchStartYRef = useRef<number | null>(null);

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

  // Scroll pagination refs
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const hasScrolledRef = useRef(false);
  const isPrependingRef = useRef(false);
  const prevScrollHeightRef = useRef(0);
  const isNearBottomRef = useRef(true);

  const resetSheetDragState = useCallback(() => {
    setSheetDragY(0);
    sheetDragYRef.current = 0;
  }, []);

  const closeDetails = useCallback(() => {
    setIsDetailsOpen(false);
    resetSheetDragState();
    detailsButtonRef.current?.focus();
  }, [resetSheetDragState]);

  const toggleDetails = useCallback(() => {
    setIsDetailsOpen((prev) => {
      const next = !prev;
      if (!next) {
        resetSheetDragState();
      }
      return next;
    });
  }, [resetSheetDragState]);

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
    if (!isRenaming) setTitle(sessionState?.title ?? "");
  }, [sessionState?.title, isRenaming]);

  useEffect(() => {
    if (isBelowLg) return;
    setIsDetailsOpen(false);
    resetSheetDragState();
  }, [isBelowLg, resetSheetDragState]);

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

  const isPlanAwaiting =
    sessionState?.planMode === true && sessionState?.planApprovalStatus === "awaiting_approval";
  // Plan-locked form: applies while the session is in plan mode and the plan
  // is not yet in a terminal state (awaiting *or* still streaming). The model
  // and reasoning effort are locked to the planning model during this window;
  // exposing the impl-mode selector would be misleading. Mirrors the "plan
  // agent" label condition further down.
  const isPlanLocked =
    sessionState?.planMode === true &&
    sessionState?.planApprovalStatus !== "approved" &&
    sessionState?.planApprovalStatus !== "rejected";

  // Fetch the full plan history so old versions render collapsed inline
  // alongside the latest. Skipped for non-plan sessions.
  const plansKey = sessionState?.planMode ? `/api/sessions/${sessionId}/plans` : null;
  const { data: plansData, mutate: mutatePlans } = useSWR<{ plans: PlanArtifact[] }>(plansKey);

  // Revalidate the plan list whenever the WebSocket signals a new plan
  // version. `currentPlan.id` changes per save, so this fires once per
  // version.
  const currentPlanId = sessionState?.currentPlan?.id ?? null;
  useEffect(() => {
    if (currentPlanId) mutatePlans();
  }, [currentPlanId, mutatePlans]);

  const plans = useMemo<PlanArtifact[]>(() => {
    const fromApi = plansData?.plans ?? [];
    // If the API hasn't returned yet but the WS already pushed the current
    // plan, surface it immediately so the bubble doesn't flash empty.
    if (fromApi.length === 0 && sessionState?.currentPlan) {
      return [sessionState.currentPlan];
    }
    return fromApi;
  }, [plansData?.plans, sessionState?.currentPlan]);

  // Every saved plan was produced by an assistant turn whose streamed tokens
  // carry the same messageId. We hide those token events so the PlanBubble is
  // the sole representation of the plan.
  const suppressedPlanMessageIds = useMemo(() => {
    const ids = new Set<string>();
    for (const plan of plans) {
      if (plan.createdByMessageId) ids.add(plan.createdByMessageId);
    }
    return ids;
  }, [plans]);

  // Deduplicate and group events for rendering
  const groupedEvents = useMemo(
    () => dedupeAndGroupEvents(events, suppressedPlanMessageIds),
    [events, suppressedPlanMessageIds]
  );

  // Interleave every plan version chronologically. The highest-version plan
  // inherits the session's plan_approval_status (awaiting/approved/rejected);
  // every older version is "superseded".
  const timelineItems = useMemo<TimelineItem[]>(() => {
    if (plans.length === 0) return groupedEvents;

    const latestVersion = plans.reduce((max, p) => Math.max(max, p.version), -Infinity);
    const latestStatus: PlanBubbleStatus = (() => {
      const s = sessionState?.planApprovalStatus;
      if (s === "approved") return "approved";
      if (s === "rejected") return "rejected";
      return "awaiting";
    })();
    const plansAsc = [...plans].sort((a, b) => a.createdAt - b.createdAt);
    const planItems = plansAsc.map((plan) => ({
      type: "plan" as const,
      plan,
      status: plan.version === latestVersion ? latestStatus : ("superseded" as const),
      id: `plan-${plan.id}`,
    }));

    const result: TimelineItem[] = [];
    let pi = 0;
    for (const group of groupedEvents) {
      const groupTs =
        group.type === "tool_group" ? (group.events[0]?.timestamp ?? 0) : group.event.timestamp;
      while (pi < planItems.length && planItems[pi].plan.createdAt / 1000 <= groupTs) {
        result.push(planItems[pi]);
        pi++;
      }
      result.push(group);
    }
    while (pi < planItems.length) {
      result.push(planItems[pi]);
      pi++;
    }
    return result;
  }, [groupedEvents, plans, sessionState?.planApprovalStatus]);
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
              <SandboxStatus status={sessionState?.sandboxStatus} />
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
              <div
                ref={scrollContainerRef}
                onScroll={handleScroll}
                className="h-full overflow-y-auto overflow-x-hidden p-4"
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
                    timelineItems.map((item) => {
                      if (item.type === "tool_group") {
                        return (
                          <ToolCallGroup key={item.id} events={item.events} groupId={item.id} />
                        );
                      }
                      if (item.type === "plan") {
                        return <PlanBubble key={item.id} plan={item.plan} status={item.status} />;
                      }
                      return (
                        <EventItem
                          key={item.id}
                          event={item.event}
                          sessionId={sessionId}
                          currentParticipantId={currentParticipantId}
                          onOpenMedia={setSelectedMediaArtifactId}
                        />
                      );
                    })
                  )}
                  {isProcessing && <ThinkingIndicator />}

                  <div ref={messagesEndRef} />
                </div>
              </div>
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
        <div
          className={`fixed inset-0 z-50 lg:hidden ${isDetailsOpen ? "" : "pointer-events-none"}`}
        >
          <div
            className={`absolute inset-0 bg-overlay transition-opacity duration-200 ${
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
                  sessionId={sessionId}
                  sessionState={sessionState}
                  participants={participants}
                  events={events}
                  artifacts={artifacts}
                  terminalOpen={terminalOpen}
                  onToggleTerminal={toggleTerminal}
                  onOpenMedia={setSelectedMediaArtifactId}
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
                  sessionId={sessionId}
                  sessionState={sessionState}
                  participants={participants}
                  events={events}
                  artifacts={artifacts}
                  terminalOpen={terminalOpen}
                  onToggleTerminal={toggleTerminal}
                  onOpenMedia={setSelectedMediaArtifactId}
                />
              </div>
            </div>
          )}
        </div>
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

          {/* Plan approval gate — visible whenever the session has a plan
              status (awaiting/approved/rejected). The plan content itself
              lives in the timeline as a bubble; this is just the action bar. */}
          {sessionState?.planMode && sessionState?.planApprovalStatus && (
            <PlanApprovalBanner
              sessionId={sessionId}
              status={sessionState.planApprovalStatus}
              plan={sessionState.currentPlan ?? null}
              defaultModel={defaultImplementationModel}
              defaultReasoningEffort={getDefaultReasoningEffort(defaultImplementationModel)}
              modelOptions={modelOptions}
            />
          )}

          {/* Input container */}
          <div className="border border-border bg-input">
            {/* Text input area with floating send button */}
            <div className="relative">
              <textarea
                ref={inputRef}
                value={prompt}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder={
                  isPlanAwaiting
                    ? "Amend the plan…"
                    : isPlanLocked && isProcessing
                      ? "Generating plan…"
                      : isProcessing
                        ? "Type your next message..."
                        : isPlanLocked || planToggle
                          ? "Describe what to plan"
                          : "Ask or build anything"
                }
                className="w-full resize-none bg-transparent px-4 pt-4 pb-12 focus:outline-none text-foreground placeholder:text-secondary-foreground"
                rows={3}
              />
              {/* Floating action buttons */}
              <div className="absolute bottom-3 right-3 flex items-center gap-2">
                {isProcessing && prompt.trim() && (
                  <span className="text-xs text-warning">Waiting...</span>
                )}
                {isProcessing && (
                  <button
                    type="button"
                    onClick={stopExecution}
                    className="p-2 text-destructive hover:bg-destructive-muted transition"
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

            {/* Footer row with model selector, reasoning pills, and agent
                label. In plan-locked mode (planning turn streaming or plan
                awaiting approval) the model selector + pills are hidden
                because the planning model is locked for the duration; only
                the agent label remains. */}
            <div className="flex flex-col gap-2 px-4 py-2 border-t border-border-muted sm:flex-row sm:items-center sm:justify-between sm:gap-0">
              {!isPlanLocked && (
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

                  <ReasoningEffortPills
                    selectedModel={selectedModel}
                    reasoningEffort={reasoningEffort}
                    onSelect={setReasoningEffort}
                    disabled={isProcessing}
                  />

                  {/* Per-prompt plan toggle. OFF by default; clicking ON
                      sends `planMode: true` with the next prompt so the
                      server runs it as a planning turn. */}
                  <button
                    type="button"
                    onClick={() => setPlanToggle(!planToggle)}
                    disabled={isProcessing}
                    aria-pressed={planToggle}
                    className={`rounded border px-2 py-0.5 text-xs transition disabled:opacity-50 disabled:cursor-not-allowed ${
                      planToggle
                        ? "border-accent bg-accent-muted text-accent"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                    title={
                      planToggle
                        ? "Plan mode ON — next prompt will generate a plan"
                        : "Plan mode OFF — next prompt will build directly"
                    }
                  >
                    Plan
                  </button>
                </div>
              )}

              {/* Agent label. Plan-mode sessions run planning turns until
                  the plan reaches a terminal status (approved or rejected);
                  any terminal state reverts to the build agent. The per-prompt
                  planToggle also flips the label so the user sees what the
                  next prompt will run as. */}
              <span className="hidden sm:inline text-sm text-muted-foreground sm:ml-auto">
                {planToggle ||
                (sessionState?.planMode &&
                  sessionState?.planApprovalStatus !== "approved" &&
                  sessionState?.planApprovalStatus !== "rejected")
                  ? "plan agent"
                  : "build agent"}
              </span>
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

function SandboxStatus({ status }: { status?: string }) {
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

function ThinkingIndicator() {
  return (
    <div className="bg-card p-4 flex items-center gap-2">
      <span className="inline-block w-2 h-2 bg-accent rounded-full animate-pulse" />
      <span className="text-sm text-muted-foreground">Thinking...</span>
    </div>
  );
}

function PlanBubble({ plan, status }: { plan: PlanArtifact; status: PlanBubbleStatus }) {
  // The awaiting plan is pinned open (the user must read it to approve);
  // every terminal/older state defaults to collapsed and is togglable.
  const isAwaiting = status === "awaiting";
  const [expanded, setExpanded] = useState(isAwaiting);
  const time = new Date(plan.createdAt).toLocaleTimeString();
  const showContent = isAwaiting || expanded;

  const styles: Record<
    PlanBubbleStatus,
    { container: string; titleStrike: boolean; badge: { text: string; className: string } | null }
  > = {
    awaiting: {
      container: "bg-card p-4 border-l-2 border-accent",
      titleStrike: false,
      badge: null,
    },
    approved: {
      container: "bg-card p-4 border-l-2 border-success",
      titleStrike: false,
      badge: {
        text: "accepted",
        className: "bg-success-muted text-success-foreground",
      },
    },
    rejected: {
      container:
        "bg-destructive-muted/15 p-4 border-l-2 border-dashed border-destructive opacity-75",
      titleStrike: true,
      badge: {
        text: "rejected",
        className: "bg-destructive-muted text-destructive-foreground",
      },
    },
    superseded: {
      container: "bg-muted/20 p-4 border-l-2 border-dashed border-border-muted opacity-75",
      titleStrike: true,
      badge: {
        text: "superseded",
        className: "bg-muted text-secondary-foreground",
      },
    },
  };

  const { container, titleStrike, badge } = styles[status];

  const headerLabel = (
    <>
      <span className={titleStrike ? "line-through" : ""}>Plan v{plan.version}</span>
      {badge && (
        <span
          className={`ml-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${badge.className}`}
        >
          {badge.text}
        </span>
      )}
    </>
  );

  return (
    <div id={`plan-${plan.id}`} className={container}>
      {isAwaiting ? (
        <div className="flex w-full items-center justify-between mb-2">
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            {headerLabel}
          </span>
          <span className="text-xs text-secondary-foreground">{time}</span>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center justify-between mb-2 text-left hover:opacity-80 transition"
          aria-expanded={expanded}
        >
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            {expanded ? (
              <ChevronDownIcon className="w-3.5 h-3.5" />
            ) : (
              <ChevronRightIcon className="w-3.5 h-3.5" />
            )}
            {headerLabel}
          </span>
          <span className="text-xs text-secondary-foreground">{time}</span>
        </button>
      )}
      {showContent &&
        (plan.content ? (
          <SafeMarkdown content={plan.content} className="text-sm" />
        ) : (
          <p className="text-xs text-secondary-foreground">No plan content available.</p>
        ))}
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
  sessionId,
  currentParticipantId,
  onOpenMedia,
}: {
  event: SandboxEvent;
  sessionId: string;
  currentParticipantId: string | null;
  onOpenMedia: (artifactId: string) => void;
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
        <div className="flex items-center gap-2 text-sm text-destructive py-1">
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

    case "artifact":
      if (
        (event.artifactType !== "screenshot" && event.artifactType !== "video") ||
        !event.artifactId
      ) {
        return null;
      }

      return (
        <div className="space-y-2 border border-border-muted bg-card p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {event.artifactType === "video" ? "Video" : "Screenshot"}
            </span>
            <span className="text-xs text-secondary-foreground">{time}</span>
          </div>
          <ScreenshotArtifactCard
            sessionId={sessionId}
            artifactId={event.artifactId}
            artifactType={event.artifactType}
            metadata={event.metadata as Artifact["metadata"] | undefined}
            onOpen={onOpenMedia}
          />
        </div>
      );

    case "error":
      return (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <span className="w-2 h-2 rounded-full bg-destructive" />
          Error{event.error ? `: ${event.error}` : ""}
          <span className="text-xs text-secondary-foreground">{time}</span>
        </div>
      );

    case "execution_complete":
      if (event.success === false) {
        return (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <span className="w-2 h-2 rounded-full bg-destructive" />
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

"use client";

import { useSession } from "next-auth/react";
import { useParams, useRouter } from "next/navigation";
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useSessionSocket } from "@/hooks/use-session-socket";
import { SafeMarkdown } from "@/components/safe-markdown";
import { ToolCallGroup } from "@/components/tool-call-group";
import { SidebarLayout, useSidebarContext } from "@/components/sidebar-layout";
import { SessionRightSidebar } from "@/components/session-right-sidebar";
import { ActionBar } from "@/components/action-bar";
import { formatModelNameLower } from "@/lib/format";
import type { SandboxEvent } from "@/lib/tool-formatters";

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

// Model options configuration
interface ModelOption {
  id: string;
  name: string;
  description: string;
  category?: string;
}

const MODEL_OPTIONS: { category: string; models: ModelOption[] }[] = [
  {
    category: "Model",
    models: [
      { id: "claude-haiku-4-5", name: "claude haiku 4.5", description: "Fast and efficient" },
      { id: "claude-sonnet-4-5", name: "claude sonnet 4.5", description: "Balanced performance" },
      { id: "claude-opus-4-5", name: "claude opus 4.5", description: "Most capable" },
    ],
  },
];

function CheckIcon() {
  return (
    <svg className="w-4 h-4 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  );
}

function ModelOptionButton({
  model,
  isSelected,
  onSelect,
}: {
  model: ModelOption;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-muted transition ${
        isSelected ? "text-foreground" : "text-muted-foreground"
      }`}
    >
      <div className="flex flex-col items-start">
        <span className="font-medium">{model.name}</span>
        <span className="text-xs text-secondary-foreground">{model.description}</span>
      </div>
      {isSelected && <CheckIcon />}
    </button>
  );
}

export default function SessionPage() {
  const { data: _authSession, status: authStatus } = useSession();
  const params = useParams();
  const router = useRouter();
  const sessionId = params.id as string;

  const {
    connected,
    connecting,
    authError,
    connectionError,
    sessionState,
    events,
    participants,
    artifacts,
    currentParticipantId,
    isProcessing,
    sendPrompt,
    stopExecution,
    sendTyping,
    reconnect,
  } = useSessionSocket(sessionId);

  const handleArchive = useCallback(async () => {
    try {
      const response = await fetch(`/api/sessions/${sessionId}/archive`, {
        method: "POST",
      });
      if (!response.ok) {
        console.error("Failed to archive session");
      }
    } catch (error) {
      console.error("Failed to archive session:", error);
    }
  }, [sessionId]);

  const handleUnarchive = useCallback(async () => {
    try {
      const response = await fetch(`/api/sessions/${sessionId}/unarchive`, {
        method: "POST",
      });
      if (!response.ok) {
        console.error("Failed to unarchive session");
      }
    } catch (error) {
      console.error("Failed to unarchive session:", error);
    }
  }, [sessionId]);

  const [prompt, setPrompt] = useState("");
  const [selectedModel, setSelectedModel] = useState("claude-haiku-4-5");
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom when new content arrives
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  // Redirect if not authenticated
  useEffect(() => {
    if (authStatus === "unauthenticated") {
      router.push("/");
    }
  }, [authStatus, router]);

  // Close model dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target as Node)) {
        setModelDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || isProcessing) return;

    sendPrompt(prompt, selectedModel);
    setPrompt("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
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

  if (authStatus === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-foreground" />
      </div>
    );
  }

  return (
    <SidebarLayout>
      <SessionContent
        sessionState={sessionState}
        connected={connected}
        connecting={connecting}
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
        modelDropdownOpen={modelDropdownOpen}
        modelDropdownRef={modelDropdownRef}
        inputRef={inputRef}
        handleSubmit={handleSubmit}
        handleInputChange={handleInputChange}
        handleKeyDown={handleKeyDown}
        setModelDropdownOpen={setModelDropdownOpen}
        setSelectedModel={setSelectedModel}
        stopExecution={stopExecution}
        handleArchive={handleArchive}
        handleUnarchive={handleUnarchive}
      />
    </SidebarLayout>
  );
}

function SessionContent({
  sessionState,
  connected,
  connecting,
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
  modelDropdownOpen,
  modelDropdownRef,
  inputRef,
  handleSubmit,
  handleInputChange,
  handleKeyDown,
  setModelDropdownOpen,
  setSelectedModel,
  stopExecution,
  handleArchive,
  handleUnarchive,
}: {
  sessionState: ReturnType<typeof useSessionSocket>["sessionState"];
  connected: boolean;
  connecting: boolean;
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
  modelDropdownOpen: boolean;
  modelDropdownRef: React.RefObject<HTMLDivElement | null>;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  handleSubmit: (e: React.FormEvent) => void;
  handleInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  setModelDropdownOpen: (open: boolean) => void;
  setSelectedModel: (model: string) => void;
  stopExecution: () => void;
  handleArchive: () => void;
  handleUnarchive: () => void;
}) {
  const { isOpen, toggle } = useSidebarContext();

  // Deduplicate and group events for rendering
  const groupedEvents = useMemo(() => {
    const filteredEvents: SandboxEvent[] = [];
    const seenToolCalls = new Map<string, number>();
    const seenCompletions = new Set<string>();

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
      } else {
        // All other events (token, user_message, git_sync, etc.) - add as-is
        filteredEvents.push(event);
      }
    }

    return groupEvents(filteredEvents);
  }, [events]);

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
                title="Open sidebar"
              >
                <SidebarToggleIcon />
              </button>
            )}
            <div>
              <h1 className="font-medium text-foreground">
                {sessionState?.title || `${sessionState?.repoOwner}/${sessionState?.repoName}`}
              </h1>
              <p className="text-sm text-muted-foreground">
                {sessionState?.repoOwner}/{sessionState?.repoName}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <ConnectionStatus connected={connected} connecting={connecting} />
            <SandboxStatus status={sessionState?.sandboxStatus} />
            <ParticipantsList participants={participants} />
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
        <div className="flex-1 overflow-y-auto p-4">
          <div className="max-w-3xl mx-auto space-y-2">
            {groupedEvents.map((group) =>
              group.type === "tool_group" ? (
                <ToolCallGroup key={group.id} events={group.events} groupId={group.id} />
              ) : (
                <EventItem
                  key={group.id}
                  event={group.event}
                  currentParticipantId={currentParticipantId}
                />
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
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <rect x="6" y="6" width="12" height="12" rx="1" strokeWidth={2} />
                    </svg>
                  </button>
                )}
                <button
                  type="submit"
                  disabled={!prompt.trim() || isProcessing}
                  className="p-2 text-secondary-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition"
                  title={isProcessing && prompt.trim() ? "Wait for execution to complete" : "Send"}
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 10l7-7m0 0l7 7m-7-7v18"
                    />
                  </svg>
                </button>
              </div>
            </div>

            {/* Footer row with model selector and agent label */}
            <div className="flex items-center justify-between px-4 py-2 border-t border-border-muted">
              {/* Left side - Model selector */}
              <div className="relative" ref={modelDropdownRef}>
                <button
                  type="button"
                  onClick={() => !isProcessing && setModelDropdownOpen(!modelDropdownOpen)}
                  disabled={isProcessing}
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition"
                >
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                  </svg>
                  <span>{formatModelNameLower(selectedModel)}</span>
                </button>

                {/* Dropdown menu */}
                {modelDropdownOpen && (
                  <div className="absolute bottom-full left-0 mb-2 w-56 bg-background shadow-lg border border-border py-1 z-50">
                    {MODEL_OPTIONS.map((group, groupIdx) => (
                      <div key={group.category}>
                        <div
                          className={`px-3 py-1.5 text-xs font-medium text-secondary-foreground uppercase tracking-wider ${
                            groupIdx > 0 ? "border-t border-border-muted mt-1" : ""
                          }`}
                        >
                          {group.category}
                        </div>
                        {group.models.map((model) => (
                          <ModelOptionButton
                            key={model.id}
                            model={model}
                            isSelected={selectedModel === model.id}
                            onSelect={() => {
                              setSelectedModel(model.id);
                              setModelDropdownOpen(false);
                            }}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Right side - Agent label */}
              <span className="text-sm text-muted-foreground">build agent</span>
            </div>
          </div>
        </form>
      </footer>
    </div>
  );
}

function SidebarToggleIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
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

function ThinkingIndicator() {
  return (
    <div className="bg-card p-4 flex items-center gap-2">
      <span className="inline-block w-2 h-2 bg-accent rounded-full animate-pulse" />
      <span className="text-sm text-muted-foreground">Thinking...</span>
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

function EventItem({
  event,
  currentParticipantId,
}: {
  event: {
    type: string;
    content?: string;
    tool?: string;
    args?: Record<string, unknown>;
    result?: string;
    error?: string;
    success?: boolean;
    status?: string;
    timestamp: number;
    author?: {
      participantId: string;
      name: string;
      avatar?: string;
    };
  };
  currentParticipantId: string | null;
}) {
  const time = new Date(event.timestamp * 1000).toLocaleTimeString();

  switch (event.type) {
    case "user_message": {
      // Display user's prompt with correct author attribution
      if (!event.content) return null;

      // Determine if this message is from the current user
      const isCurrentUser =
        event.author?.participantId && currentParticipantId
          ? event.author.participantId === currentParticipantId
          : !event.author; // Messages without author are assumed to be from current user (local)

      const authorName = isCurrentUser ? "You" : event.author?.name || "Unknown User";

      return (
        <div className="bg-accent-muted p-4 ml-8">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              {!isCurrentUser && event.author?.avatar && (
                <img src={event.author.avatar} alt={authorName} className="w-5 h-5 rounded-full" />
              )}
              <span className="text-xs text-accent">{authorName}</span>
            </div>
            <span className="text-xs text-secondary-foreground">{time}</span>
          </div>
          <pre className="whitespace-pre-wrap text-sm text-foreground">{event.content}</pre>
        </div>
      );
    }

    case "token":
      // Display the model's text response with safe markdown rendering
      if (!event.content) return null;
      return (
        <div className="bg-card p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-muted-foreground">Assistant</span>
            <span className="text-xs text-secondary-foreground">{time}</span>
          </div>
          <SafeMarkdown content={event.content} className="text-sm" />
        </div>
      );

    case "tool_call":
      // Tool calls are handled by ToolCallGroup component
      return null;

    case "tool_result":
      // Tool results are now shown inline with tool calls
      // Only show standalone results if they're errors
      if (!event.error) return null;
      return (
        <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400 py-1">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
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
}

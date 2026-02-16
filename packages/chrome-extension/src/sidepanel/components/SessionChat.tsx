import { useState, useEffect, useRef, useCallback } from "react";
import { SessionWsManager } from "@/lib/ws";
import { Button } from "@/components/ui/button";
import { ModelSelector, useModelState } from "@/sidepanel/components/ModelSelector";
import { ElementCapture } from "@/sidepanel/components/ElementCapture";
import type { CapturedElement, ContentMessage } from "@/shared/types";

// the control plane sends more message types than the shared ServerMessage union defines.
// this extended type covers the additional ones we handle.
interface ExtendedServerMessage {
  type: string;
  state?: {
    title: string | null;
    repoOwner: string;
    repoName: string;
    status: string;
    sandboxStatus: string;
    isProcessing?: boolean;
  };
  event?: ChatEvent;
  items?: ChatEvent[];
  hasMore?: boolean;
  cursor?: unknown;
  status?: string;
  isProcessing?: boolean;
  error?: string;
  participantId?: string;
}

interface SessionChatProps {
  sessionId: string;
  onBack: () => void;
}

// simplified event for the chat timeline
interface ChatEvent {
  id: string;
  type: string;
  content?: string;
  tool?: string;
  messageId?: string;
  timestamp: number;
  author?: { name: string; avatar?: string };
}

interface SessionInfo {
  title: string | null;
  repoOwner: string;
  repoName: string;
  status: string;
  sandboxStatus: string;
  isProcessing: boolean;
}

export function SessionChat({ sessionId, onBack }: SessionChatProps) {
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [isPickerActive, setIsPickerActive] = useState(false);
  const [capturedElement, setCapturedElement] = useState<CapturedElement | null>(null);
  const { model, reasoningEffort, setModel, setReasoningEffort } = useModelState();
  const wsRef = useRef<SessionWsManager | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingTextRef = useRef<{ content: string; messageId: string; timestamp: number } | null>(
    null
  );

  // auto-scroll to bottom on new events
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  // listen for captured elements from content script
  useEffect(() => {
    const listener = (message: ContentMessage) => {
      if (message.type === "WRENCH_ELEMENT_CAPTURED") {
        setCapturedElement(message.payload);
        setIsPickerActive(false);
      }
      if (message.type === "WRENCH_PICKER_CANCELLED") {
        setIsPickerActive(false);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  // connect websocket
  useEffect(() => {
    const manager = new SessionWsManager({
      sessionId,
      onConnecting: () => setConnecting(true),
      onConnected: () => {
        setConnected(true);
        setConnecting(false);
        setError(null);
      },
      onDisconnected: (reason) => {
        setConnected(false);
        setConnecting(false);
        if (reason === "auth") setError("Authentication failed. Please sign in again.");
        else if (reason === "expired") setError("Session expired.");
        else if (reason === "error") setError("Connection lost.");
      },
      onMessage: (rawData) => {
        // the control plane sends types beyond the shared ServerMessage union.
        // we handle the full set here via a broader type.
        const data = rawData as unknown as ExtendedServerMessage;

        switch (data.type) {
          case "subscribed":
            setEvents([]);
            pendingTextRef.current = null;
            if (data.state) {
              setSessionInfo({
                title: data.state.title,
                repoOwner: data.state.repoOwner,
                repoName: data.state.repoName,
                status: data.state.status,
                sandboxStatus: data.state.sandboxStatus,
                isProcessing: data.state.isProcessing ?? false,
              });
            }
            break;

          case "sandbox_event": {
            const event = data.event;
            if (!event) break;

            if (event.type === "token" && event.content && event.messageId) {
              // accumulate text, display on completion
              pendingTextRef.current = {
                content: event.content,
                messageId: event.messageId,
                timestamp: event.timestamp,
              };
            } else if (event.type === "execution_complete") {
              if (pendingTextRef.current) {
                const pending = pendingTextRef.current;
                pendingTextRef.current = null;
                setEvents((prev) => [
                  ...prev,
                  {
                    id: `text-${pending.messageId}`,
                    type: "token",
                    content: pending.content,
                    messageId: pending.messageId,
                    timestamp: pending.timestamp,
                  },
                ]);
              }
              setEvents((prev) => [
                ...prev,
                { id: `complete-${Date.now()}`, type: "execution_complete", timestamp: event.timestamp },
              ]);
              setSessionInfo((prev) => (prev ? { ...prev, isProcessing: false } : null));
            } else {
              setEvents((prev) => [
                ...prev,
                { ...event, id: event.id || `evt-${Date.now()}-${Math.random()}` },
              ]);
            }
            break;
          }

          case "replay_complete":
            // initial replay done
            break;

          case "sandbox_warming":
          case "sandbox_spawning":
            setSessionInfo((prev) =>
              prev ? { ...prev, sandboxStatus: "warming" } : null
            );
            break;

          case "sandbox_ready":
            setSessionInfo((prev) =>
              prev ? { ...prev, sandboxStatus: "ready" } : null
            );
            break;

          case "processing_status":
            if (typeof data.isProcessing === "boolean") {
              const isProcessing = data.isProcessing;
              setSessionInfo((prev) =>
                prev ? { ...prev, isProcessing } : null
              );
            }
            break;

          case "sandbox_status":
            if (data.status) {
              const status = data.status;
              setSessionInfo((prev) =>
                prev ? { ...prev, sandboxStatus: status } : null
              );
            }
            break;
        }
      },
    });

    wsRef.current = manager;
    manager.connect();

    return () => {
      manager.destroy();
      wsRef.current = null;
    };
  }, [sessionId]);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed && !capturedElement) return;

    // build prompt content with optional element context
    let content = trimmed;
    if (capturedElement) {
      const elementContext = formatElementContext(capturedElement);
      content = `${elementContext}\n\n${trimmed}`;
      setCapturedElement(null);
    }

    wsRef.current?.sendPrompt(content, model, reasoningEffort);
    setSessionInfo((prev) => (prev ? { ...prev, isProcessing: true } : null));
    setInput("");
  }, [input, capturedElement, model, reasoningEffort]);

  const handleStartPicker = useCallback(async () => {
    setIsPickerActive(true);
    // get the active tab and inject the picker command
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: "WRENCH_START_PICKER" } satisfies ContentMessage);
    }
  }, []);

  const handleCancelPicker = useCallback(async () => {
    setIsPickerActive(false);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: "WRENCH_CANCEL_PICKER" } satisfies ContentMessage);
    }
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-ash-200 flex-shrink-0">
        <Button variant="ghost" size="xs" onClick={onBack}>
          <ArrowLeftIcon />
        </Button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-ash-900 truncate font-clash">
            {sessionInfo?.title || "Session"}
          </p>
          <div className="flex items-center gap-1.5">
            <StatusDot status={sessionInfo?.sandboxStatus || "pending"} />
            <span className="text-xs text-ash-500">
              {sessionInfo?.repoOwner}/{sessionInfo?.repoName}
            </span>
          </div>
        </div>
        {connecting && (
          <div className="animate-spin rounded-full h-4 w-4 border border-ash-300 border-t-rebolt-500" />
        )}
      </div>

      {/* event timeline */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-none px-4 py-3 space-y-2">
        {events.length === 0 && connected && !sessionInfo?.isProcessing && (
          <div className="text-center py-8">
            <p className="text-sm text-ash-400">
              {sessionInfo?.sandboxStatus === "warming"
                ? "Warming up sandbox..."
                : "Send a prompt to get started"}
            </p>
          </div>
        )}

        {events.map((event) => (
          <EventItem key={event.id} event={event} />
        ))}

        {sessionInfo?.isProcessing && (
          <div className="flex items-center gap-2 text-sm text-ash-500 py-1">
            <div className="animate-pulse flex gap-1">
              <span className="w-1.5 h-1.5 bg-rebolt-500 rounded-full animate-bounce" />
              <span className="w-1.5 h-1.5 bg-rebolt-500 rounded-full animate-bounce [animation-delay:150ms]" />
              <span className="w-1.5 h-1.5 bg-rebolt-500 rounded-full animate-bounce [animation-delay:300ms]" />
            </div>
            <span>Working...</span>
          </div>
        )}
      </div>

      {/* error */}
      {error && (
        <div className="mx-4 mb-2 px-3 py-2 bg-lava-100 border border-lava-200 rounded-lg">
          <p className="text-xs text-lava-700">{error}</p>
        </div>
      )}

      {/* captured element preview */}
      {capturedElement && (
        <ElementCapture
          element={capturedElement}
          onRemove={() => setCapturedElement(null)}
        />
      )}

      {/* input area */}
      <div className="px-4 py-3 border-t border-ash-200 space-y-2 flex-shrink-0">
        {/* model selector row */}
        <ModelSelector
          model={model}
          reasoningEffort={reasoningEffort}
          onModelChange={setModel}
          onReasoningChange={setReasoningEffort}
        />

        {/* input row */}
        <div className="flex items-end gap-2">
          <Button
            variant={isPickerActive ? "rebolt-primary" : "ghost"}
            size="xs"
            onClick={isPickerActive ? handleCancelPicker : handleStartPicker}
            title={isPickerActive ? "Cancel element picker" : "Inspect element"}
            className="flex-shrink-0"
          >
            <CrosshairIcon />
          </Button>

          <div className="flex-1 relative">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Send a message..."
              rows={1}
              className="w-full px-3 py-2 bg-white border border-ash-300 rounded-lg text-sm text-ash-900 placeholder:text-ash-400 resize-none focus:outline-none focus:ring-2 focus:ring-rebolt-500/30 focus:border-rebolt-500"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
            />
          </div>

          <Button
            variant="rebolt-primary"
            size="xs"
            onClick={handleSend}
            disabled={!connected || (!input.trim() && !capturedElement)}
            className="flex-shrink-0"
          >
            <SendIcon />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── sub-components ──

function EventItem({ event }: { event: ChatEvent }) {
  if (event.type === "user_message") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] px-3 py-2 bg-rebolt-100 rounded-lg rounded-br-sm">
          <p className="text-sm text-ash-900 whitespace-pre-wrap">{event.content}</p>
        </div>
      </div>
    );
  }

  if (event.type === "token") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] px-3 py-2 bg-white border border-ash-200 rounded-lg rounded-bl-sm">
          <p className="text-sm text-ash-900 whitespace-pre-wrap">{event.content}</p>
        </div>
      </div>
    );
  }

  if (event.type === "tool_call") {
    return (
      <div className="flex items-center gap-2 text-xs text-ash-500 py-0.5">
        <ToolIcon />
        <span className="truncate">
          {event.tool || "tool call"}
        </span>
      </div>
    );
  }

  if (event.type === "tool_result") {
    return null; // tool results are noisy in a compact sidebar
  }

  if (event.type === "git_sync") {
    return (
      <div className="flex items-center gap-2 text-xs text-rebolt-500 py-0.5">
        <GitIcon />
        <span>Code synced</span>
      </div>
    );
  }

  if (event.type === "execution_complete") {
    return (
      <div className="flex items-center gap-2 text-xs text-mint-500 py-1">
        <CheckIcon />
        <span>Completed</span>
      </div>
    );
  }

  if (event.type === "error") {
    return (
      <div className="px-3 py-2 bg-lava-100 rounded-lg">
        <p className="text-xs text-lava-700">{event.content || "An error occurred"}</p>
      </div>
    );
  }

  // fallback - don't render unknown events
  return null;
}

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    ready: "bg-mint-400",
    running: "bg-mint-400 animate-pulse",
    warming: "bg-honey-400 animate-pulse",
    spawning: "bg-honey-400 animate-pulse",
    syncing: "bg-sky-400 animate-pulse",
    pending: "bg-ash-400",
    stopped: "bg-ash-400",
    failed: "bg-lava-500",
  };
  return <div className={`w-1.5 h-1.5 rounded-full ${colors[status] || "bg-ash-400"}`} />;
}

function formatElementContext(element: CapturedElement): string {
  const lines: string[] = ["[element context from page inspection]", `url: ${element.pageUrl}`];

  if (element.reactTree) {
    lines.push("react component tree:");
    lines.push(formatReactTree(element.reactTree, 0));
  } else {
    lines.push(`element: <${element.tagName}>`);
    lines.push(`selector: ${element.selector}`);
    // include truncated html
    const html = element.html.length > 2000 ? element.html.slice(0, 2000) + "..." : element.html;
    lines.push(`html:\n${html}`);
  }

  return lines.join("\n");
}

function formatReactTree(node: { name: string; props: Record<string, string>; children: typeof node[] }, depth: number): string {
  const indent = "  ".repeat(depth);
  const propsStr = Object.entries(node.props)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
  const opening = propsStr ? `<${node.name} ${propsStr}>` : `<${node.name}>`;

  if (node.children.length === 0) {
    return `${indent}${opening}`;
  }

  const childLines = node.children.map((c) => formatReactTree(c, depth + 1)).join("\n");
  return `${indent}${opening}\n${childLines}`;
}

// ── icons ──

function ArrowLeftIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function CrosshairIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <circle cx="12" cy="12" r="10" />
      <line x1="22" y1="12" x2="18" y2="12" />
      <line x1="6" y1="12" x2="2" y2="12" />
      <line x1="12" y1="6" x2="12" y2="2" />
      <line x1="12" y1="22" x2="12" y2="18" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

function ToolIcon() {
  return (
    <svg className="w-3 h-3 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

function GitIcon() {
  return (
    <svg className="w-3 h-3 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <circle cx="12" cy="12" r="4" />
      <line x1="1.05" y1="12" x2="7" y2="12" />
      <line x1="17.01" y1="12" x2="22.96" y2="12" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="w-3 h-3 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

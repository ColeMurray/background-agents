"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SafeMarkdown } from "@/components/safe-markdown";
import { ScreenshotArtifactCard } from "@/components/screenshot-artifact-card";
import { ToolCallGroup } from "@/components/tool-call-group";
import { copyToClipboard } from "@/lib/format";
import type { Artifact, SandboxEvent } from "@/types/session";
import { CheckIcon, CopyIcon, ErrorIcon } from "@/components/ui/icons";

type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;

export type EventGroup =
  | { type: "tool_group"; events: ToolCallEvent[]; id: string }
  | { type: "single"; event: SandboxEvent; id: string };

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
      if (currentToolGroup.length > 0 && currentToolGroup[0].tool === event.tool) {
        currentToolGroup.push(event);
      } else {
        flushToolGroup();
        currentToolGroup = [event];
      }
    } else {
      flushToolGroup();
      groups.push({
        type: "single",
        event,
        id: `single-${event.type}-${("messageId" in event ? event.messageId : undefined) || event.timestamp}-${groupIndex++}`,
      });
    }
  }

  flushToolGroup();

  return groups;
}

export function dedupeAndGroupEvents(events: SandboxEvent[]): EventGroup[] {
  const filteredEvents: Array<SandboxEvent | null> = [];
  const seenToolCalls = new Map<string, number>();
  const seenCompletions = new Set<string>();
  const seenTokens = new Map<string, number>();

  for (const event of events) {
    if (event.type === "tool_call" && event.callId) {
      const existingIdx = seenToolCalls.get(event.callId);
      if (existingIdx !== undefined) {
        filteredEvents[existingIdx] = event;
      } else {
        seenToolCalls.set(event.callId, filteredEvents.length);
        filteredEvents.push(event);
      }
    } else if (event.type === "execution_complete" && event.messageId) {
      if (!seenCompletions.has(event.messageId)) {
        seenCompletions.add(event.messageId);
        filteredEvents.push(event);
      }
    } else if (event.type === "token" && event.messageId) {
      const existingIdx = seenTokens.get(event.messageId);
      if (existingIdx !== undefined) {
        filteredEvents[existingIdx] = null;
      }
      seenTokens.set(event.messageId, filteredEvents.length);
      filteredEvents.push(event);
    } else {
      filteredEvents.push(event);
    }
  }

  return groupEvents(filteredEvents.filter((event): event is SandboxEvent => event !== null));
}

export function SessionTimeline({
  events,
  sessionId,
  currentParticipantId,
  isProcessing,
  loadingHistory,
  showSkeleton,
  scrollContainerRef,
  topSentinelRef,
  messagesEndRef,
  onScroll,
  onOpenMedia,
}: {
  events: SandboxEvent[];
  sessionId: string;
  currentParticipantId: string | null;
  isProcessing: boolean;
  loadingHistory: boolean;
  showSkeleton: boolean;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  topSentinelRef: React.RefObject<HTMLDivElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  onOpenMedia: (artifactId: string) => void;
}) {
  const groupedEvents = useMemo(() => dedupeAndGroupEvents(events), [events]);

  return (
    <div
      ref={scrollContainerRef}
      onScroll={onScroll}
      className="h-full overflow-y-auto overflow-x-hidden p-4"
    >
      <div className="max-w-3xl mx-auto space-y-2">
        <div ref={topSentinelRef} className="h-1" />
        {loadingHistory && (
          <div className="text-center text-muted-foreground text-sm py-2">Loading...</div>
        )}
        {showSkeleton ? (
          <TimelineSkeleton />
        ) : (
          groupedEvents.map((group) =>
            group.type === "tool_group" ? (
              <ToolCallGroup key={group.id} events={group.events} groupId={group.id} />
            ) : (
              <EventItem
                key={group.id}
                event={group.event}
                sessionId={sessionId}
                currentParticipantId={currentParticipantId}
                onOpenMedia={onOpenMedia}
              />
            )
          )
        )}
        {isProcessing && <ThinkingIndicator />}

        <div ref={messagesEndRef} />
      </div>
    </div>
  );
}

export function ThinkingIndicator() {
  return (
    <div className="bg-card p-4 flex items-center gap-2">
      <span className="inline-block w-2 h-2 bg-accent rounded-full animate-pulse" />
      <span className="text-sm text-muted-foreground">Thinking...</span>
    </div>
  );
}

export function TimelineSkeleton() {
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

export const EventItem = memo(function EventItem({
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
      if (!event.content) return null;
      const messageContent = event.content;
      const isCurrentUser =
        event.author?.participantId && currentParticipantId
          ? event.author.participantId === currentParticipantId
          : !event.author;
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
      return null;

    case "tool_result":
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

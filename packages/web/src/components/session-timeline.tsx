"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
  onLoadOlder,
  onOpenMedia,
}: {
  events: SandboxEvent[];
  sessionId: string;
  currentParticipantId: string | null;
  isProcessing: boolean;
  loadingHistory: boolean;
  showSkeleton: boolean;
  onLoadOlder: () => void;
  onOpenMedia: (artifactId: string) => void;
}) {
  const groupedEvents = useMemo(() => dedupeAndGroupEvents(events), [events]);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const hasScrolledRef = useRef(false);
  const isPrependingRef = useRef(false);
  const prevScrollHeightRef = useRef(0);
  const isNearBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    hasScrolledRef.current = true;
    const el = scrollContainerRef.current;
    if (el) {
      isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    }
  }, []);

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
          prevScrollHeightRef.current = container.scrollHeight;
          isPrependingRef.current = true;
          onLoadOlder();
        }
      },
      { root: container, threshold: 0.1 }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [onLoadOlder]);

  useLayoutEffect(() => {
    if (isPrependingRef.current && scrollContainerRef.current) {
      const el = scrollContainerRef.current;
      el.scrollTop += el.scrollHeight - prevScrollHeightRef.current;
      isPrependingRef.current = false;
    }
  }, [events]);

  useEffect(() => {
    if (isNearBottomRef.current && !isPrependingRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
    }
  }, [events]);

  return (
    <div
      ref={scrollContainerRef}
      onScroll={handleScroll}
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

type EventRendererProps = {
  event: SandboxEvent;
  sessionId: string;
  currentParticipantId: string | null;
  copied: boolean;
  onCopyContent: (content: string) => void;
  onOpenMedia: (artifactId: string) => void;
};

type MessageFrameProps = {
  label: ReactNode;
  time: string;
  copied: boolean;
  content: string;
  className: string;
  copyButtonClassName: string;
  onCopyContent: (content: string) => void;
  children: ReactNode;
};

function CopyButton({
  copied,
  className,
  onClick,
}: {
  copied: boolean;
  className: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={className}
      title={copied ? "Copied" : "Copy markdown"}
      aria-label={copied ? "Copied" : "Copy markdown"}
    >
      {copied ? <CheckIcon className="w-3.5 h-3.5" /> : <CopyIcon className="w-3.5 h-3.5" />}
    </button>
  );
}

function MessageFrame({
  label,
  time,
  copied,
  content,
  className,
  copyButtonClassName,
  onCopyContent,
  children,
}: MessageFrameProps) {
  return (
    <div className={className}>
      <div className="flex items-center justify-between mb-2">
        {label}
        <div className="flex items-center gap-1.5">
          <CopyButton
            copied={copied}
            className={copyButtonClassName}
            onClick={() => onCopyContent(content)}
          />
          <span className="text-xs text-secondary-foreground">{time}</span>
        </div>
      </div>
      {children}
    </div>
  );
}

function StatusRow({
  tone,
  time,
  children,
}: {
  tone: "muted" | "success" | "destructive" | "warning";
  time: string;
  children: ReactNode;
}) {
  const dotClassName =
    tone === "success"
      ? "bg-success"
      : tone === "destructive"
        ? "bg-destructive"
        : tone === "warning"
          ? "bg-warning"
          : "bg-accent";
  const textClassName =
    tone === "success"
      ? "text-success"
      : tone === "destructive"
        ? "text-destructive"
        : tone === "warning"
          ? "text-warning"
          : "text-muted-foreground";

  return (
    <div className={`flex items-center gap-2 text-sm ${textClassName}`}>
      <span className={`w-2 h-2 rounded-full ${dotClassName}`} />
      {children}
      <span className="text-xs text-secondary-foreground">{time}</span>
    </div>
  );
}

type UserMessageEventData = Extract<SandboxEvent, { type: "user_message" }>;
type UserMessageAttachment = NonNullable<UserMessageEventData["attachments"]>[number];

function UserMessageAttachments({
  attachments,
  sessionId,
}: {
  attachments: UserMessageAttachment[];
  sessionId: string;
}) {
  return (
    <div className="flex flex-wrap gap-2 mt-3">
      {attachments.map((attachment, index) => {
        return (
          <img
            key={`${attachment.attachmentId}-${index}`}
            src={`/api/sessions/${sessionId}/attachments/${attachment.attachmentId}`}
            alt={attachment.name}
            title={attachment.name}
            className="max-h-48 max-w-full border border-border object-contain"
          />
        );
      })}
    </div>
  );
}

function UserMessageEvent({
  event,
  sessionId,
  currentParticipantId,
  copied,
  onCopyContent,
}: EventRendererProps) {
  if (event.type !== "user_message") return null;
  const attachments = event.attachments ?? [];
  if (!event.content && attachments.length === 0) return null;

  const isCurrentUser =
    event.author?.participantId && currentParticipantId
      ? event.author.participantId === currentParticipantId
      : !event.author;
  const authorName = isCurrentUser ? "You" : event.author?.name || "Unknown User";

  return (
    <MessageFrame
      label={
        <div className="flex items-center gap-2">
          {!isCurrentUser && event.author?.avatar && (
            <img src={event.author.avatar} alt={authorName} className="w-5 h-5 rounded-full" />
          )}
          <span className="text-xs text-accent">{authorName}</span>
        </div>
      }
      time={formatEventTime(event)}
      copied={copied}
      content={event.content}
      className="group bg-accent-muted p-4 ml-8"
      copyButtonClassName="p-1 text-secondary-foreground hover:text-foreground hover:bg-muted/60 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto transition-colors"
      onCopyContent={onCopyContent}
    >
      {event.content && (
        <pre className="whitespace-pre-wrap text-sm text-foreground">{event.content}</pre>
      )}
      {attachments.length > 0 && (
        <UserMessageAttachments attachments={attachments} sessionId={sessionId} />
      )}
    </MessageFrame>
  );
}

function AssistantMessageEvent({ event, copied, onCopyContent }: EventRendererProps) {
  if (event.type !== "token" || !event.content) return null;

  return (
    <MessageFrame
      label={<span className="text-xs text-muted-foreground">Assistant</span>}
      time={formatEventTime(event)}
      copied={copied}
      content={event.content}
      className="group bg-card p-4"
      copyButtonClassName="p-1 text-secondary-foreground hover:text-foreground hover:bg-muted opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto transition-colors"
      onCopyContent={onCopyContent}
    >
      <SafeMarkdown content={event.content} className="text-sm" />
    </MessageFrame>
  );
}

function ToolResultEvent({ event }: EventRendererProps) {
  if (event.type !== "tool_result" || !event.error) return null;

  return (
    <div className="flex items-center gap-2 text-sm text-destructive py-1">
      <ErrorIcon className="w-4 h-4" />
      <span className="truncate">{event.error}</span>
      <span className="text-xs text-secondary-foreground ml-auto">{formatEventTime(event)}</span>
    </div>
  );
}

function GitSyncEvent({ event }: EventRendererProps) {
  if (event.type !== "git_sync") return null;

  return (
    <StatusRow tone="muted" time={formatEventTime(event)}>
      Git sync: {event.status}
    </StatusRow>
  );
}

function ArtifactEvent({ event, sessionId, onOpenMedia }: EventRendererProps) {
  if (
    event.type !== "artifact" ||
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
        <span className="text-xs text-secondary-foreground">{formatEventTime(event)}</span>
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
}

function ErrorEvent({ event }: EventRendererProps) {
  if (event.type !== "error") return null;

  return (
    <StatusRow tone="destructive" time={formatEventTime(event)}>
      Error{event.error ? `: ${event.error}` : ""}
    </StatusRow>
  );
}

function WarningEvent({ event }: EventRendererProps) {
  if (event.type !== "warning") return null;

  return (
    <StatusRow tone="warning" time={formatEventTime(event)}>
      {event.message}
    </StatusRow>
  );
}

function ExecutionCompleteEvent({ event }: EventRendererProps) {
  if (event.type !== "execution_complete") return null;

  if (event.success === false) {
    return (
      <StatusRow tone="destructive" time={formatEventTime(event)}>
        Execution failed{event.error ? `: ${event.error}` : ""}
      </StatusRow>
    );
  }

  return (
    <StatusRow tone="success" time={formatEventTime(event)}>
      Execution complete
    </StatusRow>
  );
}

function formatEventTime(event: SandboxEvent): string {
  return new Date(event.timestamp * 1000).toLocaleTimeString();
}

const eventRenderers: Partial<
  Record<SandboxEvent["type"], (props: EventRendererProps) => ReactNode>
> = {
  user_message: UserMessageEvent,
  token: AssistantMessageEvent,
  tool_result: ToolResultEvent,
  git_sync: GitSyncEvent,
  artifact: ArtifactEvent,
  error: ErrorEvent,
  warning: WarningEvent,
  execution_complete: ExecutionCompleteEvent,
};

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

  const render = eventRenderers[event.type];
  if (!render) return null;

  return render({
    event,
    sessionId,
    currentParticipantId,
    copied,
    onCopyContent: handleCopyContent,
    onOpenMedia,
  });
});

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
import { SessionWorkGroup } from "@/components/session-work-group";
import { TaskActivityItem } from "@/components/task-activity-item";
import { TimelineRowContent } from "@/components/timeline-row-content";
import { ToolCallGroup } from "@/components/tool-call-group";
import { copyToClipboard } from "@/lib/format";
import {
  buildSessionTimelineItems,
  toolCallKey,
  type FlatTimelineItem,
  type TimelineItem,
  type ToolCallEvent,
} from "@/lib/timeline-items";
import type { Artifact, SandboxEvent } from "@/types/session";
import type { SessionParticipantProfile } from "@open-inspect/shared/types/sessions";
import { CheckIcon, CopyIcon, ErrorIcon } from "@/components/ui/icons";
import { resolveParticipantDisplay } from "@/lib/participant-display";
import { TerminalMessageReadObserver } from "./terminal-message-read-observer";
import type { SessionReadAttemptDisposition } from "@/lib/session-read-state";
import type { PromptQueueItem } from "@open-inspect/shared/types/server-messages";

export function SessionTimeline({
  events,
  sessionId,
  currentParticipantId,
  participantProfiles,
  isProcessing,
  promptQueue = [],
  loadingHistory,
  showSkeleton,
  onLoadOlder,
  onOpenMedia,
  terminalMessageReadObservationEnabled = false,
  onMarkMessageRead,
}: {
  events: SandboxEvent[];
  sessionId: string;
  currentParticipantId: string | null;
  participantProfiles: Record<string, SessionParticipantProfile>;
  isProcessing: boolean;
  promptQueue?: PromptQueueItem[];
  loadingHistory: boolean;
  showSkeleton: boolean;
  onLoadOlder: () => void;
  onOpenMedia: (artifactId: string) => void;
  terminalMessageReadObservationEnabled?: boolean;
  onMarkMessageRead?: (messageId: string) => Promise<SessionReadAttemptDisposition>;
}) {
  const timelineItems = useMemo(() => buildSessionTimelineItems(events), [events]);
  const pendingMessageIds = useMemo(
    () =>
      new Set(
        promptQueue.filter((item) => item.status === "pending").map((item) => item.messageId)
      ),
    [promptQueue]
  );
  const [expandedToolGroups, setExpandedToolGroups] = useState<Set<string>>(new Set());
  const [expandedToolCalls, setExpandedToolCalls] = useState<Set<string>>(new Set());
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Set<string>>(new Set());
  const latestTerminalMessageId = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type === "execution_complete" && event.messageId) return event.messageId;
    }
    return null;
  }, [events]);
  const latestTerminalMessageGroupRange = useMemo(() => {
    if (!latestTerminalMessageId) return null;
    const completionIndex = timelineItems.findIndex(
      (item) =>
        item.type === "single" &&
        item.event.type === "execution_complete" &&
        item.event.messageId === latestTerminalMessageId
    );
    if (completionIndex < 0) return null;
    const outputIndex = timelineItems.findIndex(
      (item) =>
        item.type === "single" &&
        item.event.type === "token" &&
        item.event.messageId === latestTerminalMessageId
    );
    return {
      start: outputIndex >= 0 ? Math.min(outputIndex, completionIndex) : completionIndex,
      end: Math.max(outputIndex, completionIndex),
    };
  }, [timelineItems, latestTerminalMessageId]);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const hasScrolledRef = useRef(false);
  const isPrependingRef = useRef(false);
  const didPrependRef = useRef(false);
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
      didPrependRef.current = true;
    }
  }, [events]);

  useLayoutEffect(() => {
    if (didPrependRef.current) {
      didPrependRef.current = false;
      return;
    }
    if (isNearBottomRef.current) {
      const container = scrollContainerRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    }
  }, [events, isProcessing]);

  const toggleToolCall = useCallback((event: ToolCallEvent) => {
    const key = toolCallKey(event);
    setExpandedToolCalls((expanded) => {
      const next = new Set(expanded);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleToolGroup = useCallback((events: ToolCallEvent[]) => {
    const keys = events.map(toolCallKey);
    setExpandedToolGroups((expanded) => {
      const next = new Set(expanded);
      if (keys.some((key) => next.has(key))) {
        for (const key of keys) next.delete(key);
      } else {
        for (const key of keys) next.add(key);
      }
      return next;
    });
  }, []);

  const toggleWorkGroup = useCallback((messageId: string) => {
    setExpandedWorkGroups((expanded) => {
      const next = new Set(expanded);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }, []);

  const renderFlatItem = (item: FlatTimelineItem): ReactNode => {
    if (item.type === "tool_group") {
      return (
        <ToolCallGroup
          key={item.id}
          events={item.events}
          isExpanded={item.events.some((event) => expandedToolGroups.has(toolCallKey(event)))}
          expandedToolCallIds={expandedToolCalls}
          onToggleGroup={() => toggleToolGroup(item.events)}
          onToggleTool={toggleToolCall}
        />
      );
    }
    if (
      item.event.type === "user_message" &&
      item.event.messageId &&
      pendingMessageIds.has(item.event.messageId)
    ) {
      return null;
    }
    return (
      <EventItem
        key={item.id}
        event={item.event}
        sessionId={sessionId}
        currentParticipantId={currentParticipantId}
        participantProfiles={participantProfiles}
        onOpenMedia={onOpenMedia}
      />
    );
  };

  const renderBaseTimelineItem = (item: TimelineItem): ReactNode =>
    item.type === "task_group" ? (
      <TaskActivityItem key={item.id} event={item.event} hasActivity={item.activity.length > 0}>
        {item.activity.map(renderFlatItem)}
      </TaskActivityItem>
    ) : (
      renderFlatItem(item)
    );

  const renderTimelineItem = (item: (typeof timelineItems)[number]): ReactNode =>
    item.type === "work_group" ? (
      <SessionWorkGroup
        key={item.id}
        durationMs={item.durationMs}
        isExpanded={expandedWorkGroups.has(item.messageId)}
        onToggle={() => toggleWorkGroup(item.messageId)}
      >
        {item.activity.map(renderBaseTimelineItem)}
      </SessionWorkGroup>
    ) : (
      renderBaseTimelineItem(item)
    );

  return (
    <div
      ref={scrollContainerRef}
      onScroll={handleScroll}
      // `relative` makes this scroller the containing block for
      // absolutely-positioned descendants (e.g. sr-only live-status spans in
      // task rows). Without it they anchor to the document, escape every
      // ancestor overflow clip, and grow the page itself.
      className="relative h-full overflow-y-auto overflow-x-hidden p-3 sm:p-4"
    >
      <div className="w-full min-w-0 max-w-3xl mx-auto space-y-2">
        <div ref={topSentinelRef} className="h-1" />
        {loadingHistory && (
          <div className="text-center text-muted-foreground text-sm py-2">Loading...</div>
        )}
        {showSkeleton ? (
          <TimelineSkeleton />
        ) : (
          timelineItems.map((item, index) => {
            if (
              latestTerminalMessageGroupRange &&
              onMarkMessageRead &&
              index === latestTerminalMessageGroupRange.start
            ) {
              return (
                <TerminalMessageReadObserver
                  key={`terminal-message-${latestTerminalMessageId}`}
                  messageId={latestTerminalMessageId!}
                  enabled={terminalMessageReadObservationEnabled}
                  onMarkMessageRead={onMarkMessageRead}
                >
                  {timelineItems
                    .slice(
                      latestTerminalMessageGroupRange.start,
                      latestTerminalMessageGroupRange.end + 1
                    )
                    .map(renderTimelineItem)}
                </TerminalMessageReadObserver>
              );
            }
            if (
              latestTerminalMessageGroupRange &&
              onMarkMessageRead &&
              index > latestTerminalMessageGroupRange.start &&
              index <= latestTerminalMessageGroupRange.end
            ) {
              return null;
            }
            return renderTimelineItem(item);
          })
        )}
        {isProcessing && <ThinkingIndicator />}
        <div />
      </div>
    </div>
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
      <div className="bg-card p-3 space-y-2 sm:p-4">
        <div className="h-3 w-24 bg-muted rounded" />
        <div className="h-3 w-full bg-muted rounded" />
        <div className="h-3 w-5/6 bg-muted rounded" />
      </div>
      <div className="bg-accent-muted p-3 space-y-2 sm:ml-8 sm:p-4">
        <div className="h-3 w-20 bg-muted rounded" />
        <div className="h-3 w-4/5 bg-muted rounded" />
      </div>
      <div className="bg-card p-3 space-y-2 sm:p-4">
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
  participantProfiles: Record<string, SessionParticipantProfile>;
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
    <div className={`min-w-0 ${className}`}>
      <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
        {label}
        <div className="flex shrink-0 items-center gap-1.5">
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
    <div className={`flex min-w-0 items-start gap-2 text-sm ${textClassName}`}>
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dotClassName}`} />
      <TimelineRowContent time={time}>{children}</TimelineRowContent>
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
    <div className="min-w-0 max-w-full flex flex-wrap gap-2 mt-3">
      {attachments.map((attachment) => {
        return (
          <img
            key={attachment.attachmentId}
            src={`/api/sessions/${sessionId}/attachments/${attachment.attachmentId}`}
            alt={attachment.name}
            title={attachment.name}
            loading="lazy"
            decoding="async"
            className="block h-auto max-h-48 max-w-full border border-border object-contain"
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
  participantProfiles,
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
  const profile = event.author?.userId ? participantProfiles[event.author.userId] : undefined;
  const display = resolveParticipantDisplay(
    {
      name: event.author?.name || "Unknown User",
      avatar: event.author?.avatar,
    },
    profile
  );
  const authorName = isCurrentUser ? "You" : display.name;
  const avatar = display.avatar;

  return (
    <MessageFrame
      label={
        <div className="flex min-w-0 items-center gap-2">
          {!isCurrentUser && avatar && (
            <img src={avatar} alt={authorName} className="w-5 h-5 rounded-full" />
          )}
          <span className="text-xs text-accent">{authorName}</span>
        </div>
      }
      time={formatEventTime(event)}
      copied={copied}
      content={event.content}
      className="group bg-accent-muted p-3 sm:ml-8 sm:p-4"
      copyButtonClassName="p-1 text-secondary-foreground hover:text-foreground hover:bg-muted/60 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto transition-colors"
      onCopyContent={onCopyContent}
    >
      {event.content && (
        <pre className="whitespace-pre-wrap text-sm text-foreground [overflow-wrap:anywhere]">
          {event.content}
        </pre>
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
      className="group bg-card p-3 sm:p-4"
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
    <div className="flex min-w-0 items-start gap-2 py-1 text-sm text-destructive">
      <ErrorIcon className="h-4 w-4 shrink-0" />
      <TimelineRowContent time={formatEventTime(event)}>{event.error}</TimelineRowContent>
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
    <div className="space-y-2 border border-border-muted bg-card p-3 sm:p-4">
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

function ContextCompactedEvent({ event }: EventRendererProps) {
  if (event.type !== "context_compacted") return null;

  return (
    <div className="flex items-center gap-3 py-1 text-xs text-muted-foreground">
      <span aria-hidden="true" className="flex-1 border-t border-border-muted" />
      <span className="shrink-0">Context compacted</span>
      <span aria-hidden="true" className="flex-1 border-t border-border-muted" />
    </div>
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
  context_compacted: ContextCompactedEvent,
};

export const EventItem = memo(function EventItem({
  event,
  sessionId,
  currentParticipantId,
  participantProfiles,
  onOpenMedia,
}: {
  event: SandboxEvent;
  sessionId: string;
  currentParticipantId: string | null;
  participantProfiles: Record<string, SessionParticipantProfile>;
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
    participantProfiles,
    copied,
    onCopyContent: handleCopyContent,
    onOpenMedia,
  });
});

import type { SandboxEvent } from "@/types/session";
import type { SessionTimelineItem } from "./timeline-items";

export type TimelineVirtualRow =
  | { type: "item"; id: string; item: SessionTimelineItem }
  | { type: "terminal"; id: string; messageId: string; items: SessionTimelineItem[] }
  | { type: "loading"; id: string }
  | { type: "thinking"; id: string };

export const TIMELINE_ROW_SIZE_ESTIMATES = {
  status: 40,
  terminal: 220,
  group: 44,
  assistantMessage: 180,
  userMessage: 100,
  artifact: 420,
  default: 36,
} as const;

export const TIMELINE_VIRTUALIZER_DEFAULTS = {
  overscan: 8,
  gap: 8,
  paddingStart: 12,
  paddingEnd: 8,
  anchorTo: "end",
  followOnAppend: "auto",
  scrollEndThreshold: 100,
  useAnimationFrameWithResizeObserver: true,
} as const;

export function buildTimelineVirtualRows({
  items,
  pendingMessageIds,
  terminalMessageId,
  terminalRange,
  loadingHistory,
  isProcessing,
}: {
  items: SessionTimelineItem[];
  pendingMessageIds: ReadonlySet<string>;
  terminalMessageId: string | null;
  terminalRange: { start: number; end: number } | null;
  loadingHistory: boolean;
  isProcessing: boolean;
}): TimelineVirtualRow[] {
  const rows: TimelineVirtualRow[] = [];
  if (loadingHistory) rows.push({ type: "loading", id: "history-loading" });

  for (let index = 0; index < items.length; index += 1) {
    if (terminalMessageId && terminalRange && index === terminalRange.start) {
      rows.push({
        type: "terminal",
        id: `terminal:${terminalMessageId}`,
        messageId: terminalMessageId,
        items: items.slice(terminalRange.start, terminalRange.end + 1),
      });
      index = terminalRange.end;
      continue;
    }

    const item = items[index];
    if (isRenderableTimelineItem(item, pendingMessageIds)) {
      rows.push({ type: "item", id: `item:${item.id}`, item });
    }
  }

  if (isProcessing) rows.push({ type: "thinking", id: "thinking" });
  return rows;
}

export function estimateTimelineRowSize(row: TimelineVirtualRow): number {
  if (row.type === "loading" || row.type === "thinking") {
    return TIMELINE_ROW_SIZE_ESTIMATES.status;
  }
  if (row.type === "terminal") return TIMELINE_ROW_SIZE_ESTIMATES.terminal;
  if (row.item.type !== "single") return TIMELINE_ROW_SIZE_ESTIMATES.group;

  switch (row.item.event.type) {
    case "token":
      return TIMELINE_ROW_SIZE_ESTIMATES.assistantMessage;
    case "user_message":
      return TIMELINE_ROW_SIZE_ESTIMATES.userMessage;
    case "artifact":
      return TIMELINE_ROW_SIZE_ESTIMATES.artifact;
    default:
      return TIMELINE_ROW_SIZE_ESTIMATES.default;
  }
}

function isRenderableTimelineItem(
  item: SessionTimelineItem,
  pendingMessageIds: ReadonlySet<string>
): boolean {
  if (item.type !== "single") return true;
  const event = item.event;
  if (event.type === "user_message" && event.messageId && pendingMessageIds.has(event.messageId)) {
    return false;
  }
  return isRenderableEvent(event);
}

function isRenderableEvent(event: SandboxEvent): boolean {
  switch (event.type) {
    case "user_message":
      return Boolean(event.content || event.attachments?.length);
    case "token":
      return Boolean(event.content);
    case "tool_result":
      return Boolean(event.error);
    case "artifact":
      return (
        (event.artifactType === "screenshot" || event.artifactType === "video") &&
        Boolean(event.artifactId)
      );
    case "git_sync":
    case "error":
    case "warning":
    case "execution_complete":
    case "context_compacted":
      return true;
    default:
      return false;
  }
}

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
  terminalMessageId,
  loadingHistory,
  isProcessing,
}: {
  items: SessionTimelineItem[];
  terminalMessageId: string | null;
  loadingHistory: boolean;
  isProcessing: boolean;
}): TimelineVirtualRow[] {
  const rows: TimelineVirtualRow[] = [];
  if (loadingHistory) rows.push({ type: "loading", id: "history-loading" });
  const terminal = terminalMessageId ? findTerminalMessageRange(items, terminalMessageId) : null;

  for (let index = 0; index < items.length; index += 1) {
    if (terminal && index === terminal.start) {
      rows.push({
        type: "terminal",
        id: `terminal:${terminal.messageId}`,
        messageId: terminal.messageId,
        items: items.slice(terminal.start, terminal.end + 1),
      });
      index = terminal.end;
      continue;
    }

    const item = items[index];
    rows.push({ type: "item", id: `item:${item.id}`, item });
  }

  if (isProcessing) rows.push({ type: "thinking", id: "thinking" });
  return rows;
}

function findTerminalMessageRange(
  items: SessionTimelineItem[],
  messageId: string
): { messageId: string; start: number; end: number } | null {
  const end = items.findIndex(
    (item) =>
      item.type === "single" &&
      item.event.type === "execution_complete" &&
      item.event.messageId === messageId
  );
  if (end < 0) return null;

  let start = end;
  for (let index = 0; index < end; index += 1) {
    const item = items[index];
    if (
      item.type === "single" &&
      item.event.type === "token" &&
      item.event.messageId === messageId
    ) {
      start = index;
    }
  }
  return { messageId, start, end };
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

import type { SessionTimelineItem } from "./timeline-items";

export type TimelineVirtualRow =
  | { type: "item"; id: string; item: SessionTimelineItem }
  | { type: "loading"; id: string }
  | { type: "thinking"; id: string };

export const TIMELINE_ROW_SIZE_ESTIMATES = {
  status: 40,
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
  loadingHistory,
  isProcessing,
}: {
  items: SessionTimelineItem[];
  loadingHistory: boolean;
  isProcessing: boolean;
}): TimelineVirtualRow[] {
  const rows: TimelineVirtualRow[] = [];
  if (loadingHistory) rows.push({ type: "loading", id: "history-loading" });
  for (const item of items) rows.push({ type: "item", id: `item:${item.id}`, item });
  if (isProcessing) rows.push({ type: "thinking", id: "thinking" });
  return rows;
}

export function estimateTimelineRowSize(row: TimelineVirtualRow): number {
  if (row.type === "loading" || row.type === "thinking") {
    return TIMELINE_ROW_SIZE_ESTIMATES.status;
  }
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

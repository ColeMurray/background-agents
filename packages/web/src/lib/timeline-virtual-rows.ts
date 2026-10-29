import type { ReasoningEvent } from "@open-inspect/shared/types/sandbox-events";
import { reasoningKey } from "./reasoning";
import type { SessionTimelineItem } from "./timeline-items";

export type TimelineVirtualRow =
  | { type: "item"; id: string; item: SessionTimelineItem }
  | { type: "thinking"; id: string; reasoning: ReasoningEvent | null };

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
  isProcessing,
  liveReasoning = null,
}: {
  items: SessionTimelineItem[];
  isProcessing: boolean;
  /** The step reasoning right now; the thinking row narrates it instead of its item. */
  liveReasoning?: ReasoningEvent | null;
}): TimelineVirtualRow[] {
  const rows: TimelineVirtualRow[] = [];
  const liveKey = liveReasoning ? reasoningKey(liveReasoning) : null;
  for (const item of items) {
    const isLiveReasoning =
      liveKey !== null &&
      item.type === "single" &&
      item.event.type === "reasoning" &&
      reasoningKey(item.event) === liveKey;
    if (!isLiveReasoning) rows.push({ type: "item", id: `item:${item.id}`, item });
  }
  if (isProcessing) rows.push({ type: "thinking", id: "thinking", reasoning: liveReasoning });
  return rows;
}

export function estimateTimelineRowSize(row: TimelineVirtualRow): number {
  if (row.type === "thinking") return TIMELINE_ROW_SIZE_ESTIMATES.status;
  if (row.item.type !== "single") return TIMELINE_ROW_SIZE_ESTIMATES.group;

  switch (row.item.event.type) {
    case "token":
      return TIMELINE_ROW_SIZE_ESTIMATES.assistantMessage;
    case "user_message":
      return TIMELINE_ROW_SIZE_ESTIMATES.userMessage;
    case "artifact":
      return TIMELINE_ROW_SIZE_ESTIMATES.artifact;
    case "reasoning":
      return TIMELINE_ROW_SIZE_ESTIMATES.status;
    default:
      return TIMELINE_ROW_SIZE_ESTIMATES.default;
  }
}

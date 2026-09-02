import { describe, expect, it } from "vitest";
import type { SandboxEvent } from "@/types/session";
import {
  buildSessionTimelineItems,
  buildTimelineItems,
  type SessionTimelineItem,
} from "./timeline-items";
import {
  buildTimelineVirtualRows,
  estimateTimelineRowSize,
  TIMELINE_ROW_SIZE_ESTIMATES,
} from "./timeline-virtual-rows";

function single(event: SandboxEvent): SessionTimelineItem {
  return { type: "single", event, id: `${event.type}:${event.timestamp}` };
}

describe("buildTimelineVirtualRows", () => {
  it("excludes events that do not render and pending user messages", () => {
    const rows = buildTimelineVirtualRows({
      items: buildSessionTimelineItems(
        [
          { type: "heartbeat", sandboxId: "sandbox", timestamp: 1, status: "ready" },
          {
            type: "tool_result",
            sandboxId: "sandbox",
            messageId: "message",
            timestamp: 2,
            callId: "call",
            result: "ok",
          },
          { type: "user_message", messageId: "pending", timestamp: 3, content: "queued" },
          { type: "warning", timestamp: 4, scope: "setup", message: "visible" },
        ],
        new Set(["pending"])
      ),
      loadingHistory: false,
      isProcessing: false,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "item", item: { id: "warning:session:4" } });
  });

  it("frames the items with loading and thinking rows", () => {
    const items = [
      single({
        type: "token",
        sandboxId: "sandbox",
        messageId: "message",
        timestamp: 1,
        content: "Done",
      }),
      single({
        type: "execution_complete",
        sandboxId: "sandbox",
        messageId: "message",
        timestamp: 2,
        success: true,
      }),
    ];
    const rows = buildTimelineVirtualRows({ items, loadingHistory: true, isProcessing: true });

    expect(rows.map((row) => row.type)).toEqual(["loading", "item", "item", "thinking"]);
    expect(estimateTimelineRowSize(rows[0])).toBe(TIMELINE_ROW_SIZE_ESTIMATES.status);
    expect(estimateTimelineRowSize(rows[1])).toBe(TIMELINE_ROW_SIZE_ESTIMATES.assistantMessage);
  });
});

describe("tool group identity", () => {
  it("stays stable when older calls merge into the first group", () => {
    const tool = (callId: string, timestamp: number): SandboxEvent => ({
      type: "tool_call",
      sandboxId: "sandbox",
      messageId: "message",
      timestamp,
      callId,
      tool: "Read",
      args: {},
    });
    const existing = buildTimelineItems([tool("newer", 2)])[0];
    const prepended = buildTimelineItems([tool("older", 1), tool("newer", 2)])[0];

    expect(prepended.id).toBe(existing.id);
  });
});

import { describe, expect, it } from "vitest";
import type { ReasoningEvent } from "@open-inspect/shared/types/sandbox-events";
import type { SandboxEvent } from "@/types/session";
import { reasoningDetail, reasoningTitle, selectLiveReasoning } from "./reasoning";
import { buildTimelineItems } from "./timeline-items";

function reasoning(
  stepId: string,
  summaries: string[],
  timestamp = 10,
  active = true
): ReasoningEvent {
  return {
    type: "reasoning",
    sandboxId: "sandbox-1",
    messageId: "message-1",
    timestamp,
    stepId,
    startedAt: 1_000_000,
    updatedAt: 1_000_000 + summaries.length * 20_000,
    summaries: summaries.map((text, index) => ({ text, at: 1_000_000 + (index + 1) * 20_000 })),
    summaryCount: summaries.length,
    active,
  };
}

const toolCall: SandboxEvent = {
  type: "tool_call",
  sandboxId: "sandbox-1",
  messageId: "message-1",
  callId: "call-1",
  tool: "bash",
  args: { command: "git status" },
  timestamp: 20,
};

describe("reasoningDetail", () => {
  it("keeps everything after the title line", () => {
    expect(reasoningDetail("**Planning the fix**\n\nThe test compares local and UTC dates.")).toBe(
      "The test compares local and UTC dates."
    );
    expect(reasoningDetail("**Planning the fix**")).toBe("");
  });
});

describe("reasoningTitle", () => {
  it("shows the first line of a summary without markdown emphasis", () => {
    expect(reasoningTitle("**Reading the failing test**")).toBe("Reading the failing test");
    expect(reasoningTitle("\n__Planning__\nThe body explains more.")).toBe("Planning");
    expect(reasoningTitle("Plain **inline** emphasis")).toBe("Plain **inline** emphasis");
  });
});

describe("selectLiveReasoning", () => {
  it("narrates the newest reasoning while the runtime reports it active", () => {
    const first = reasoning("step-1", ["**Planning**"]);
    const latest = reasoning("step-1", ["**Planning**", "**Checking CI**"]);

    expect(selectLiveReasoning([first, latest], true)).toBe(latest);
    expect(selectLiveReasoning([first, latest, toolCall], true)).toBe(latest);
    expect(selectLiveReasoning([toolCall, reasoning("step-2", [])], true)?.stepId).toBe("step-2");
  });

  it("stops when the step moves on to output, however long the output takes", () => {
    const writing = reasoning("step-1", ["**Planning**"], 30, false);
    const resumed = reasoning("step-1", ["**Planning**"], 90, true);

    expect(selectLiveReasoning([reasoning("step-1", ["**Planning**"]), writing], true)).toBeNull();
    expect(selectLiveReasoning([writing, resumed], true)).toBe(resumed);
  });

  it("ignores an earlier turn's reasoning but not a queued follow-up", () => {
    const completed: SandboxEvent = {
      type: "execution_complete",
      sandboxId: "sandbox-1",
      messageId: "message-0",
      success: false,
      timestamp: 5,
    };
    const queued: SandboxEvent = {
      type: "user_message",
      messageId: "message-2",
      content: "Also update the docs",
      timestamp: 40,
    };
    const live = reasoning("step-1", ["**Planning**"]);

    expect(selectLiveReasoning([reasoning("step-0", ["**Earlier**"]), completed], true)).toBeNull();
    expect(selectLiveReasoning([live, queued], true)).toBe(live);
  });

  it("is never live once the turn stops processing", () => {
    expect(selectLiveReasoning([reasoning("step-1", ["**Planning**"])], false)).toBeNull();
  });
});

describe("reasoning timeline items", () => {
  it("keeps one row per step at its first position with the newest summaries", () => {
    const items = buildTimelineItems([
      reasoning("step-1", ["**Planning**"], 10),
      toolCall,
      reasoning("step-1", ["**Planning**", "**Checking CI**"], 30),
    ]);

    expect(items.map((item) => item.type === "single" && item.event.type)).toEqual([
      "reasoning",
      false,
    ]);
    const [row] = items;
    expect(row.type === "single" && row.event.type === "reasoning" && row.event.summaryCount).toBe(
      2
    );
  });
});

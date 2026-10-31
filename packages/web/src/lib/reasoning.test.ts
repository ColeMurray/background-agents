import { describe, expect, it } from "vitest";
import type { ReasoningEvent } from "@open-inspect/shared/types/sandbox-events";
import type { SessionSnapshot } from "@open-inspect/shared/types/server-messages";
import type { SandboxEvent } from "@/types/session";
import { nextLiveReasoning, reasoningDetail, reasoningTitle } from "./reasoning";
import {
  createSessionSocketState,
  initialSessionSocketState,
  sessionSocketReducer,
  type SessionSocketState,
} from "./session-socket/reducer";
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

function liveReasoningOf(events: SandboxEvent[]): ReasoningEvent | null {
  return events.reduce(nextLiveReasoning, null);
}

describe("nextLiveReasoning", () => {
  it("narrates the newest reasoning while the runtime reports it active", () => {
    const first = reasoning("step-1", ["**Planning**"]);
    const latest = reasoning("step-1", ["**Planning**", "**Checking CI**"]);

    expect(liveReasoningOf([first, latest])).toBe(latest);
    expect(liveReasoningOf([first, latest, toolCall])).toBe(latest);
    expect(liveReasoningOf([toolCall, reasoning("step-2", [])])?.stepId).toBe("step-2");
  });

  it("stops when the step moves on to output, however long the output takes", () => {
    const writing = reasoning("step-1", ["**Planning**"], 30, false);
    const resumed = reasoning("step-1", ["**Planning**"], 90, true);

    expect(liveReasoningOf([reasoning("step-1", ["**Planning**"]), writing])).toBeNull();
    expect(liveReasoningOf([writing, resumed])).toBe(resumed);
  });

  it("is not ended by a queued follow-up", () => {
    const queued: SandboxEvent = {
      type: "user_message",
      messageId: "message-2",
      content: "Also update the docs",
      timestamp: 40,
    };
    const live = reasoning("step-1", ["**Planning**"]);

    expect(liveReasoningOf([live, queued])).toBe(live);
  });
});

describe("live reasoning at the socket boundary", () => {
  // Commentary from an earlier step of the running turn. The display log
  // moves an unfinished turn's replayed token to its end.
  const commentary: SandboxEvent = {
    type: "token",
    sandboxId: "sandbox-1",
    messageId: "message-1",
    content: "Let me check the tests first.",
    timestamp: 5,
  };
  const live = reasoning("step-2", ["**Planning**"], 30);
  const timeline = [commentary, toolCall, live].map((event, index) => ({
    eventId: `event-${index}`,
    timelineSequence: index,
    event,
  }));
  const snapshot: SessionSnapshot = {
    session: {
      id: "session-1",
      title: null,
      repoOwner: "acme",
      repoName: "web-app",
      baseBranch: "main",
      branchName: null,
      status: "active",
      sandboxStatus: "ready",
      harness: "opencode",
      messageCount: 1,
      createdAt: 1,
      isProcessing: true,
    },
    artifacts: [],
    timeline: { events: timeline, hasMore: false, cursor: null },
    promptQueue: [],
  };

  it("keeps the live step when a snapshot's replayed token is moved after it", () => {
    const state = createSessionSocketState(snapshot);

    expect(state.events.at(-1)).toMatchObject({ type: "token" });
    expect(state.liveReasoning).toEqual(live);
  });

  it("keeps the live step when a reconnect resubscribes mid-step", () => {
    const state = sessionSocketReducer(initialSessionSocketState, {
      type: "server_message",
      message: {
        type: "subscribed",
        session: snapshot.session,
        artifacts: [],
        participantId: "participant-1",
        participant: { participantId: "participant-1", name: "Test User" },
        timeline: snapshot.timeline,
        promptQueue: [],
      },
    });

    expect(state.liveReasoning).toEqual(live);
  });

  it("forgets the live step while the socket is closed", () => {
    const closed = sessionSocketReducer(createSessionSocketState(snapshot), {
      type: "socket_closed",
    });

    expect(closed.liveReasoning).toBeNull();
  });

  it("follows live events in arrival order", () => {
    const writing = { ...live, active: false };
    const reduceEvents = (state: SessionSocketState, events: SandboxEvent[]) =>
      sessionSocketReducer(state, { type: "events_appended", events });

    const resumed = reduceEvents(createSessionSocketState(snapshot), [writing, { ...live }]);

    expect(reduceEvents(createSessionSocketState(snapshot), [writing]).liveReasoning).toBeNull();
    expect(resumed.liveReasoning).toEqual(live);
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

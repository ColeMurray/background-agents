// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { ReasoningEvent } from "@open-inspect/shared/types/sandbox-events";
import type { PromptQueueItem, SessionSnapshot } from "@open-inspect/shared/types/server-messages";
import { nextLiveReasoning } from "@/lib/reasoning";
import {
  createSessionSocketState,
  sessionSocketReducer,
  type SessionSocketAction,
  type SessionSocketState,
} from "@/lib/session-socket/reducer";
import type { SandboxEvent } from "@/types/session";
import { SessionTimeline } from "./session-timeline";

expect.extend(matchers);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

const STEP_START_MS = Date.UTC(2026, 0, 15, 12, 0, 0);
const thoughts = ["**Reading the failing test**", "**Planning the fix**"];

function reasoningEvent(
  summaries: string[],
  updatedAt = STEP_START_MS + summaries.length * 20_000,
  active = true
): ReasoningEvent {
  return {
    type: "reasoning",
    sandboxId: "sandbox-1",
    messageId: "message-1",
    timestamp: STEP_START_MS / 1000,
    stepId: "step-1",
    startedAt: STEP_START_MS,
    updatedAt,
    summaries: summaries.map((text, index) => ({
      text,
      at: STEP_START_MS + (index + 1) * 20_000,
    })),
    summaryCount: summaries.length,
    active,
  };
}

function processing(messageId: string): PromptQueueItem {
  return { messageId, content: "Fix the failing test", status: "processing" };
}

const timelineProps = {
  sessionId: "session-1",
  currentParticipantId: null,
  participantProfiles: {},
  showSkeleton: false,
  onLoadOlder: () => {},
  onOpenMedia: () => {},
};

function renderTimeline(events: SandboxEvent[], isProcessing = true) {
  return render(
    <SessionTimeline
      {...timelineProps}
      events={events}
      liveReasoning={events.reduce(nextLiveReasoning, null)}
      isProcessing={isProcessing}
      promptQueue={isProcessing ? [processing("message-1")] : []}
    />
  );
}

/** The timeline for socket state, wired as the session page wires it. */
function timelineOf(state: SessionSocketState) {
  return (
    <SessionTimeline
      {...timelineProps}
      events={state.events}
      liveReasoning={state.liveReasoning}
      isProcessing={state.sessionState?.isProcessing ?? false}
      promptQueue={state.promptQueue}
    />
  );
}

describe("reasoning progress", () => {
  it("keeps the plain thinking row for runtimes that report no reasoning", () => {
    renderTimeline([]);

    expect(screen.getByText("Thinking...")).toBeInTheDocument();
  });

  it("narrates the step being reasoned with its elapsed time and latest thought", () => {
    vi.useFakeTimers();
    vi.setSystemTime(STEP_START_MS + 372_000);
    renderTimeline([reasoningEvent(thoughts, STEP_START_MS + 360_000)]);

    expect(screen.getByText("Thinking · 6m 12s")).toBeInTheDocument();
    expect(screen.getByText("Planning the fix")).toBeInTheDocument();
    expect(screen.getByText("2 thoughts")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Thought for/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/No new thoughts/)).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByText("Thinking · 6m 15s")).toBeInTheDocument();
  });

  it("says when no new thought has arrived for minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(STEP_START_MS + 40_000 + 4 * 60_000);
    renderTimeline([reasoningEvent(thoughts)]);

    expect(screen.getByText("No new thoughts for 4m 0s")).toBeInTheDocument();
  });

  it("stops narrating once the step writes output, without a quiet note", () => {
    vi.useFakeTimers();
    vi.setSystemTime(STEP_START_MS + 40_000 + 10 * 60_000);
    renderTimeline([reasoningEvent(thoughts, STEP_START_MS + 40_000, false)]);

    expect(screen.getByText("Thinking...")).toBeInTheDocument();
    expect(screen.queryByText(/No new thoughts/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Thought for 40s/ })).toBeInTheDocument();
  });

  it("is never live once the turn stops processing", () => {
    renderTimeline([reasoningEvent(thoughts)], false);

    expect(screen.queryByText(/Thinking/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Thought for 40s/ })).toBeInTheDocument();
  });

  it("shows each summary's full text when expanded", async () => {
    renderTimeline(
      [
        reasoningEvent(
          ["**Reading the failing test**\n\nThe assertion compares local and UTC dates."],
          STEP_START_MS + 20_000,
          false
        ),
      ],
      false
    );

    await userEvent.click(screen.getByRole("button", { name: /Thought for 20s/ }));

    expect(screen.getByText("The assertion compares local and UTC dates.")).toBeInTheDocument();
  });

  it("leaves an expandable record once the step moves on", async () => {
    renderTimeline([
      reasoningEvent(thoughts, STEP_START_MS + 630_000, false),
      {
        type: "tool_call",
        tool: "bash",
        args: {},
        callId: "call-1",
        status: "completed",
        messageId: "message-1",
        sandboxId: "sandbox-1",
        timestamp: STEP_START_MS / 1000 + 656,
      },
    ]);

    const row = screen.getByRole("button", { name: /Thought for 10m 30s/ });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Reading the failing test")).not.toBeInTheDocument();

    await userEvent.click(row);

    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Reading the failing test")).toBeInTheDocument();
    expect(screen.getByText("+0:20")).toBeInTheDocument();
  });
});

describe("reasoning from a turn that has ended", () => {
  // The control plane records a stopped turn's `execution_complete` before the
  // sandbox hears `stop`, so the bridge can still open the next step's
  // reasoning, which arrives after the completion.
  const STEP_START_S = STEP_START_MS / 1000;
  const stopped: SandboxEvent = {
    type: "execution_complete",
    sandboxId: "sandbox-1",
    messageId: "message-1",
    success: false,
    error: "Execution was stopped",
    timestamp: STEP_START_S + 60,
  };
  const lateStep: ReasoningEvent = {
    ...reasoningEvent([], STEP_START_MS + 61_000),
    stepId: "step-2",
    startedAt: STEP_START_MS + 61_000,
    timestamp: STEP_START_S + 61,
  };
  const nextPrompt: SandboxEvent[] = [
    {
      type: "user_message",
      messageId: "message-2",
      content: "Try again",
      timestamp: STEP_START_S + 120,
    },
    {
      type: "tool_call",
      tool: "bash",
      args: {},
      callId: "call-2",
      messageId: "message-2",
      sandboxId: "sandbox-1",
      timestamp: STEP_START_S + 125,
    },
  ];

  function snapshot(events: SandboxEvent[], promptQueue: PromptQueueItem[]): SessionSnapshot {
    return {
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
        messageCount: 2,
        createdAt: 1,
        isProcessing: true,
      },
      artifacts: [],
      timeline: {
        events: events.map((event, index) => ({
          eventId: `event-${index}`,
          timelineSequence: index,
          event,
        })),
        hasMore: false,
        cursor: null,
      },
      promptQueue,
    };
  }

  function expectPlainThinkingRow() {
    expect(screen.getByText("Thinking...")).toBeInTheDocument();
    expect(screen.queryByText(/Thinking ·/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No new thoughts/)).not.toBeInTheDocument();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(STEP_START_MS + 10 * 60_000);
  });

  it("does not narrate the next prompt with a step that arrived after its turn ended", () => {
    const actions: SessionSocketAction[] = [
      { type: "events_appended", events: [stopped, lateStep] },
      {
        type: "server_message",
        message: { type: "prompt_queue_updated", promptQueue: [processing("message-2")] },
      },
      { type: "events_appended", events: nextPrompt },
    ];
    const state = actions.reduce(
      sessionSocketReducer,
      createSessionSocketState(snapshot([reasoningEvent(thoughts)], [processing("message-1")]))
    );

    const view = render(timelineOf(state));

    expect(state.liveReasoning).toMatchObject({ messageId: "message-1", stepId: "step-2" });
    expectPlainThinkingRow();

    const ownStep: ReasoningEvent = {
      ...reasoningEvent(["**Retrying the build**"], STEP_START_MS + 9.5 * 60_000),
      messageId: "message-2",
      stepId: "step-3",
      startedAt: STEP_START_MS + 9 * 60_000,
    };
    view.rerender(
      timelineOf(sessionSocketReducer(state, { type: "events_appended", events: [ownStep] }))
    );

    expect(screen.getByText("Thinking · 1m 0s")).toBeInTheDocument();
    expect(screen.getByText("Retrying the build")).toBeInTheDocument();
  });

  it("does not narrate the next prompt with that step after a reload", () => {
    const state = createSessionSocketState(
      snapshot(
        [reasoningEvent(thoughts), stopped, lateStep, ...nextPrompt],
        [processing("message-2")]
      )
    );

    render(timelineOf(state));

    expect(state.liveReasoning).toMatchObject({ messageId: "message-1", stepId: "step-2" });
    expectPlainThinkingRow();
  });
});

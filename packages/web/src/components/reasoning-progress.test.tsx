// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { ReasoningEvent } from "@open-inspect/shared/types/sandbox-events";
import { nextLiveReasoning } from "@/lib/reasoning";
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

function renderTimeline(events: SandboxEvent[], isProcessing = true) {
  return render(
    <SessionTimeline
      events={events}
      liveReasoning={events.reduce(nextLiveReasoning, null)}
      sessionId="session-1"
      currentParticipantId={null}
      participantProfiles={{}}
      isProcessing={isProcessing}
      showSkeleton={false}
      onLoadOlder={() => {}}
      onOpenMedia={() => {}}
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

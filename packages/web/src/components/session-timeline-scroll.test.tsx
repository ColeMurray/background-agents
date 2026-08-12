// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxEvent } from "@/types/session";
import { SessionTimeline } from "./session-timeline";

const baseTimelineProps = {
  sessionId: "session-1",
  currentParticipantId: null,
  participantProfiles: {},
  isProcessing: false,
  loadingHistory: false,
  showSkeleton: false,
  onLoadOlder: () => {},
  onOpenMedia: () => {},
} as const;

beforeEach(() => {
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as { scrollIntoView?: () => void }).scrollIntoView;
});

function toolEvent(
  tool: string,
  callId: string,
  timestamp: number,
  extra: Partial<Extract<SandboxEvent, { type: "tool_call" }>> = {}
): Extract<SandboxEvent, { type: "tool_call" }> {
  return {
    type: "tool_call",
    tool,
    args: {},
    callId,
    status: "completed",
    messageId: "message-1",
    sandboxId: "sandbox-1",
    timestamp,
    ...extra,
  };
}

describe("timeline auto-scrolling", () => {
  it("confines sub-task auto-scrolling to the timeline", () => {
    const task = toolEvent("task", "task-call", 1, {
      childSessionId: "child-1",
      status: "running",
    });
    const { container, rerender } = render(
      <SessionTimeline {...baseTimelineProps} events={[task]} />
    );
    const timeline = container.firstElementChild as HTMLDivElement;
    Object.defineProperties(timeline, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1_000 },
    });

    rerender(
      <SessionTimeline
        {...baseTimelineProps}
        events={[
          task,
          toolEvent("Read", "child-call", 2, {
            isSubtask: true,
            childSessionId: "child-1",
            taskCallId: "task-call",
          }),
        ]}
      />
    );

    expect(timeline.scrollTop).toBe(1_000);
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("does not move the timeline when the user has scrolled away from the bottom", () => {
    const task = toolEvent("task", "task-call", 1, {
      childSessionId: "child-1",
      status: "running",
    });
    const { container, rerender } = render(
      <SessionTimeline {...baseTimelineProps} events={[task]} />
    );
    const timeline = container.firstElementChild as HTMLDivElement;
    Object.defineProperties(timeline, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, value: 300, writable: true },
    });
    fireEvent.scroll(timeline);

    rerender(
      <SessionTimeline
        {...baseTimelineProps}
        events={[
          task,
          toolEvent("Read", "child-call", 2, {
            isSubtask: true,
            childSessionId: "child-1",
            taskCallId: "task-call",
          }),
        ]}
      />
    );

    expect(timeline.scrollTop).toBe(300);
  });

  it("follows processing indicator height changes before passive effects", () => {
    const events: SandboxEvent[] = [
      {
        type: "user_message",
        content: "hello",
        messageId: "message-1",
        timestamp: 1,
      },
    ];
    const observedScrollTop = vi.fn();

    function LayoutObserver({ isProcessing }: { isProcessing: boolean }) {
      const hostRef = useRef<HTMLDivElement>(null);
      useLayoutEffect(() => {
        observedScrollTop((hostRef.current?.firstElementChild as HTMLDivElement).scrollTop);
      }, [isProcessing]);
      return (
        <div ref={hostRef}>
          <SessionTimeline {...baseTimelineProps} events={events} isProcessing={isProcessing} />
        </div>
      );
    }

    const { container, rerender } = render(<LayoutObserver isProcessing={false} />);
    const timeline = container.querySelector(".overflow-y-auto") as HTMLDivElement;
    let scrollTop = 0;
    Object.defineProperties(timeline, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = Math.min(value, 800);
        },
      },
    });
    observedScrollTop.mockClear();

    rerender(<LayoutObserver isProcessing />);

    expect(observedScrollTop).toHaveBeenLastCalledWith(800);
    expect(scrollTop).toBe(800);
  });
});

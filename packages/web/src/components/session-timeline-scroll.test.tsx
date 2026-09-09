// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
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
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
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

function mockResizeObservers() {
  const observers: Array<{ callback: ResizeObserverCallback; targets: Set<Element> }> = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly targets = new Set<Element>();

      constructor(callback: ResizeObserverCallback) {
        observers.push({ callback, targets: this.targets });
      }

      observe(target: Element) {
        this.targets.add(target);
      }

      unobserve(target: Element) {
        this.targets.delete(target);
      }

      disconnect() {
        this.targets.clear();
      }
    }
  );
  return (target: Element, blockSize = 0) => {
    for (const observer of observers) {
      if (observer.targets.has(target)) {
        observer.callback(
          [
            {
              target,
              borderBoxSize: [{ inlineSize: 800, blockSize }],
            } as unknown as ResizeObserverEntry,
          ],
          {} as ResizeObserver
        );
      }
    }
  };
}

function mockTimelineScrollMetrics(metrics: {
  clientHeight: number;
  scrollHeight: number | (() => number);
  scrollTop: number;
}) {
  const value = () =>
    typeof metrics.scrollHeight === "function" ? metrics.scrollHeight() : metrics.scrollHeight;
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
    this: HTMLElement
  ) {
    return this.classList.contains("overflow-y-auto") ? metrics.clientHeight : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
    this: HTMLElement
  ) {
    return this.classList.contains("overflow-y-auto") ? value() : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(function (
    this: HTMLElement
  ) {
    return this.classList.contains("overflow-y-auto") ? metrics.scrollTop : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation(function (
    this: HTMLElement,
    next: number
  ) {
    if (this.classList.contains("overflow-y-auto")) {
      metrics.scrollTop = Math.min(next, Math.max(0, value() - metrics.clientHeight));
    }
  });
}

function mockAnimationFrames() {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  return () => {
    for (const frame of frames.splice(0)) frame(0);
  };
}

describe("timeline auto-scrolling", () => {
  it("follows measured row growth through the virtualizer", () => {
    const notifyResize = mockResizeObservers();
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
      this: HTMLElement
    ) {
      return this.hasAttribute("data-index") ? 100 : 800;
    });
    const flushAnimationFrames = mockAnimationFrames();
    const metrics = {
      clientHeight: 50,
      scrollHeight: () => {
        const spacer = document.querySelector<HTMLElement>("[data-index]")?.parentElement;
        return Number.parseFloat(spacer?.style.height ?? "0");
      },
      scrollTop: 0,
    };
    mockTimelineScrollMetrics(metrics);

    const { container } = render(
      <SessionTimeline
        {...baseTimelineProps}
        events={[
          {
            type: "user_message",
            content: "hello",
            messageId: "message-1",
            timestamp: 1,
          },
        ]}
      />
    );
    const timeline = container.firstElementChild as HTMLDivElement;
    const row = timeline.querySelector<HTMLElement>("[data-index]")!;
    const spacer = row.parentElement!;
    const estimatedHeight = Number.parseFloat(spacer.style.height);
    expect(estimatedHeight).toBe(120);
    metrics.scrollTop = 70;
    fireEvent.scroll(timeline);

    act(() => {
      notifyResize(row, 500);
      flushAnimationFrames();
    });

    expect(Number.parseFloat(spacer.style.height)).toBe(520);
    expect(metrics.scrollTop).toBe(470);
  });

  it("stays at the bottom when the timeline viewport shrinks", () => {
    const notifyResize = mockResizeObservers();
    const metrics = { clientHeight: 600, scrollHeight: 1_000, scrollTop: 0 };
    mockTimelineScrollMetrics(metrics);

    const { container } = render(
      <SessionTimeline {...baseTimelineProps} events={[]} isProcessing />
    );
    const timeline = container.firstElementChild as HTMLDivElement;
    expect(metrics.scrollTop).toBe(400);

    metrics.clientHeight = 300;
    act(() => notifyResize(timeline, 300));

    expect(metrics.scrollTop).toBe(700);
  });

  it("preserves user scroll position when the timeline viewport resizes", () => {
    const notifyResize = mockResizeObservers();
    const metrics = { clientHeight: 300, scrollHeight: 1_000, scrollTop: 700 };
    mockTimelineScrollMetrics(metrics);

    const { container } = render(
      <SessionTimeline {...baseTimelineProps} events={[]} isProcessing />
    );
    const timeline = container.firstElementChild as HTMLDivElement;

    metrics.scrollTop = 200;
    fireEvent.scroll(timeline);
    metrics.clientHeight = 200;
    act(() => notifyResize(timeline, 200));

    expect(metrics.scrollTop).toBe(200);
  });

  it("preserves the visible row position when history is prepended", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
      this: HTMLElement
    ) {
      if (!this.hasAttribute("data-index")) return 800;
      return Number(this.dataset.index) % 2 === 0 ? 80 : 160;
    });
    const messages = Array.from(
      { length: 200 },
      (_, index): SandboxEvent => ({
        type: "user_message",
        content: `Message ${index}`,
        messageId: `message-${index}`,
        timestamp: index + 10,
      })
    );
    const { container, rerender } = render(
      <SessionTimeline {...baseTimelineProps} events={messages} />
    );
    const timeline = container.firstElementChild as HTMLDivElement;
    Object.defineProperties(timeline, {
      clientHeight: { configurable: true, value: 800 },
      scrollHeight: { configurable: true, value: 500_000 },
      scrollTop: { configurable: true, value: 0, writable: true },
      scrollTo: {
        configurable: true,
        value: ({ top }: ScrollToOptions) => {
          if (typeof top === "number") timeline.scrollTop = top;
        },
      },
    });
    timeline.scrollTop = 20_000;
    fireEvent.scroll(timeline);
    const anchorContent = container.querySelector("[data-index] pre")?.textContent;
    const anchorBefore = [...container.querySelectorAll<HTMLElement>("[data-index]")].find((row) =>
      row.textContent?.includes(anchorContent ?? "")
    )!;
    const viewportOffsetBefore =
      Number.parseFloat(anchorBefore.style.transform.slice(11)) - timeline.scrollTop;

    rerender(
      <SessionTimeline
        {...baseTimelineProps}
        events={[
          ...Array.from(
            { length: 3 },
            (_, index): SandboxEvent => ({
              type: "user_message",
              content: `Older ${index}`,
              messageId: `older-${index}`,
              timestamp: index + 1,
            })
          ),
          ...messages,
        ]}
      />
    );
    const anchorAfter = [...container.querySelectorAll<HTMLElement>("[data-index]")].find((row) =>
      row.textContent?.includes(anchorContent ?? "")
    )!;
    const viewportOffsetAfter =
      Number.parseFloat(anchorAfter.style.transform.slice(11)) - timeline.scrollTop;

    expect(anchorContent).toBeTruthy();
    expect(viewportOffsetAfter).toBe(viewportOffsetBefore);
  });

  it("keeps observing the history sentinel after the skeleton clears", () => {
    const observedElements: Element[] = [];
    let notifyIntersection = (_isIntersecting: boolean) => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          notifyIntersection = (isIntersecting) => {
            callback(
              [{ isIntersecting } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver
            );
          };
        }
        observe(element: Element) {
          observedElements.push(element);
        }
        disconnect() {}
      }
    );
    const onLoadOlder = vi.fn();
    const { container, rerender } = render(
      <SessionTimeline {...baseTimelineProps} events={[]} showSkeleton onLoadOlder={onLoadOlder} />
    );
    const timeline = container.firstElementChild as HTMLDivElement;
    Object.defineProperties(timeline, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 800 },
    });
    const sentinel = observedElements[0];

    rerender(
      <SessionTimeline
        {...baseTimelineProps}
        events={[]}
        showSkeleton={false}
        onLoadOlder={onLoadOlder}
      />
    );
    fireEvent.scroll(timeline);
    notifyIntersection(true);

    expect(observedElements).toEqual([sentinel]);
    expect(sentinel.isConnected).toBe(true);
    expect(onLoadOlder).toHaveBeenCalledOnce();
  });

  it("does not scroll the timeline when the pending prompt stack changes", () => {
    const events: SandboxEvent[] = [];
    const { container, rerender } = render(
      <SessionTimeline {...baseTimelineProps} events={events} promptQueue={[]} />
    );
    const timeline = container.firstElementChild as HTMLDivElement;
    Object.defineProperties(timeline, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 600 },
      scrollTop: { configurable: true, value: 200, writable: true },
    });
    fireEvent.scroll(timeline);
    timeline.scrollTop = 0;

    rerender(
      <SessionTimeline
        {...baseTimelineProps}
        events={events}
        promptQueue={[{ messageId: "queued", content: "Next prompt", status: "pending" }]}
      />
    );

    expect(timeline.scrollTop).toBe(0);
  });

  it("follows appended activity when within the bottom threshold", () => {
    const notifyResize = mockResizeObservers();
    const flushAnimationFrames = mockAnimationFrames();
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
      scrollTop: { configurable: true, value: 701, writable: true },
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
    const row = timeline.querySelector<HTMLElement>("[data-index]")!;
    act(() => {
      notifyResize(row, 900);
      flushAnimationFrames();
    });

    expect(timeline.scrollTop).toBe(1_000);
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("does not move the timeline when the user has scrolled away from the bottom", () => {
    const notifyResize = mockResizeObservers();
    const flushAnimationFrames = mockAnimationFrames();
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
    const row = timeline.querySelector<HTMLElement>("[data-index]")!;
    act(() => {
      notifyResize(row, 900);
      flushAnimationFrames();
    });

    expect(timeline.scrollTop).toBe(300);
  });

  it("anchors absolutely-positioned descendants inside the timeline scroller", () => {
    // A thinking task renders a `position: absolute` sr-only live-status span.
    // The scroller must be its containing block (`relative`): otherwise the
    // span anchors to the document, escapes every ancestor overflow clip, and
    // stretches the page by the timeline's content height — scrolling the
    // whole layout while sub-tasks stream.
    const task = toolEvent("task", "task-call", 1, { status: "running" });
    const { container } = render(
      <SessionTimeline
        {...baseTimelineProps}
        events={[
          task,
          toolEvent("Read", "child-call", 2, { isSubtask: true, taskCallId: "task-call" }),
        ]}
      />
    );
    const timeline = container.firstElementChild as HTMLDivElement;
    expect(timeline).toHaveClass("relative");

    const statusSpan = container.querySelector('[role="status"]');
    expect(statusSpan).toBeInTheDocument();
    const containingBlock = statusSpan?.closest(".relative, .absolute, .fixed, .sticky") ?? null;
    expect(containingBlock).not.toBeNull();
    expect(timeline.contains(containingBlock)).toBe(true);
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

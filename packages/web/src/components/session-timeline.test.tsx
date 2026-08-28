// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { buildTimelineItems } from "@/lib/timeline-items";
import type { SandboxEvent } from "@/types/session";
import { EventItem, SessionTimeline } from "./session-timeline";

expect.extend(matchers);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (Element.prototype as { scrollIntoView?: () => void }).scrollIntoView;
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

function mockScrollIntoView() {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
}
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

function event(userId?: string): Extract<SandboxEvent, { type: "user_message" }> {
  return {
    type: "user_message",
    content: "hello",
    messageId: "message-1",
    timestamp: 1,
    author: {
      participantId: "participant-2",
      ...(userId ? { userId } : {}),
      name: "Historical Name",
      avatar: "https://historical.example/avatar",
    },
  };
}

function toolCall(callId: string, tool: string, filePath: string): SandboxEvent {
  return {
    type: "tool_call",
    sandboxId: "sandbox-1",
    messageId: `message-${callId}`,
    callId,
    tool,
    args: { filePath },
    timestamp: Number(callId.replace(/\D/g, "")) || 1,
  };
}

describe("user message authors", () => {
  it("presents Autofix provenance and links to the originating review", () => {
    render(
      <EventItem
        event={{
          ...event("user-2"),
          origin: {
            kind: "review",
            authorType: "bot",
            feedbackUrl: "https://github.com/acme/widgets/pull/42#pullrequestreview-5678",
          },
        }}
        sessionId="session-1"
        currentParticipantId="participant-1"
        participantProfiles={{}}
        onOpenMedia={() => {}}
      />
    );

    expect(screen.getByText("Resumed by PR feedback")).toBeInTheDocument();
    expect(screen.getByText("Review · Bot")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open feedback" })).toHaveAttribute(
      "href",
      "https://github.com/acme/widgets/pull/42#pullrequestreview-5678"
    );
  });

  it("uses the canonical profile name and avatar when available", () => {
    render(
      <EventItem
        event={event("user-2")}
        sessionId="session-1"
        currentParticipantId="participant-1"
        participantProfiles={{
          "user-2": {
            userId: "user-2",
            displayName: "Canonical Name",
            avatarUrl: "https://canonical.example/avatar",
          },
        }}
        onOpenMedia={() => {}}
      />
    );

    expect(screen.getByText("Canonical Name")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Canonical Name" })).toHaveAttribute(
      "src",
      "https://canonical.example/avatar"
    );
  });

  it("falls back safely for historical events without userId", () => {
    render(
      <EventItem
        event={event()}
        sessionId="session-1"
        currentParticipantId="participant-1"
        participantProfiles={{}}
        onOpenMedia={() => {}}
      />
    );

    expect(screen.getByText("Historical Name")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Historical Name" })).toHaveAttribute(
      "src",
      "https://historical.example/avatar"
    );
  });

  it("preserves event fallbacks when canonical profile fields are null", () => {
    render(
      <EventItem
        event={event("user-2")}
        sessionId="session-1"
        currentParticipantId="participant-1"
        participantProfiles={{
          "user-2": { userId: "user-2", displayName: null, avatarUrl: null },
        }}
        onOpenMedia={() => {}}
      />
    );

    expect(screen.getByText("Historical Name")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Historical Name" })).toHaveAttribute(
      "src",
      "https://historical.example/avatar"
    );
  });
});

describe("context compaction", () => {
  function compaction(timestamp: number): SandboxEvent {
    return {
      type: "context_compacted",
      messageId: "message-1",
      sandboxId: "sandbox-1",
      timestamp,
    };
  }

  it("renders a muted divider marker", () => {
    render(
      <EventItem
        event={compaction(1)}
        sessionId="session-1"
        currentParticipantId={null}
        participantProfiles={{}}
        onOpenMedia={() => {}}
      />
    );

    const marker = screen.getByText("Context compacted");
    expect(marker.closest(".text-muted-foreground")).not.toBeNull();
    expect(marker.parentElement?.querySelectorAll("[aria-hidden='true']")).toHaveLength(2);
  });

  it("keeps multiple markers and separates adjacent tool groups", () => {
    const items = buildTimelineItems([
      toolCall("call-1", "Read", "/workspace/one.ts"),
      compaction(2),
      toolCall("call-2", "Read", "/workspace/two.ts"),
      compaction(3),
    ]);

    expect(items.map((item) => item.type)).toEqual([
      "tool_group",
      "single",
      "tool_group",
      "single",
    ]);
  });

  it("keeps assistant segments on both sides of a marker", () => {
    const token = (content: string, timestamp: number): SandboxEvent => ({
      type: "token",
      content,
      messageId: "message-1",
      sandboxId: "sandbox-1",
      timestamp,
    });

    const items = buildTimelineItems([
      token("before compaction", 1),
      compaction(2),
      token("after compaction", 3),
    ]);

    expect(items).toMatchObject([
      { type: "single", event: { type: "token", content: "before compaction" } },
      { type: "single", event: { type: "context_compacted" } },
      { type: "single", event: { type: "token", content: "after compaction" } },
    ]);
  });
});

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

describe("prompt queue status", () => {
  it("hides pending messages and leaves the running message undecorated", () => {
    const events: SandboxEvent[] = [
      { ...event(), messageId: "running", content: "First" },
      { ...event(), messageId: "next", content: "Second", timestamp: 2 },
      { ...event(), messageId: "later", content: "Third", timestamp: 3 },
    ];
    render(
      <SessionTimeline
        {...baseTimelineProps}
        events={events}
        promptQueue={[
          { messageId: "running", content: "First", status: "processing" },
          { messageId: "next", content: "Second", status: "pending" },
          { messageId: "later", content: "Third", status: "pending" },
        ]}
      />
    );
    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.queryByText("Running")).not.toBeInTheDocument();
    expect(screen.queryByText("Second")).not.toBeInTheDocument();
    expect(screen.queryByText("Third")).not.toBeInTheDocument();
  });

  it("does not render pending queue entries that are outside timeline replay", () => {
    render(
      <SessionTimeline
        {...baseTimelineProps}
        events={[{ ...event(), messageId: "canonical", content: "Canonical prompt" }]}
        promptQueue={[
          {
            messageId: "canonical",
            content: "Canonical prompt",
            status: "processing",
          },
          {
            messageId: "outside-replay",
            content: "Queued outside replay",
            status: "pending",
          },
        ]}
      />
    );

    expect(screen.getAllByText("Canonical prompt")).toHaveLength(1);
    expect(screen.queryByText("Queued outside replay")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Prompt queue" })).not.toBeInTheDocument();
  });
});

describe("completed turn activity", () => {
  const completedTurnEvents: SandboxEvent[] = [
    { ...event(), content: "Update the dependency", timestamp: 100 },
    {
      type: "token",
      messageId: "message-1",
      content: "I will inspect the current dependency before updating it.",
      sandboxId: "sandbox-1",
      timestamp: 101,
    },
    {
      type: "context_compacted",
      messageId: "message-1",
      sandboxId: "sandbox-1",
      timestamp: 102,
    },
    {
      type: "tool_call",
      tool: "Read",
      args: { filePath: "/workspace/package.json" },
      callId: "call-1",
      messageId: "message-1",
      sandboxId: "sandbox-1",
      timestamp: 110,
    },
    {
      type: "token",
      messageId: "message-1",
      content: "The dependency is updated.",
      sandboxId: "sandbox-1",
      timestamp: 188,
    },
    {
      type: "execution_complete",
      messageId: "message-1",
      success: true,
      sandboxId: "sandbox-1",
      timestamp: 189,
    },
  ];

  it("collapses completed activity behind the worked duration", async () => {
    render(<SessionTimeline {...baseTimelineProps} events={completedTurnEvents} />);

    const disclosure = screen.getByRole("button", { name: "Worked for 1m 29s" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("The dependency is updated.")).toBeInTheDocument();
    expect(screen.getByText("Execution complete")).toBeInTheDocument();
    expect(
      screen.queryByText("I will inspect the current dependency before updating it.")
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Read package\.json/i })).not.toBeInTheDocument();

    await userEvent.click(disclosure);

    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText("I will inspect the current dependency before updating it.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Read package\.json/i })).toBeInTheDocument();
    expect(screen.getByText("Context compacted")).toBeInTheDocument();
  });

  it("leaves activity visible until the turn completes", () => {
    render(<SessionTimeline {...baseTimelineProps} events={completedTurnEvents.slice(0, -2)} />);

    expect(screen.queryByRole("button", { name: /Worked for/i })).not.toBeInTheDocument();
    expect(
      screen.getByText("I will inspect the current dependency before updating it.")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Read package\.json/i })).toBeInTheDocument();
  });

  it("shows a duration for completed turns without tool activity", () => {
    render(
      <SessionTimeline
        {...baseTimelineProps}
        events={[
          { ...event(), timestamp: 10 },
          {
            type: "token",
            messageId: "message-1",
            content: "Finished.",
            sandboxId: "sandbox-1",
            timestamp: 14,
          },
          {
            type: "execution_complete",
            messageId: "message-1",
            success: true,
            sandboxId: "sandbox-1",
            timestamp: 15,
          },
        ]}
      />
    );

    expect(screen.getByRole("button", { name: "Worked for 5s" })).toBeInTheDocument();
    expect(screen.getByText("Finished.")).toBeInTheDocument();
  });

  it("does not collapse across a queued prompt before the running turn completes", () => {
    render(
      <SessionTimeline
        {...baseTimelineProps}
        events={[
          { ...event(), messageId: "message-1", content: "First prompt", timestamp: 10 },
          {
            type: "token",
            messageId: "message-1",
            content: "Working on the first prompt.",
            sandboxId: "sandbox-1",
            timestamp: 11,
          },
          { ...event(), messageId: "message-2", content: "Second prompt", timestamp: 12 },
          {
            type: "execution_complete",
            messageId: "message-1",
            success: true,
            sandboxId: "sandbox-1",
            timestamp: 13,
          },
          {
            type: "token",
            messageId: "message-2",
            content: "Finished the second prompt.",
            sandboxId: "sandbox-1",
            timestamp: 14,
          },
          {
            type: "execution_complete",
            messageId: "message-2",
            success: true,
            sandboxId: "sandbox-1",
            timestamp: 15,
          },
        ]}
      />
    );

    expect(screen.getByText("First prompt")).toBeInTheDocument();
    expect(screen.getByText("Second prompt")).toBeInTheDocument();
    expect(screen.getByText("Working on the first prompt.")).toBeInTheDocument();
    expect(screen.getByText("Finished the second prompt.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Worked for/i })).not.toBeInTheDocument();
  });
});

describe("tool call groups", () => {
  it("preserves expanded group and row state when history is prepended", async () => {
    const readEvents = [
      toolCall("call-1", "Read", "/workspace/one.ts"),
      toolCall("call-2", "Read", "/workspace/two.ts"),
    ];
    const { rerender } = render(<SessionTimeline {...baseTimelineProps} events={readEvents} />);

    await userEvent.click(screen.getByRole("button", { name: /Read 2 files/i }));
    await userEvent.click(screen.getByRole("button", { name: /Read one\.ts/i }));
    expect(screen.getByText("Arguments:")).toBeInTheDocument();

    rerender(
      <SessionTimeline
        {...baseTimelineProps}
        events={[toolCall("call-0", "Bash", "older command"), ...readEvents]}
      />
    );

    expect(screen.getByRole("button", { name: /Read one\.ts/i })).toBeInTheDocument();
    expect(screen.getByText("Arguments:")).toBeInTheDocument();
  });
});

describe("terminal message visibility", () => {
  it("marks read only after the latest completion is visible in the active tab", async () => {
    mockScrollIntoView();
    const observations: Array<{
      callback: IntersectionObserverCallback;
      target?: Element;
    }> = [];
    class TestIntersectionObserver {
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds = [0];
      constructor(callback: IntersectionObserverCallback) {
        observations.push({ callback });
      }
      observe(target: Element) {
        observations.at(-1)!.target = target;
      }
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    }
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const onMarkMessageRead = vi.fn(async () => "complete" as const);
    const events: SandboxEvent[] = [
      {
        type: "execution_complete",
        messageId: "message-1",
        success: true,
        sandboxId: "sandbox-1",
        timestamp: 1,
      },
      {
        type: "execution_complete",
        messageId: "message-2",
        success: true,
        sandboxId: "sandbox-1",
        timestamp: 2,
      },
    ];

    render(
      <SessionTimeline
        events={events}
        sessionId="session-1"
        currentParticipantId={null}
        participantProfiles={{}}
        isProcessing={false}
        loadingHistory={false}
        showSkeleton={false}
        onLoadOlder={() => {}}
        onOpenMedia={() => {}}
        terminalMessageReadObservationEnabled
        onMarkMessageRead={onMarkMessageRead}
      />
    );

    const observation = observations.find(
      ({ target }) => target?.getAttribute("data-terminal-message-id") === "message-2"
    );
    expect(observation).toBeDefined();
    await act(async () => {
      observation!.callback(
        [{ isIntersecting: true, target: observation!.target } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    });
    expect(onMarkMessageRead).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(onMarkMessageRead).toHaveBeenCalledOnce();
    expect(onMarkMessageRead).toHaveBeenCalledWith("message-2");
  });

  it("retries an incomplete read attempt while the same outcome remains visible", async () => {
    vi.useFakeTimers();
    mockScrollIntoView();
    const observations: Array<{
      callback: IntersectionObserverCallback;
      target?: Element;
    }> = [];
    class TestIntersectionObserver {
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds = [0];
      constructor(nextCallback: IntersectionObserverCallback) {
        observations.push({ callback: nextCallback });
      }
      observe(target: Element) {
        observations.at(-1)!.target = target;
      }
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    }
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const onMarkMessageRead = vi
      .fn()
      .mockResolvedValueOnce("retry")
      .mockResolvedValueOnce("retry")
      .mockResolvedValueOnce("complete");

    const { container } = render(
      <SessionTimeline
        events={[
          {
            type: "execution_complete",
            messageId: "message-1",
            success: true,
            sandboxId: "sandbox-1",
            timestamp: 1,
          },
        ]}
        sessionId="session-1"
        currentParticipantId={null}
        participantProfiles={{}}
        isProcessing={false}
        loadingHistory={false}
        showSkeleton={false}
        onLoadOlder={() => {}}
        onOpenMedia={() => {}}
        terminalMessageReadObservationEnabled
        onMarkMessageRead={onMarkMessageRead}
      />
    );
    const target = container.querySelector('[data-terminal-message-id="message-1"]')!;
    const observation = observations.find(({ target: observed }) => observed === target);

    await act(async () => {
      observation?.callback(
        [{ isIntersecting: true, target } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    });
    expect(onMarkMessageRead).toHaveBeenCalledTimes(1);

    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(onMarkMessageRead).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(onMarkMessageRead).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(onMarkMessageRead).toHaveBeenCalledTimes(3);
  });

  it("observes the assistant output instead of the completion badge", () => {
    mockScrollIntoView();
    const observedTargets: Element[] = [];
    class TestIntersectionObserver {
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds = [0];
      constructor(_callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        observedTargets.push(target);
      }
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    }
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);

    render(
      <SessionTimeline
        events={[
          {
            type: "token",
            messageId: "message-1",
            content: "The complete agent result",
            sandboxId: "sandbox-1",
            timestamp: 1,
          },
          {
            type: "execution_complete",
            messageId: "message-1",
            success: true,
            sandboxId: "sandbox-1",
            timestamp: 2,
          },
        ]}
        sessionId="session-1"
        currentParticipantId={null}
        participantProfiles={{}}
        isProcessing={false}
        loadingHistory={false}
        showSkeleton={false}
        onLoadOlder={() => {}}
        onOpenMedia={() => {}}
        terminalMessageReadObservationEnabled
        onMarkMessageRead={async () => "complete"}
      />
    );

    const outcomeTarget = observedTargets.find(
      (target) => target.getAttribute("data-terminal-message-id") === "message-1"
    );
    expect(outcomeTarget).toHaveClass("space-y-2");
    expect(outcomeTarget).toHaveTextContent("The complete agent result");
    expect(outcomeTarget).toHaveTextContent("Execution complete");
  });

  it("does not retry after the visible outcome unmounts during a read attempt", async () => {
    vi.useFakeTimers();
    mockScrollIntoView();
    let resolveReadAttempt!: (value: "retry") => void;
    const readAttempt = new Promise<"retry">((resolve) => {
      resolveReadAttempt = resolve;
    });
    const observations: Array<{ callback: IntersectionObserverCallback; target?: Element }> = [];
    class TestIntersectionObserver {
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds = [0];
      constructor(callback: IntersectionObserverCallback) {
        observations.push({ callback });
      }
      observe(target: Element) {
        observations.at(-1)!.target = target;
      }
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    }
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const onMarkMessageRead = vi.fn(() => readAttempt);
    const { container, unmount } = render(
      <SessionTimeline
        events={[
          {
            type: "execution_complete",
            messageId: "message-1",
            success: true,
            sandboxId: "sandbox-1",
            timestamp: 1,
          },
        ]}
        sessionId="session-1"
        currentParticipantId={null}
        participantProfiles={{}}
        isProcessing={false}
        loadingHistory={false}
        showSkeleton={false}
        onLoadOlder={() => {}}
        onOpenMedia={() => {}}
        terminalMessageReadObservationEnabled
        onMarkMessageRead={onMarkMessageRead}
      />
    );
    const target = container.querySelector('[data-terminal-message-id="message-1"]')!;
    const observation = observations.find(({ target: observed }) => observed === target)!;
    await act(async () => {
      observation.callback(
        [{ isIntersecting: true, target } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    });
    expect(onMarkMessageRead).toHaveBeenCalledOnce();

    unmount();
    resolveReadAttempt("retry");
    await act(async () => {
      await readAttempt;
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(onMarkMessageRead).toHaveBeenCalledOnce();
  });
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

describe("task activity grouping", () => {
  it("pulses while a Task is running and stops after its completion update", () => {
    const runningTask = toolEvent("task", "task-call", 1, {
      args: { description: "Review code" },
      status: "running",
    });
    const { container, rerender } = render(
      <SessionTimeline {...baseTimelineProps} events={[runningTask]} />
    );

    const indicator = screen.getByRole("status");
    expect(indicator).toHaveClass("sr-only");
    expect(indicator).toHaveTextContent("Task in progress");
    expect(indicator.closest("button")).toBeNull();
    expect(container.querySelector("button [aria-hidden='true'].animate-pulse")).toHaveClass(
      "bg-accent"
    );

    rerender(
      <SessionTimeline
        {...baseTimelineProps}
        events={[
          runningTask,
          toolEvent("task", "task-call", 2, {
            args: { description: "Review code" },
            status: "completed",
          }),
        ]}
      />
    );

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(container.querySelector("button [aria-hidden='true'].animate-pulse")).toBeNull();
  });

  it("nests child tools beneath their Task and keeps parallel Tasks separate", () => {
    const groups = buildTimelineItems([
      toolEvent("task", "task-a", 1, { childSessionId: "child-a" }),
      toolEvent("task", "task-b", 2, { childSessionId: "child-b" }),
      toolEvent("Read", "call-b", 3, {
        isSubtask: true,
        childSessionId: "child-b",
        taskCallId: "task-b",
      }),
      toolEvent("Bash", "call-a", 4, {
        isSubtask: true,
        childSessionId: "child-a",
        taskCallId: "task-a",
      }),
    ]);

    expect(groups.filter((group) => group.type === "task_group")).toMatchObject([
      { event: { callId: "task-a" }, activity: [{ events: [{ callId: "call-a" }] }] },
      { event: { callId: "task-b" }, activity: [{ events: [{ callId: "call-b" }] }] },
    ]);
  });

  it("retains colliding parent and child call IDs", () => {
    const groups = buildTimelineItems([
      toolEvent("Bash", "shared-call", 1),
      toolEvent("task", "task-call", 2, { childSessionId: "child-1" }),
      toolEvent("Bash", "shared-call", 3, {
        isSubtask: true,
        childSessionId: "child-1",
        taskCallId: "task-call",
      }),
    ]);

    expect(groups).toMatchObject([
      { type: "tool_group", events: [{ callId: "shared-call" }] },
      {
        type: "task_group",
        activity: [{ type: "tool_group", events: [{ callId: "shared-call", isSubtask: true }] }],
      },
    ]);
  });

  it("groups adjacent tool names case-insensitively", () => {
    const groups = buildTimelineItems([
      toolEvent("Bash", "bash-1", 1),
      toolEvent("bash", "bash-2", 2),
    ]);

    expect(groups).toMatchObject([
      { type: "tool_group", events: [{ callId: "bash-1" }, { callId: "bash-2" }] },
    ]);
  });

  it("does not infer ownership from a reused child session ID", () => {
    const groups = buildTimelineItems([
      toolEvent("task", "task-a", 1, { childSessionId: "child-1" }),
      toolEvent("task", "task-b", 2, { childSessionId: "child-1" }),
      toolEvent("Bash", "child-call", 3, {
        isSubtask: true,
        childSessionId: "child-1",
      }),
    ]);

    expect(groups.filter((group) => group.type === "task_group")).toMatchObject([
      { event: { callId: "task-a" }, activity: [] },
      { event: { callId: "task-b" }, activity: [] },
    ]);
    expect(
      groups.flatMap((group) => (group.type === "tool_group" ? group.events : []))
    ).toContainEqual(expect.objectContaining({ callId: "child-call" }));
  });

  it("renders completed Tasks without child events using focused details", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <SessionTimeline
        events={[
          toolEvent("task", "task-call", 1, {
            args: {
              description: "Review code",
              prompt: "Inspect the implementation.",
            },
            output:
              '<task id="ses_complete" state="completed">\n<task_result>\nReview complete.\n</task_result>\n</task>',
          }),
        ]}
        sessionId="session-1"
        currentParticipantId={null}
        participantProfiles={{}}
        isProcessing={false}
        loadingHistory={false}
        showSkeleton={false}
        onLoadOlder={() => {}}
        onOpenMedia={() => {}}
      />
    );

    const task = screen.getByRole("button", { name: /Task Review code/ });
    expect(task).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Instructions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Result" })).not.toBeInTheDocument();

    await user.click(task);
    expect(task).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByText("Arguments:")).not.toBeInTheDocument();
    expect(screen.queryByText("Output:")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Instructions" })).toBeInTheDocument();
    const result = screen.getByRole("button", { name: "Result" });
    await user.click(result);
    expect(screen.getByText("Review complete.")).toBeInTheDocument();
    expect(screen.queryByText("Task activity")).not.toBeInTheDocument();
    expect(container.querySelector(".border-l-2")).not.toBeInTheDocument();
  });

  it("cleans failed Task envelopes without child events", async () => {
    const user = userEvent.setup();
    render(
      <SessionTimeline
        events={[
          toolEvent("task", "task-call", 1, {
            args: { description: "Investigate failure" },
            output:
              '<task id="ses_failed" state="failed">\n<task_error>\nAgent could not finish.\n</task_error>\n</task>',
          }),
        ]}
        sessionId="session-1"
        currentParticipantId={null}
        participantProfiles={{}}
        isProcessing={false}
        loadingHistory={false}
        showSkeleton={false}
        onLoadOlder={() => {}}
        onOpenMedia={() => {}}
      />
    );

    await user.click(screen.getByRole("button", { name: /Task Investigate failure/ }));
    expect(screen.queryByText("Output:")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Result" }));
    expect(screen.getByText("Agent could not finish.")).toBeInTheDocument();
    expect(screen.queryByText(/<task_error>/)).not.toBeInTheDocument();
    expect(screen.queryByText("Task activity")).not.toBeInTheDocument();
  });

  it("does not treat lifecycle-only child events as displayable activity", () => {
    const groups = buildTimelineItems([
      toolEvent("task", "task-call", 1),
      {
        type: "step_finish",
        messageId: "message-1",
        sandboxId: "sandbox-1",
        timestamp: 2,
        isSubtask: true,
        taskCallId: "task-call",
      },
    ]);

    expect(groups).toMatchObject([
      { type: "task_group", event: { callId: "task-call" }, activity: [] },
    ]);
  });

  it("renders focused Task details with independent stable disclosures", async () => {
    const user = userEvent.setup();
    const events = [
      toolEvent("task", "task-call", 1, {
        args: {
          description: "Review code",
          prompt: "Inspect the implementation.\nReport any regressions.",
          subagent_type: "explore",
          task_id: "ses_resumed",
          command: "duplicate context",
        },
        output:
          '<task id="ses_resumed" state="completed">\n<task_result>\nReview complete.\nNo regressions found.\n</task_result>\n</task>',
        childSessionId: "child-1",
      }),
      toolEvent("Bash", "child-call", 2, {
        args: { command: "npm test" },
        isSubtask: true,
        childSessionId: "child-1",
        taskCallId: "task-call",
      }),
    ];

    const view = render(
      <SessionTimeline
        events={events}
        sessionId="session-1"
        currentParticipantId={null}
        participantProfiles={{}}
        isProcessing={false}
        loadingHistory={false}
        showSkeleton={false}
        onLoadOlder={() => {}}
        onOpenMedia={() => {}}
      />
    );

    const task = screen.getByRole("button", { name: /Task Review code/ });
    expect(task).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Task activity")).not.toBeInTheDocument();
    expect(screen.queryByText("Agent: explore")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Instructions" })).not.toBeInTheDocument();

    await user.click(task);
    expect(task).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Task activity")).toBeInTheDocument();
    expect(screen.getByText("Agent: explore")).toBeInTheDocument();
    expect(screen.getByText("Task ID: ses_resumed")).toBeInTheDocument();
    expect(screen.queryByText("Arguments:")).not.toBeInTheDocument();
    expect(screen.queryByText("Output:")).not.toBeInTheDocument();
    expect(screen.queryByText("duplicate context")).not.toBeInTheDocument();
    expect(screen.queryByText(/subagent_type/)).not.toBeInTheDocument();

    const instructions = screen.getByRole("button", { name: "Instructions" });
    const result = screen.getByRole("button", { name: "Result" });
    expect(instructions).toHaveAttribute("aria-expanded", "false");
    expect(result).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByText("Inspect the implementation.", { exact: false })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Review complete.", { exact: false })).not.toBeInTheDocument();

    await user.click(instructions);
    expect(instructions).toHaveAttribute("aria-expanded", "true");
    expect(result).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Inspect the implementation.", { exact: false })).toBeInTheDocument();

    await user.click(result);
    expect(result).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Review complete.", { exact: false })).toHaveTextContent(
      "Review complete. No regressions found."
    );
    expect(screen.queryByText(/<task(?:_|\s|>)/)).not.toBeInTheDocument();

    view.rerender(
      <SessionTimeline
        events={[event(), ...events]}
        sessionId="session-1"
        currentParticipantId={null}
        participantProfiles={{}}
        isProcessing={false}
        loadingHistory={false}
        showSkeleton={false}
        onLoadOlder={() => {}}
        onOpenMedia={() => {}}
      />
    );
    expect(screen.getByRole("button", { name: "Instructions" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    expect(screen.getByRole("button", { name: "Result" })).toHaveAttribute("aria-expanded", "true");

    expect(screen.getByRole("button", { name: /Task Review code/ })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    await user.click(screen.getByRole("button", { name: /Task Review code/ }));
    expect(screen.queryByText("Task activity")).not.toBeInTheDocument();
  });

  it("omits empty Task details and preserves ordinary result output", async () => {
    const user = userEvent.setup();
    render(
      <SessionTimeline
        events={[
          toolEvent("task", "task-call", 1, {
            args: { description: "Review code", prompt: "   " },
            output: "  Ordinary <task_result> text is unchanged\n\n",
          }),
          toolEvent("Bash", "child-call", 2, {
            isSubtask: true,
            childSessionId: "child-1",
            taskCallId: "task-call",
          }),
          toolEvent("task", "error-task-call", 3, {
            args: { description: "Investigate failure" },
            output:
              '<task id="ses_failed" state="failed">\n<task_error>\nAgent could not finish.\n</task_error>\n</task>',
          }),
          toolEvent("Bash", "error-child-call", 4, {
            isSubtask: true,
            childSessionId: "child-2",
            taskCallId: "error-task-call",
          }),
        ]}
        sessionId="session-1"
        currentParticipantId={null}
        participantProfiles={{}}
        isProcessing={false}
        loadingHistory={false}
        showSkeleton={false}
        onLoadOlder={() => {}}
        onOpenMedia={() => {}}
      />
    );

    const tasks = screen.getAllByRole("button", { name: /Task (Review code|Investigate failure)/ });
    expect(tasks).toHaveLength(2);
    await user.click(tasks[0]);
    await user.click(tasks[1]);

    expect(screen.queryByRole("button", { name: "Instructions" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Agent:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Task ID:/)).not.toBeInTheDocument();
    const results = screen.getAllByRole("button", { name: "Result" });
    await user.click(results[0]);
    await user.click(results[1]);
    expect(screen.getByText("Ordinary <task_result> text is unchanged")).toBeInTheDocument();
    expect(results[0].parentElement?.querySelector("pre")?.textContent).toBe(
      "  Ordinary <task_result> text is unchanged\n\n"
    );
    expect(screen.getByText("Agent could not finish.")).toBeInTheDocument();
    expect(screen.queryByText(/<task_error>/)).not.toBeInTheDocument();
  });

  it("preserves tool-group disclosure across append and history prepend", async () => {
    const user = userEvent.setup();
    const initial = [
      toolEvent("Bash", "bash-1", 2, { args: { command: "first" } }),
      toolEvent("Bash", "bash-2", 3, { args: { command: "second" } }),
    ];
    const props = {
      sessionId: "session-1",
      currentParticipantId: null,
      participantProfiles: {},
      isProcessing: false,
      loadingHistory: false,
      showSkeleton: false,
      onLoadOlder: () => {},
      onOpenMedia: () => {},
    };
    const view = render(<SessionTimeline {...props} events={initial} />);

    await user.click(screen.getByRole("button", { name: /Bash 2 commands/ }));
    expect(screen.getByText(/Bash first/)).toBeInTheDocument();
    view.rerender(
      <SessionTimeline
        {...props}
        events={[
          toolEvent("Bash", "bash-0", 1, { args: { command: "zeroth" } }),
          ...initial,
          toolEvent("Bash", "bash-3", 4, { args: { command: "third" } }),
        ]}
      />
    );

    expect(screen.getByText(/Bash zeroth/)).toBeInTheDocument();
    expect(screen.getByText(/Bash third/)).toBeInTheDocument();
  });

  it("keeps rows distinct when the same callId repeats across messages", async () => {
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <SessionTimeline
        sessionId="session-1"
        currentParticipantId={null}
        participantProfiles={{}}
        isProcessing={false}
        loadingHistory={false}
        showSkeleton={false}
        onLoadOlder={() => {}}
        onOpenMedia={() => {}}
        events={[
          toolEvent("Bash", "call-1", 1, {
            messageId: "message-1",
            args: { command: "first" },
          }),
          toolEvent("Bash", "call-1", 2, {
            messageId: "message-2",
            args: { command: "second" },
          }),
        ]}
      />
    );

    await user.click(screen.getByRole("button", { name: /Bash 2 commands/ }));
    expect(screen.getByText(/Bash first/)).toBeInTheDocument();
    expect(screen.getByText(/Bash second/)).toBeInTheDocument();
    expect(consoleError.mock.calls.some((call) => String(call[0]).includes("same key"))).toBe(
      false
    );
    consoleError.mockRestore();
  });
});

describe("timeline virtualization", () => {
  it("mounts only a bounded window for large histories", () => {
    const events: SandboxEvent[] = Array.from({ length: 500 }, (_, index) => ({
      type: "user_message",
      content: `Message ${index}`,
      messageId: `message-${index}`,
      timestamp: index + 1,
    }));

    const { container } = render(<SessionTimeline {...baseTimelineProps} events={events} />);

    expect(container.querySelectorAll("[data-index]").length).toBeLessThanOrEqual(20);
    expect(container).not.toHaveTextContent("Message 250");
  });

  it("preserves task expansion after its row leaves the virtual window", async () => {
    const task: SandboxEvent = {
      type: "tool_call",
      sandboxId: "sandbox-1",
      messageId: "task-message",
      callId: "task-call",
      tool: "Task",
      args: { description: "Inspect the timeline" },
      timestamp: 1,
    };
    const events: SandboxEvent[] = [
      task,
      ...Array.from(
        { length: 500 },
        (_, index): SandboxEvent => ({
          type: "user_message",
          content: `Message ${index}`,
          messageId: `message-${index}`,
          timestamp: index + 2,
        })
      ),
    ];
    const { container } = render(<SessionTimeline {...baseTimelineProps} events={events} />);
    const taskButton = screen.getByRole("button", { name: /Task Inspect the timeline/ });
    await userEvent.click(taskButton);
    expect(taskButton).toHaveAttribute("aria-expanded", "true");

    const timeline = container.firstElementChild as HTMLDivElement;
    Object.defineProperties(timeline, {
      clientHeight: { configurable: true, value: 800 },
      scrollHeight: { configurable: true, value: 500_000 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });
    await act(async () => {
      timeline.scrollTop = 400_000;
      fireEvent.scroll(timeline);
    });
    expect(screen.queryByRole("button", { name: /Task Inspect the timeline/ })).toBeNull();

    await act(async () => {
      timeline.scrollTop = 0;
      fireEvent.scroll(timeline);
    });
    expect(screen.getByRole("button", { name: /Task Inspect the timeline/ })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  });

  it("reattaches terminal read observation when its row re-enters the virtual window", async () => {
    const observedTerminalTargets: Element[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe(target: Element) {
          if (target.hasAttribute("data-terminal-message-id")) {
            observedTerminalTargets.push(target);
          }
        }
        disconnect() {}
      }
    );
    const events: SandboxEvent[] = [
      {
        type: "execution_complete",
        sandboxId: "sandbox-1",
        messageId: "terminal-message",
        success: true,
        timestamp: 1,
      },
      ...Array.from(
        { length: 500 },
        (_, index): SandboxEvent => ({
          type: "user_message",
          content: `Message ${index}`,
          messageId: `message-${index}`,
          timestamp: index + 2,
        })
      ),
    ];
    const { container } = render(
      <SessionTimeline
        {...baseTimelineProps}
        events={events}
        terminalMessageReadObservationEnabled
        onMarkMessageRead={async () => "complete"}
      />
    );
    const firstTarget = container.querySelector('[data-terminal-message-id="terminal-message"]');
    const timeline = container.firstElementChild as HTMLDivElement;
    Object.defineProperties(timeline, {
      clientHeight: { configurable: true, value: 800 },
      scrollHeight: { configurable: true, value: 500_000 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });

    await act(async () => {
      timeline.scrollTop = 400_000;
      fireEvent.scroll(timeline);
    });
    expect(container.querySelector('[data-terminal-message-id="terminal-message"]')).toBeNull();

    await act(async () => {
      timeline.scrollTop = 0;
      fireEvent.scroll(timeline);
    });
    const remountedTarget = container.querySelector(
      '[data-terminal-message-id="terminal-message"]'
    );
    expect(remountedTarget).not.toBe(firstTarget);
    expect(observedTerminalTargets).toEqual([firstTarget, remountedTarget]);
  });
});

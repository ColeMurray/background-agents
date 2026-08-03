// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { SandboxEvent } from "@/types/session";
import { ToolCallGroup } from "./tool-call-group";
import { dedupeAndGroupEvents, EventItem, SessionTimeline } from "./session-timeline";

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

function event(userId?: string): SandboxEvent {
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

function ToolGroups({ events }: { events: SandboxEvent[] }) {
  return dedupeAndGroupEvents(events).map((group) =>
    group.type === "tool_group" ? (
      <ToolCallGroup key={group.id} events={group.events} groupId={group.id} />
    ) : null
  );
}

describe("user message authors", () => {
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

describe("tool call groups", () => {
  it("preserves expanded group and row state when history is prepended", async () => {
    const readEvents = [
      toolCall("call-1", "Read", "/workspace/one.ts"),
      toolCall("call-2", "Read", "/workspace/two.ts"),
    ];
    const { rerender } = render(<ToolGroups events={readEvents} />);

    await userEvent.click(screen.getByRole("button", { name: /Read2 files/i }));
    await userEvent.click(screen.getByRole("button", { name: /Read one\.ts/i }));
    expect(screen.getByText("Arguments:")).toBeInTheDocument();

    rerender(<ToolGroups events={[toolCall("call-0", "Bash", "older command"), ...readEvents]} />);

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

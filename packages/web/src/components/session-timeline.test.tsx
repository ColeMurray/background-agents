// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
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

// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionReadObserver } from "./session-read-observer";

const FIRST_RETRY_DELAY_MS = 2_000;
const SECOND_RETRY_DELAY_MS = 4_000;
const THIRD_RETRY_DELAY_MS = 8_000;
const NO_FURTHER_RETRY_WINDOW_MS = 60_000;

beforeEach(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SessionReadObserver", () => {
  it("acknowledges snapshot messages without waiting for transport readiness", async () => {
    const onMarkMessageRead = vi.fn(async () => "complete" as const);
    const { rerender } = render(
      <SessionReadObserver messageId={null} onMarkMessageRead={onMarkMessageRead} />
    );
    await act(async () => {});
    expect(onMarkMessageRead).not.toHaveBeenCalled();

    rerender(
      <SessionReadObserver messageId="snapshot-message" onMarkMessageRead={onMarkMessageRead} />
    );
    await act(async () => {});

    expect(onMarkMessageRead).toHaveBeenCalledWith("snapshot-message");
  });

  it("immediately marks an active visible focused message read", async () => {
    const onMarkMessageRead = vi.fn(async () => "complete" as const);

    render(<SessionReadObserver messageId="message-1" onMarkMessageRead={onMarkMessageRead} />);
    await act(async () => {});

    expect(onMarkMessageRead).toHaveBeenCalledOnce();
    expect(onMarkMessageRead).toHaveBeenCalledWith("message-1");
  });

  it("waits for a hidden document to become visible", async () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const onMarkMessageRead = vi.fn(async () => "complete" as const);

    render(<SessionReadObserver messageId="message-1" onMarkMessageRead={onMarkMessageRead} />);
    await act(async () => {});
    expect(onMarkMessageRead).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));

    expect(onMarkMessageRead).toHaveBeenCalledOnce();
    expect(onMarkMessageRead).toHaveBeenCalledWith("message-1");
  });

  it("acknowledges the exact new message ID when it changes", async () => {
    const onMarkMessageRead = vi.fn(async () => "complete" as const);
    const { rerender } = render(
      <SessionReadObserver messageId="message-1" onMarkMessageRead={onMarkMessageRead} />
    );
    await act(async () => {});

    rerender(<SessionReadObserver messageId="message-2" onMarkMessageRead={onMarkMessageRead} />);
    await act(async () => {});

    expect(onMarkMessageRead.mock.calls).toEqual([["message-1"], ["message-2"]]);
  });

  it("bounds retries to four attempts", async () => {
    vi.useFakeTimers();
    const onMarkMessageRead = vi.fn(async () => "retry" as const);

    render(<SessionReadObserver messageId="message-1" onMarkMessageRead={onMarkMessageRead} />);
    await act(async () => {});

    await act(async () =>
      vi.advanceTimersByTimeAsync(
        FIRST_RETRY_DELAY_MS +
          SECOND_RETRY_DELAY_MS +
          THIRD_RETRY_DELAY_MS +
          NO_FURTHER_RETRY_WINDOW_MS
      )
    );

    expect(onMarkMessageRead).toHaveBeenCalledTimes(4);
  });

  it("cancels a pending retry when unmounted", async () => {
    vi.useFakeTimers();
    const onMarkMessageRead = vi.fn(async () => "retry" as const);
    const { unmount } = render(
      <SessionReadObserver messageId="message-1" onMarkMessageRead={onMarkMessageRead} />
    );
    await act(async () => {});
    expect(onMarkMessageRead).toHaveBeenCalledOnce();

    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(NO_FURTHER_RETRY_WINDOW_MS));

    expect(onMarkMessageRead).toHaveBeenCalledOnce();
  });
});

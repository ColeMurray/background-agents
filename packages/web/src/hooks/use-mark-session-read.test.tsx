// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionReadResult } from "@open-inspect/shared/types/sessions";
import { useMarkSessionRead } from "./use-mark-session-read";
import { SessionReadRequestError } from "@/lib/session-read-state";

const markMessageRead =
  vi.fn<(sessionId: string, messageId: string) => Promise<SessionReadResult>>();
const reconcileSessionReadState = vi.fn(async (_result: SessionReadResult) => {});

vi.mock("@/lib/session-read-state", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  markMessageRead: (sessionId: string, messageId: string) => markMessageRead(sessionId, messageId),
  reconcileSessionReadState: (result: SessionReadResult) => reconcileSessionReadState(result),
}));

function result(
  outcome: "marked_read" | "already_read" | "not_latest",
  unread = false
): SessionReadResult {
  return { sessionId: "session-1", outcome, unread, latestMessageId: "message-1", version: 1 };
}
const missingProjection: SessionReadResult = {
  sessionId: "session-1",
  outcome: "no_terminal_message",
  unread: false,
  latestMessageId: null,
  version: 0,
};

function setVisibility(value: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
}

beforeEach(() => {
  setVisibility("visible");
  markMessageRead.mockReset();
  reconcileSessionReadState.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useMarkSessionRead", () => {
  it("acknowledges the latest terminal message on open without requiring focus", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    markMessageRead.mockResolvedValue(result("marked_read"));

    await act(async () => {
      renderHook(() => useMarkSessionRead("session-1", "message-1"));
    });

    expect(markMessageRead).toHaveBeenCalledExactlyOnceWith("session-1", "message-1");
    expect(reconcileSessionReadState).toHaveBeenCalledExactlyOnceWith(result("marked_read"));
  });

  it("acknowledges each message once and follows the message ID", async () => {
    markMessageRead.mockResolvedValue(result("already_read"));
    const { rerender } = await act(async () =>
      renderHook(({ messageId }) => useMarkSessionRead("session-1", messageId), {
        initialProps: { messageId: "message-1" as string | null },
      })
    );
    await act(async () => rerender({ messageId: "message-1" }));
    expect(markMessageRead).toHaveBeenCalledTimes(1);

    await act(async () => rerender({ messageId: "message-2" }));
    expect(markMessageRead).toHaveBeenCalledTimes(2);
    expect(markMessageRead).toHaveBeenLastCalledWith("session-1", "message-2");
  });

  it("does nothing until the session has a terminal message", async () => {
    await act(async () => {
      renderHook(() => useMarkSessionRead("session-1", null));
    });
    expect(markMessageRead).not.toHaveBeenCalled();
  });

  it("waits for a hidden tab to become visible", async () => {
    setVisibility("hidden");
    markMessageRead.mockResolvedValue(result("marked_read"));

    await act(async () => {
      renderHook(() => useMarkSessionRead("session-1", "message-1"));
    });
    expect(markMessageRead).not.toHaveBeenCalled();

    setVisibility("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(markMessageRead).toHaveBeenCalledTimes(1);

    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(markMessageRead).toHaveBeenCalledTimes(1);
  });

  it("retries a missing projection with backoff and then gives up", async () => {
    vi.useFakeTimers();
    markMessageRead.mockResolvedValue(missingProjection);

    await act(async () => {
      renderHook(() => useMarkSessionRead("session-1", "message-1"));
    });
    expect(markMessageRead).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(markMessageRead).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(markMessageRead).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(8_000));
    expect(markMessageRead).toHaveBeenCalledTimes(4);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(markMessageRead).toHaveBeenCalledTimes(4);
  });

  it("replaces a pending backoff when the tab is shown again", async () => {
    vi.useFakeTimers();
    markMessageRead.mockResolvedValue(missingProjection);

    await act(async () => {
      renderHook(() => useMarkSessionRead("session-1", "message-1"));
    });
    expect(markMessageRead).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    setVisibility("hidden");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    setVisibility("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(markMessageRead).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(markMessageRead).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(markMessageRead).toHaveBeenCalledTimes(3);
  });

  it("retries transport failures but stops on a rejected request", async () => {
    vi.useFakeTimers();
    markMessageRead
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new SessionReadRequestError(403));

    await act(async () => {
      renderHook(() => useMarkSessionRead("session-1", "message-1"));
    });
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(markMessageRead).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(markMessageRead).toHaveBeenCalledTimes(2);
  });

  it("does not acknowledge a stale message as its own", async () => {
    vi.useFakeTimers();
    markMessageRead.mockResolvedValue(result("not_latest", true));

    await act(async () => {
      renderHook(() => useMarkSessionRead("session-1", "message-1"));
    });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(markMessageRead).toHaveBeenCalledTimes(1);
  });

  it("stops retrying after unmount", async () => {
    vi.useFakeTimers();
    markMessageRead.mockResolvedValue(missingProjection);

    const { unmount } = await act(async () =>
      renderHook(() => useMarkSessionRead("session-1", "message-1"))
    );
    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(markMessageRead).toHaveBeenCalledTimes(1);
  });
});

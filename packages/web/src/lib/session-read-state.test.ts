import { mutate } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifySessionReadAttempt,
  reconcileSessionReadState,
  subscribeSessionReadStateReconciliation,
} from "./session-read-state";

vi.mock("swr", () => ({ mutate: vi.fn(() => Promise.resolve()) }));

beforeEach(() => {
  vi.mocked(mutate).mockClear();
});

describe("classifySessionReadAttempt", () => {
  it.each(["marked_read", "already_read"] as const)("completes after a %s result", (outcome) => {
    expect(
      classifySessionReadAttempt({
        sessionId: "session-1",
        outcome,
        unread: false,
        latestMessageId: "message-1",
      })
    ).toBe("complete");
  });

  it.each(["not_latest", "no_terminal_message"] as const)(
    "retries after a %s result because projection may still be pending",
    (outcome) => {
      const result =
        outcome === "no_terminal_message"
          ? ({
              sessionId: "session-1",
              outcome,
              unread: false,
              latestMessageId: null,
            } as const)
          : ({
              sessionId: "session-1",
              outcome,
              unread: true,
              latestMessageId: "message-previous",
            } as const);
      expect(classifySessionReadAttempt(result)).toBe("retry");
    }
  );
});

describe("reconcileSessionReadState", () => {
  it("updates session-list caches", async () => {
    await reconcileSessionReadState({
      sessionId: "session-1",
      outcome: "marked_read",
      unread: false,
      latestMessageId: "message-1",
    });

    expect(mutate).toHaveBeenCalledOnce();
    expect(vi.mocked(mutate).mock.calls[0]?.[2]).toEqual({
      populateCache: true,
      revalidate: false,
    });
  });

  it("tells reconcilers what the server decided", async () => {
    const reconcile = vi.fn();
    const unsubscribe = subscribeSessionReadStateReconciliation(reconcile);

    await reconcileSessionReadState({
      sessionId: "session-1",
      outcome: "already_read",
      unread: false,
      latestMessageId: "message-1",
    });
    unsubscribe();

    expect(reconcile).toHaveBeenCalledWith({
      sessionId: "session-1",
      outcome: "already_read",
      readState: { unread: false, latestMessageId: "message-1" },
    });
  });

  it("waits for registered cache reconcilers", async () => {
    let finishReconciliation!: () => void;
    const pendingReconciliation = new Promise<void>((resolve) => {
      finishReconciliation = resolve;
    });
    const reconcile = vi.fn(() => pendingReconciliation);
    const unsubscribe = subscribeSessionReadStateReconciliation(reconcile);

    const result = reconcileSessionReadState({
      sessionId: "session-1",
      outcome: "marked_read",
      unread: false,
      latestMessageId: "message-1",
    });
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishReconciliation();
    await result;
    unsubscribe();
  });
});

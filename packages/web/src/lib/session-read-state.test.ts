import { describe, expect, it, vi } from "vitest";
import type { SandboxEvent } from "@/types/session";
import {
  applySessionReadStateToItem,
  classifySessionReadAttempt,
  findLatestTerminalMessageId,
  readStateSupersedes,
  reconcileSessionReadState,
  subscribeSessionReadStateReconciliation,
} from "./session-read-state";

describe("findLatestTerminalMessageId", () => {
  it("returns the last completed message", () => {
    const events: SandboxEvent[] = [
      {
        type: "execution_complete",
        messageId: "message-1",
        success: true,
        sandboxId: "s",
        timestamp: 1,
      },
      { type: "token", messageId: "message-2", content: "working", sandboxId: "s", timestamp: 2 },
      {
        type: "execution_complete",
        messageId: "message-2",
        success: false,
        sandboxId: "s",
        timestamp: 3,
      },
    ];
    expect(findLatestTerminalMessageId(events)).toBe("message-2");
    expect(findLatestTerminalMessageId([])).toBeNull();
  });
});

describe("classifySessionReadAttempt", () => {
  it.each(["marked_read", "already_read", "not_latest"] as const)(
    "completes after a %s result",
    (outcome) => {
      expect(
        classifySessionReadAttempt({
          sessionId: "session-1",
          outcome,
          unread: false,
          latestMessageId: "message-1",
          version: 1,
        })
      ).toBe("complete");
    }
  );

  it("retries while the terminal message projection is missing", () => {
    expect(
      classifySessionReadAttempt({
        sessionId: "session-1",
        outcome: "no_terminal_message",
        unread: false,
        latestMessageId: null,
        version: 0,
      })
    ).toBe("retry");
  });
});

describe("readStateSupersedes", () => {
  it("orders by version and keeps read final within a version", () => {
    const olderUnread = { latestMessageId: "message-1", unread: true, version: 1 } as const;
    const olderRead = { latestMessageId: "message-1", unread: false, version: 1 } as const;
    const newerUnread = { latestMessageId: "message-2", unread: true, version: 2 } as const;

    expect(readStateSupersedes(newerUnread, olderRead)).toBe(true);
    expect(readStateSupersedes(olderRead, newerUnread)).toBe(false);
    expect(readStateSupersedes(olderRead, olderUnread)).toBe(true);
    expect(readStateSupersedes(olderUnread, olderRead)).toBe(false);
    expect(readStateSupersedes(olderRead, olderRead)).toBe(true);
  });

  it("orders messages that share a version by ID, as the projection does", () => {
    const firstRead = { latestMessageId: "message-a", unread: false, version: 5 } as const;
    const secondUnread = { latestMessageId: "message-b", unread: true, version: 5 } as const;

    expect(readStateSupersedes(secondUnread, firstRead)).toBe(true);
    expect(readStateSupersedes(firstRead, secondUnread)).toBe(false);
  });
});

describe("applySessionReadStateToItem", () => {
  const cached = {
    id: "session-1",
    readState: { latestMessageId: "message-2", unread: true, version: 2 } as const,
  };

  it("does not let a same-version older message hide a newer unread one", () => {
    const newerUnread = {
      id: "session-1",
      readState: { latestMessageId: "message-b", unread: true, version: 5 } as const,
    };
    expect(
      applySessionReadStateToItem(newerUnread, "session-1", {
        latestMessageId: "message-a",
        unread: false,
        version: 5,
      })
    ).toBe(newerUnread);
  });

  it("does not let an older result overwrite a newer terminal message", () => {
    expect(
      applySessionReadStateToItem(cached, "session-1", {
        latestMessageId: "message-1",
        unread: false,
        version: 1,
      })
    ).toBe(cached);
  });

  it("applies a read result for the cached version", () => {
    expect(
      applySessionReadStateToItem(cached, "session-1", {
        latestMessageId: "message-2",
        unread: false,
        version: 2,
      }).readState
    ).toEqual({ latestMessageId: "message-2", unread: false, version: 2 });
  });

  it("accepts the first terminal message when the cache had none", () => {
    const empty = {
      id: "session-1",
      readState: { latestMessageId: null, unread: false, version: 0 } as const,
    };
    expect(
      applySessionReadStateToItem(empty, "session-1", {
        latestMessageId: "message-1",
        unread: true,
        version: 1,
      }).readState
    ).toEqual({ latestMessageId: "message-1", unread: true, version: 1 });
  });

  it("does not restore unread state for the same terminal message", () => {
    const read = {
      id: "session-1",
      readState: { latestMessageId: "message-1", unread: false, version: 1 } as const,
    };
    expect(
      applySessionReadStateToItem(read, "session-1", {
        latestMessageId: "message-1",
        unread: true,
        version: 1,
      })
    ).toBe(read);
  });

  it("leaves other sessions and missing results alone", () => {
    expect(
      applySessionReadStateToItem(cached, "session-2", {
        latestMessageId: "message-9",
        unread: false,
        version: 9,
      })
    ).toBe(cached);
    expect(applySessionReadStateToItem(cached, "session-1", undefined)).toBe(cached);
  });
});

describe("reconcileSessionReadState", () => {
  it("tells reconcilers what the server decided", async () => {
    const reconcile = vi.fn();
    const unsubscribe = subscribeSessionReadStateReconciliation(reconcile);

    await reconcileSessionReadState({
      sessionId: "session-1",
      outcome: "already_read",
      unread: false,
      latestMessageId: "message-1",
      version: 1,
    });
    unsubscribe();

    expect(reconcile).toHaveBeenCalledWith({
      sessionId: "session-1",
      outcome: "already_read",
      readState: { unread: false, latestMessageId: "message-1", version: 1 },
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
      version: 1,
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

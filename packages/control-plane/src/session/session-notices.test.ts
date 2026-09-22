import { describe, expect, it, vi } from "vitest";
import type { EventRepository } from "./event-repository";
import type { SessionMessenger } from "./messenger";
import { createSessionNoticeRecorder } from "./session-notices";

describe("createSessionNoticeRecorder", () => {
  function fixture() {
    const created: Array<Parameters<EventRepository["createEvent"]>[0]> = [];
    const broadcast = vi.fn();
    const recorder = createSessionNoticeRecorder(
      { createEvent: (data) => void created.push(data) } as EventRepository,
      { broadcast } as unknown as SessionMessenger,
      () => "event-1",
      () => 1_700_000_000_000
    );
    return { recorder, created, broadcast };
  }

  // A broadcast alone reaches only the sockets open at that instant, and the
  // first-party client makes no view-state change for a `sandbox_warning`.
  it("persists the notice as a timeline warning", () => {
    const f = fixture();

    f.recorder.recordWarning("state was discarded");

    expect(f.created).toEqual([
      {
        id: "event-1",
        type: "warning",
        data: JSON.stringify({
          type: "warning",
          scope: "provider",
          message: "state was discarded",
          timestamp: 1_700_000_000,
        }),
        messageId: null,
        createdAt: 1_700_000_000_000,
      },
    ]);
  });

  it("announces it in the live-ingest shape so an attached client needs no refetch", () => {
    const f = fixture();

    f.recorder.recordWarning("state was discarded");

    expect(f.broadcast).toHaveBeenCalledWith({
      type: "sandbox_event",
      event: {
        type: "warning",
        scope: "provider",
        message: "state was discarded",
        timestamp: 1_700_000_000,
      },
    });
  });
});

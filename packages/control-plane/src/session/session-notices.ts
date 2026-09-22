import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { SessionNoticeRecorder } from "../sandbox/lifecycle/manager";
import type { EventRepository } from "./event-repository";
import type { SessionMessenger } from "./messenger";

/**
 * Record a lifecycle notice where a client can still find it afterwards.
 *
 * `broadcast` alone reaches only the sockets open at that instant — and the
 * first-party client makes no view-state change for a `sandbox_warning` — so a
 * notice about something irreversible has to land on the timeline. This writes
 * the same `warning` event the budget service persists, which the timeline and
 * the session sidebar already render, and announces it in the same shape live
 * ingest uses so an attached client sees it without a refetch.
 *
 * `scope: "provider"` rather than a new scope value: the enum is parsed by
 * clients, and a value they predate is dropped from the timeline entirely.
 */
export function createSessionNoticeRecorder(
  events: EventRepository,
  messenger: SessionMessenger,
  generateId: () => string,
  now: () => number = Date.now
): SessionNoticeRecorder {
  return {
    recordWarning(message: string): void {
      const at = now();
      const event: Extract<SandboxEvent, { type: "warning" }> = {
        type: "warning",
        scope: "provider",
        message,
        timestamp: at / 1000,
      };
      events.createEvent({
        id: generateId(),
        type: "warning",
        data: JSON.stringify(event),
        messageId: null,
        createdAt: at,
      });
      messenger.broadcast({ type: "sandbox_event", event });
    },
  };
}
